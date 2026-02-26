// api/scan.js — WaveTrend + Breakout multi-strategy scanner
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
        close:  closes[i], high: highs[i],
        low:    lows[i],   volume: volumes[i] || 0,
      });
    }
  }
  return valid;
}

// ── EMA helper ─────────────────────────────────────────────────
function calcEMA(arr, span) {
  const alpha = 2 / (span + 1);
  const res = [arr[0]];
  for (let i = 1; i < arr.length; i++)
    res.push(alpha * arr[i] + (1 - alpha) * res[i - 1]);
  return res;
}

function calcATR(highs, lows, period = 14) {
  const tr = highs.map((h, i) => h - lows[i]);
  return tr.map((_, i) => {
    if (i < period - 1) return null;
    return tr.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0) / period;
  });
}

// ── Format date to Riyadh time ─────────────────────────────────
function fmtDate(d) {
  return new Date(d).toLocaleString('en-GB', {
    timeZone: 'Asia/Riyadh',
    day:'2-digit', month:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12: false
  });
}

// ════════════════════════════════════════════════════════════════
// STRATEGY 1: WaveTrend (15m, 1h, 4h)
// ════════════════════════════════════════════════════════════════
async function scanWT(interval, range, daysBack) {
  const cutoffMs = Date.now() - daysBack * 86400 * 1000;
  const signals = [], errors = [];

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
          type, symbol: sym,
          date:      fmtDate(dates[idx]),
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
    } catch(e) { errors.push(`${sym}: ${e.message}`); }
  }

  signals.sort((a, b) => b.timestamp - a.timestamp);
  return { signals, errorCount: errors.length };
}

// ════════════════════════════════════════════════════════════════
// STRATEGY 2: Breakout (EMA20/50/200 + ATR + Volume)
// ════════════════════════════════════════════════════════════════
async function scanBreakout() {
  const signals = [], errors = [];
  // Breakout works best on daily timeframe
  const cutoffMs = Date.now() - 7 * 86400 * 1000; // آخر أسبوع

  for (const sym of SYMBOLS) {
    try {
      const quotes = await fetchYahoo(sym, "1d", "6mo");
      if (quotes.length < 60) { errors.push(sym); continue; }

      const closes  = quotes.map(q => q.close);
      const highs   = quotes.map(q => q.high);
      const lows    = quotes.map(q => q.low);
      const volumes = quotes.map(q => q.volume);
      const dates   = quotes.map(q => q.date);

      const ema20  = calcEMA(closes, 20);
      const ema50  = calcEMA(closes, 50);
      const ema200 = calcEMA(closes, 200);
      const atrArr = calcATR(highs, lows, 14);
      const rsiArr = calcRSI(closes, 14);

      // Rolling 20-period high/low
      const roll20High = closes.map((_, i) => i < 19 ? null : Math.max(...highs.slice(i-19, i)));
      const roll20Low  = closes.map((_, i) => i < 19 ? null : Math.min(...lows.slice(i-19, i)));

      const volAvg20 = closes.map((_, i) => {
        if (i < 19) return 0;
        return volumes.slice(i-19, i+1).reduce((s,v)=>s+v,0)/20;
      });

      for (let i = 200; i < closes.length; i++) {
        const ts = dates[i].getTime();
        if (ts < cutoffMs) continue;

        const close   = closes[i];
        const atr     = atrArr[i];
        const rsi     = rsiArr[i];
        const volNow  = volumes[i];
        const volAvgN = volAvg20[i];

        if (!atr || atr === 0) continue;

        const prevHigh = roll20High[i-1];
        const prevLow  = roll20Low[i-1];
        if (!prevHigh || !prevLow) continue;

        // Volume confirmation
        const highVol = volNow > 1.5 * volAvgN;

        // Confidence score
        let confidence = 0;
        if (highVol) confidence += 20;

        let type = null;

        // CALL (Breakout up)
        if (close > prevHigh && ema20[i] > ema50[i] && ema50[i] > ema200[i]) {
          type = "buy";
          if (rsi > 60) confidence += 20;
          if (ema20[i] > ema50[i] && ema50[i] > ema200[i]) confidence += 20;
        }
        // PUT (Breakout down)
        else if (close < prevLow && ema20[i] < ema50[i] && ema50[i] < ema200[i]) {
          type = "sell";
          if (rsi < 40) confidence += 20;
          if (ema20[i] < ema50[i] && ema50[i] < ema200[i]) confidence += 20;
        }

        if (!type || confidence < 40) continue;

        const entry = close;
        const tp    = type === "buy"  ? +(entry + 3 * atr).toFixed(2) : +(entry - 3 * atr).toFixed(2);
        const sl    = type === "buy"  ? +(entry - 1.5 * atr).toFixed(2) : +(entry + 1.5 * atr).toFixed(2);

        signals.push({
          type, symbol: sym,
          date:       fmtDate(dates[i]),
          timestamp:  ts,
          close:      +close.toFixed(2),
          tp, sl,
          atr:        +atr.toFixed(2),
          rsi:        rsi !== null ? +rsi.toFixed(1) : null,
          confidence,
          volume:     Math.round(volNow),
          avgVol:     Math.round(volAvgN),
          highVol,
          volConf:    highVol,
          rsiSignal:  type==="buy" ? rsi > 60 : rsi < 40,
          ema20:      +ema20[i].toFixed(2),
          ema50:      +ema50[i].toFixed(2),
          ema200:     +ema200[i].toFixed(2),
        });
      }
    } catch(e) { errors.push(`${sym}: ${e.message}`); }
  }

  // Remove duplicates (keep latest per symbol/type)
  const seen = new Set();
  const unique = signals.filter(s => {
    const k = `${s.symbol}-${s.type}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  unique.sort((a, b) => b.confidence - a.confidence || b.timestamp - a.timestamp);
  return { signals: unique, errorCount: errors.length };
}

// ════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  try {
    const now = new Date().toISOString();

    const [tf15m, tf1h, tf4h, breakout] = await Promise.all([
      scanWT("15m", "5d",  1),
      scanWT("1h",  "14d", 2),
      scanWT("4h",  "60d", 7),
      scanBreakout(),
    ]);

    const result = {
      wt: {
        "15m": { signals: tf15m.signals, errorCount: tf15m.errorCount },
        "1h":  { signals: tf1h.signals,  errorCount: tf1h.errorCount  },
        "4h":  { signals: tf4h.signals,  errorCount: tf4h.errorCount  },
      },
      breakout: { signals: breakout.signals, errorCount: breakout.errorCount },
      updatedAt:   now,
      symbolCount: SYMBOLS.length,
    };

    await kvSet("wt_signals", result);

    res.status(200).json({
      ok: true,
      wt_15m:   tf15m.signals.length,
      wt_1h:    tf1h.signals.length,
      wt_4h:    tf4h.signals.length,
      breakout: breakout.signals.length,
      updated:  now,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
