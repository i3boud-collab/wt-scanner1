// api/scan.js
// Vercel Serverless Function — يُستدعى كل 5 دقائق بواسطة Vercel Cron
// يحسب الإشارات ويخزنها في Vercel KV

const yahooFinance = require("yahoo-finance2").default;
const { calcWT, calcRSI, volAvg } = require("./indicators");
const { SYMBOLS, CONFIG }         = require("./config");

// ── KV helper (Upstash Redis REST API) ─────────────────────────
async function kvSet(key, value) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const encoded = encodeURIComponent(JSON.stringify(value));
  await fetch(`${url}/set/${key}/${encoded}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return true;
}

// ── Main scanner ────────────────────────────────────────────────
async function runScan() {
  const cutoffMs = Date.now() - CONFIG.DAYS_BACK * 86400 * 1000;
  const signals  = [];
  const errors   = [];

  for (const sym of SYMBOLS) {
    try {
      const rows = await yahooFinance.chart(sym, {
        period1:  new Date(Date.now() - 20 * 86400 * 1000).toISOString().slice(0,10),
        interval: CONFIG.INTERVAL,
      });

      const quotes = rows.quotes?.filter(q => q.close != null) ?? [];
      if (quotes.length < 30) { errors.push(sym); continue; }

      const closes  = quotes.map(q => q.close);
      const highs   = quotes.map(q => q.high  ?? q.close);
      const lows    = quotes.map(q => q.low   ?? q.close);
      const volumes = quotes.map(q => q.volume ?? 0);
      const dates   = quotes.map(q => q.date);

      const last5   = volumes.slice(-5);
      const avgVol  = last5.reduce((s, v) => s + v, 0) / last5.length;
      const isHigh  = avgVol >= CONFIG.VOL_THRESHOLD;
      const avg10   = volAvg(volumes, 10);
      const rsiArr  = calcRSI(closes, CONFIG.RSI_PERIOD);
      const { buys, sells } = calcWT(highs, lows, closes, CONFIG.WT_N1, CONFIG.WT_N2, CONFIG.WT_NSC, CONFIG.WT_NSV);

      const push = (idx, type) => {
        const ts = new Date(dates[idx]).getTime();
        if (ts < cutoffMs) return;
        const rsi = rsiArr[idx];
        signals.push({
          type,
          symbol:     sym,
          date:       new Date(dates[idx]).toISOString().slice(0,16).replace("T"," "),
          timestamp:  ts,
          close:      +closes[idx].toFixed(2),
          volume:     Math.round(volumes[idx]),
          avgVol:     Math.round(avgVol),
          highVol:    isHigh,
          volConf:    volumes[idx] > avg10[idx],
          rsi:        rsi !== null ? +rsi.toFixed(1) : null,
          rsiSignal:  rsi !== null && ((type==="buy" && rsi < 30) || (type==="sell" && rsi > 70)),
        });
      };

      buys.forEach(i  => push(i, "buy"));
      sells.forEach(i => push(i, "sell"));

    } catch (e) {
      errors.push(`${sym}: ${e.message}`);
    }
  }

  signals.sort((a, b) => b.timestamp - a.timestamp);

  const result = {
    signals,
    updatedAt:   new Date().toISOString(),
    symbolCount: SYMBOLS.length,
    errorCount:  errors.length,
  };

  await kvSet("wt_signals", result);
  return result;
}

// ── Vercel handler ──────────────────────────────────────────────
module.exports = async (req, res) => {
  // Security: only allow Vercel Cron or manual trigger with secret
  const authHeader = req.headers.authorization ?? "";
  const secret     = process.env.CRON_SECRET ?? "";
  if (secret && authHeader !== `Bearer ${secret}` && req.query.secret !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await runScan();
    res.status(200).json({
      ok:       true,
      count:    result.signals.length,
      updated:  result.updatedAt,
      errors:   result.errorCount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
