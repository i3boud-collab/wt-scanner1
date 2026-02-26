// ─────────────────────────────────────────────────────────────
// indicators.js  —  WaveTrend · RSI · Volume (pure JS, no deps)
// ─────────────────────────────────────────────────────────────

function ewma(arr, span) {
  const a = 2 / (span + 1);
  const r = [arr[0]];
  for (let i = 1; i < arr.length; i++)
    r.push(a * arr[i] + (1 - a) * r[i - 1]);
  return r;
}

function sma(arr, n) {
  return arr.map((_, i) =>
    i < n - 1 ? NaN : arr.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n
  );
}

function calcWT(highs, lows, closes, n1 = 10, n2 = 21, nsc = 53, nsv = -53) {
  const ap  = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const esa = ewma(ap, n1);
  const d   = ewma(ap.map((v, i) => Math.abs(v - esa[i])), n1);
  const ci  = ap.map((v, i) => (v - esa[i]) / (0.015 * (d[i] || 1e-10)));
  const wt1 = ewma(ci, n2);
  const wt2 = sma(wt1, 4);

  const buys = [], sells = [];
  for (let i = 1; i < wt1.length; i++) {
    if (wt1[i] > wt2[i] && wt1[i-1] <= wt2[i-1] && wt1[i] <= nsv) buys.push(i);
    if (wt1[i] < wt2[i] && wt1[i-1] >= wt2[i-1] && wt1[i] >= nsc) sells.push(i);
  }
  return { buys, sells, wt1, wt2 };
}

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;

  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  rsi[period] = 100 - 100 / (1 + ag / Math.max(al, 1e-10));

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d,  0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    rsi[i] = 100 - 100 / (1 + ag / Math.max(al, 1e-10));
  }
  return rsi;
}

function volAvg(volumes, n = 10) {
  return volumes.map((_, i) => {
    const sl = volumes.slice(Math.max(0, i - n + 1), i + 1);
    return sl.reduce((s, v) => s + v, 0) / sl.length;
  });
}

module.exports = { calcWT, calcRSI, volAvg };
