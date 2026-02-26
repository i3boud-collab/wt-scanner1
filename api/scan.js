// api/scan.js — Multi-timeframe scanner (15m, 1h, 4h)
const { calcWT, calcRSI, volAvg } = require("./indicators");
const { SYMBOLS, CONFIG }         = require("./config");

// ── KV helper ──────────────────────────────────────────────────
async function kvSet(key, value) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([["SET", key, JSON.stringify(value)]]),
  });
  return true;
}

// ── Fetch Yahoo Finance ─────────────────────────────────────────
async function fetchYahoo(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&includePrePost=false`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json   = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("No data");

  const timestamps = result.timestamp || [];
  const quote      = result.indicators?.quote?.[0] || {};
  const closes  = quote.close  || [];
  const highs   = quote.high   || [];
  const lows    = quote.low    || [];
  const volumes = quote.volume || [];

  const valid = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null && highs[i] != null && lows[i] != null) {
      valid.push({
        date:   new Date(timestamps[i] * 1000),
        close:  closes[i],
        high:   highs[i],
        low:    lows[i],
        volume: volumes[i] || 0,
      });
    }
  }
  return valid;
}

// ── Scan one timeframe ──────────────────────────────────────────
async function scanTimeframe(interval, range, daysBack) {
  const cutoffMs = Date.now() - daysBack * 86400 * 1000;
  const signals  = [];
  const errors   = [];

  for (const sym of SYMBOLS) {
    try {
      const quotes = await fetchYahoo(sym, interval, range);
      if (quotes.length < 30) { errors.push(sym); continue; }

      const closes  = quotes.map(q => q.close);
      const highs   = quotes.map(q => q.high);
      const lows    = quotes.map(q => q.low);
      const volumes = quotes.map(q => q.volume);
      const dates   = quotes.map(q => q.date);

      const last5  = volumes.slice(-5);
      const avgVol = last5.reduce((s, v) => s + v, 0) / last5.length;
      const isHigh = avgVol >= CONFIG.VOL_THRESHOLD;
      const avg10  = volAvg(volumes, 10);
      const rsiArr = calcRSI(closes, CONFIG.RSI_PERIOD);
      const { buys, sells } = calcWT(highs, lows, closes, CONFIG.WT_N1, CONFIG.WT_N2, CONFIG.WT_NSC, CONFIG.WT_NSV);

      const push = (idx, type) => {
        const ts = dates[idx].getTime();
        if (ts < cutoffMs) return;
        const rsi = rsiArr[idx];
        signals.push({
          type,
          symbol:    sym,
          date:      new Date(dates[idx]).toLocaleString('en-GB', {
            timeZone: 'Asia/Riyadh',
            day:'2-digit', month:'2-digit',
            hour:'2-digit', minute:'2-digit', hour12: false
          }),
          timestamp: ts,
          close:     +closes[idx].toFixed(2),
          volume:    Math.round(volumes[idx]),
          avgVol:    Math.round(avgVol),
          highVol:   isHigh,
          volConf:   volumes[idx] > avg10[idx],
          rsi:       rsi !== null ? +rsi.toFixed(1) : null,
          rsiSignal: rsi !== null && ((type==="buy" && rsi < 30) || (type==="sell" && rsi > 70)),
        });
      };

      buys.forEach(i  => push(i, "buy"));
      sells.forEach(i => push(i, "sell"));

    } catch(e) {
      errors.push(`${sym}: ${e.message}`);
    }
  }

  signals.sort((a, b) => b.timestamp - a.timestamp);
  return { signals, errorCount: errors.length };
}

// ── Main handler ────────────────────────────────────────────────
module.exports = async (req, res) => {
  try {
    const now = new Date().toISOString();

    // Run all 3 timeframes in parallel
    const [tf15m, tf1h, tf4h] = await Promise.all([
      scanTimeframe("15m", "5d",  1),
      scanTimeframe("1h",  "14d", 2),
      scanTimeframe("4h",  "60d", 7),
    ]);

    const result = {
      "15m": { signals: tf15m.signals, errorCount: tf15m.errorCount },
      "1h":  { signals: tf1h.signals,  errorCount: tf1h.errorCount  },
      "4h":  { signals: tf4h.signals,  errorCount: tf4h.errorCount  },
      updatedAt:   now,
      symbolCount: SYMBOLS.length,
    };

    await kvSet("wt_signals", result);

    res.status(200).json({
      ok:      true,
      "15m":   tf15m.signals.length,
      "1h":    tf1h.signals.length,
      "4h":    tf4h.signals.length,
      updated: now,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
