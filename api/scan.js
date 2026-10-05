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

async function kvGet(key) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const res = await fetch(`${url}/get/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (!json.result) return null;
  try { return JSON.parse(json.result); } catch { return null; }
}

// ── Fetch Yahoo Finance ─────────────────────────────────────────
const yahooRequestCache = new Map();
async function fetchYahoo(symbol, interval, range, includePrePost = false) {
  const cacheKey = `${symbol}|${interval}|${range}|${includePrePost}`;
  if (yahooRequestCache.has(cacheKey)) return yahooRequestCache.get(cacheKey);
  const request = fetchYahooUncached(symbol, interval, range, includePrePost);
  yahooRequestCache.set(cacheKey, request);
  return request;
}

async function fetchYahooUncached(symbol, interval, range, includePrePost = false) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=${includePrePost ? "true" : "false"}`;
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
  const opens   = quote.open   || [];
  const highs   = quote.high   || [];
  const lows    = quote.low    || [];
  const volumes = quote.volume || [];

  const valid = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null && highs[i] != null && lows[i] != null) {
      valid.push({
        date:   new Date(timestamps[i] * 1000),
        open: opens[i] ?? closes[i], close: closes[i], high: highs[i],
        low:    lows[i],   volume: volumes[i] || 0,
      });
    }
  }
  valid.meta = {
    previousClose: result.meta?.chartPreviousClose ?? result.meta?.previousClose ?? null,
    regularMarketPrice: result.meta?.regularMarketPrice ?? null,
  };
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

function calcATR(highs, lows, closes, period = 14) {
  const tr = highs.map((high, i) => {
    if (i === 0) return high - lows[i];
    const prevClose = closes[i - 1];
    return Math.max(
      high - lows[i],
      Math.abs(high - prevClose),
      Math.abs(lows[i] - prevClose),
    );
  });

  const atr = Array(tr.length).fill(null);
  if (tr.length < period) return atr;

  // Wilder's smoothing: seed with the first 14-period average, then smooth.
  atr[period - 1] = tr.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr[i] = ((atr[i - 1] * (period - 1)) + tr[i]) / period;
  }
  return atr;
}

// ── Format date to Riyadh time ─────────────────────────────────
function fmtDate(d) {
  return new Date(d).toLocaleString('en-GB', {
    timeZone: 'Asia/Riyadh',
    day:'2-digit', month:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12: false
  });
}

function marketSession(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(d));
  const value = type => parts.find(part => part.type === type)?.value;
  const weekday = value('weekday');
  const mins = Number(value('hour')) * 60 + Number(value('minute'));
  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)) return 'closed';
  if (mins >= 240 && mins < 570) return 'pre';
  if (mins >= 570 && mins < 960) return 'open';
  return 'closed';
}

function nyMinutes(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(d));
  const value = type => Number(parts.find(part => part.type === type)?.value);
  return value('hour') * 60 + value('minute');
}

function previousRegularClose(quotes, reference = new Date()) {
  const today = nyDateKey(reference);
  for (let i = quotes.length - 1; i >= 0; i--) {
    const quote = quotes[i];
    if (nyDateKey(quote.date) >= today) continue;
    const mins = nyMinutes(quote.date);
    if (mins >= 570 && mins < 960) return quote.close;
  }
  return null;
}

function previousDailyClose(quotes, reference = new Date()) {
  const today = nyDateKey(reference);
  for (let i = quotes.length - 1; i >= 0; i--) {
    if (nyDateKey(quotes[i].date) < today) return quotes[i].close;
  }
  return null;
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
async function scanBreakout(previousSignals = [], scanStartedAt = new Date().toISOString()) {
  const signals = [], errors = [];
  const previousByKey = new Map(previousSignals.map(signal => [
    `${signal.symbol}-${signal.type}-${signal.level}-${signal.timestamp}`,
    signal,
  ]));
  for (const sym of SYMBOLS) {
    try {
      // Daily candles define the main trend/breakout. 15m candles size the
      // trade plan so targets remain realistic for intraday options trading.
      const [quotes, intradayQuotes] = await Promise.all([
        fetchYahoo(sym, "1d", "2y"),
        fetchYahoo(sym, "15m", "5d"),
      ]);
      if (quotes.length < 210 || intradayQuotes.length < 20) { errors.push(sym); continue; }

      const closes  = quotes.map(q => q.close);
      const highs   = quotes.map(q => q.high);
      const lows    = quotes.map(q => q.low);
      const volumes = quotes.map(q => q.volume);
      const dates   = quotes.map(q => q.date);

      const ema20  = calcEMA(closes, 20);
      const ema50  = calcEMA(closes, 50);
      const ema200 = calcEMA(closes, 200);
      const atrArr = calcATR(highs, lows, closes, 14);
      const rsiArr = calcRSI(closes, 14);

      const intradayCloses = intradayQuotes.map(q => q.close);
      const intradayHighs  = intradayQuotes.map(q => q.high);
      const intradayLows   = intradayQuotes.map(q => q.low);
      const intradayAtrArr = calcATR(intradayHighs, intradayLows, intradayCloses, 14);
      const intradayAtr    = [...intradayAtrArr].reverse().find(value => value !== null && value > 0);
      const livePrice      = intradayCloses[intradayCloses.length - 1];
      if (!intradayAtr || !livePrice) { errors.push(sym); continue; }

      // Rolling 20-period high/low
      const roll20High = closes.map((_, i) => i < 19 ? null : Math.max(...highs.slice(i-19, i)));
      const roll20Low  = closes.map((_, i) => i < 19 ? null : Math.min(...lows.slice(i-19, i)));

      const volAvg20 = closes.map((_, i) => {
        if (i < 19) return 0;
        return volumes.slice(i-19, i+1).reduce((s,v)=>s+v,0)/20;
      });

      // Day-trading view: evaluate only the current/latest market session.
      for (let i = Math.max(200, closes.length - 1); i < closes.length; i++) {
        const ts = dates[i].getTime();

        const close   = closes[i];
        const atr     = atrArr[i];
        const rsi     = rsiArr[i];
        const volNow  = volumes[i];
        const volAvgN = volAvg20[i];

        if (!atr || atr === 0) continue;

        const prevHigh = roll20High[i-1];
        const prevLow  = roll20Low[i-1];
        if (!prevHigh || !prevLow) continue;

        // Confirmation inputs
        const highVol = volNow > 1.5 * volAvgN;
        const bullTrend = ema20[i] > ema50[i] && ema50[i] > ema200[i];
        const bearTrend = ema20[i] < ema50[i] && ema50[i] < ema200[i];
        const rsiBull   = rsi !== null && rsi > 60;
        const rsiBear   = rsi !== null && rsi < 40;
        const brokeUp   = close > prevHigh && bullTrend;
        const brokeDown = close < prevLow && bearTrend;

        // Early setup: within 1% or 0.5 ATR of the 20-day level.
        const nearBand  = Math.max(close * 0.01, atr * 0.5);
        const setupUp   = !brokeUp && close <= prevHigh && close >= prevHigh - nearBand && ema20[i] > ema50[i] && rsi !== null && rsi >= 50;
        const setupDown = !brokeDown && close >= prevLow && close <= prevLow + nearBand && ema20[i] < ema50[i] && rsi !== null && rsi <= 50;

        let type = null, level = null, confidence = 0, trigger = null;

        if (brokeUp || brokeDown) {
          type = brokeUp ? "buy" : "sell";
          confidence = 40;                    // Price cleared the 20-day level
          confidence += 20;                   // EMA20/50/200 trend is aligned
          if (type === "buy" ? rsiBull : rsiBear) confidence += 20;
          if (highVol) confidence += 20;
          level = confidence === 100 ? "strong" : confidence >= 80 ? "confirmed" : "trend";
        } else if (setupUp || setupDown) {
          type = setupUp ? "buy" : "sell";
          trigger = type === "buy" ? prevHigh : prevLow;
          confidence = 40 + ((type === "buy" ? bullTrend : bearTrend) ? 10 : 0);
          level = "setup";
        }

        if (!type) continue;

        const previous = previousByKey.get(`${sym}-${type}-${level}-${ts}`);
        const alertedAt = previous?.alertedAt ?? scanStartedAt;
        const alertPrice = previous?.alertPrice ?? +livePrice.toFixed(2);
        const keepPlan = previous?.planVersion === "intraday-v1";
        // Setup enters at the trigger. Confirmed signals enter at the frozen
        // alert price. Once created, the full plan never moves on refresh.
        const entry = keepPlan
          ? previous.entry
          : +(trigger !== null ? trigger : alertPrice).toFixed(2);
        const planAtr = keepPlan ? previous.atr : +intradayAtr.toFixed(2);
        const dir = type === "buy" ? 1 : -1;
        const t1 = keepPlan ? previous.t1 : +(entry + dir * 0.5 * planAtr).toFixed(2);
        const t2 = keepPlan ? previous.t2 : +(entry + dir * 1.0 * planAtr).toFixed(2);
        const t3 = keepPlan ? previous.t3 : +(entry + dir * 1.5 * planAtr).toFixed(2);
        const sl = keepPlan
          ? previous.sl
          : +(entry - dir * 0.75 * planAtr).toFixed(2);

        signals.push({
          type, level, symbol: sym,
          // Show the real detection time, not Yahoo's daily-candle start time.
          date:       fmtDate(alertedAt),
          candleDate: fmtDate(dates[i]),
          timestamp:  ts,
          close:      +close.toFixed(2),
          // Freeze the underlying price when this exact signal is first detected.
          alertPrice,
          alertedAt,
          entry,
          trigger:    trigger !== null ? +trigger.toFixed(2) : null,
          t1, t2, t3, tp: t3, sl,
          atr:        planAtr,
          atrTimeframe: "15m",
          dailyAtr:   +atr.toFixed(2),
          planVersion: "intraday-v1",
          rsi:        rsi !== null ? +rsi.toFixed(1) : null,
          confidence,
          volume:     Math.round(volNow),
          avgVol:     Math.round(volAvgN),
          highVol,
          volConf:    highVol,
          rsiSignal:  type==="buy" ? rsiBull : rsiBear,
          ema20:      +ema20[i].toFixed(2),
          ema50:      +ema50[i].toFixed(2),
          ema200:     +ema200[i].toFixed(2),
        });
      }
    } catch(e) { errors.push(`${sym}: ${e.message}`); }
  }

  // Remove duplicates after newest-first sorting (keep latest per symbol/type)
  signals.sort((a, b) => b.timestamp - a.timestamp);
  const seen = new Set();
  const unique = signals.filter(s => {
    const k = `${s.symbol}-${s.type}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  unique.sort((a, b) => {
    const rank = { strong: 4, confirmed: 3, trend: 2, setup: 1 };
    return (rank[b.level] || 0) - (rank[a.level] || 0) || b.confidence - a.confidence || b.timestamp - a.timestamp;
  });
  return { signals: unique, errorCount: errors.length };
}

// ════════════════════════════════════════════════════════════════
// STRATEGY 3: Intraday fusion (5m execution + 15m trend)
// Breakout: 12-bar range break with RSI/trend/volume confirmation
// Reversal: WaveTrend cross near the 12-bar range edge
// ════════════════════════════════════════════════════════════════
async function scanIntraday(previousSignals = [], scanStartedAt = new Date().toISOString()) {
  const signals = [], errors = [], breadthItems = [];
  const previousByKey = new Map(previousSignals.map(signal => [
    `${signal.symbol}-${signal.type}-${signal.mode}-${signal.timestamp}`,
    signal,
  ]));
  const cutoffMs = Date.now() - 45 * 60 * 1000;

  for (const sym of SYMBOLS) {
    try {
      const [quotes5, quotes15] = await Promise.all([
        fetchYahoo(sym, "5m", "5d", true),
        fetchYahoo(sym, "15m", "5d", true),
      ]);
      if (quotes5.length < 60 || quotes15.length < 55) { errors.push(sym); continue; }

      const closes = quotes5.map(q => q.close);
      const highs = quotes5.map(q => q.high);
      const lows = quotes5.map(q => q.low);
      const volumes = quotes5.map(q => q.volume);
      const dates = quotes5.map(q => q.date);
      const latestQuote = quotes5[quotes5.length - 1];
      const previousClose = previousRegularClose(quotes5) ?? Number(quotes5.meta?.previousClose);
      const recentAvgVolume = volumes.slice(-21, -1).reduce((sum, value) => sum + value, 0) / Math.max(1, volumes.slice(-21, -1).length);
      const changePct = previousClose > 0 ? ((latestQuote.close - previousClose) / previousClose) * 100 : 0;
      breadthItems.push({
        symbol: sym,
        price: +latestQuote.close.toFixed(2),
        timestamp: latestQuote.date.getTime(),
        previousClose: previousClose > 0 ? +previousClose.toFixed(2) : null,
        changePct: +changePct.toFixed(2),
        direction: changePct > 0.05 ? 'up' : changePct < -0.05 ? 'down' : 'flat',
        volumeRatio: recentAvgVolume > 0 ? +(latestQuote.volume / recentAvgVolume).toFixed(2) : null,
      });
      const rsiArr = calcRSI(closes, 14);
      const atrArr = calcATR(highs, lows, closes, 14);
      const { buys, sells } = calcWT(
        highs, lows, closes,
        CONFIG.WT_N1, CONFIG.WT_N2, CONFIG.WT_NSC, CONFIG.WT_NSV,
      );
      const wtBuys = new Set(buys);
      const wtSells = new Set(sells);

      const closes15 = quotes15.map(q => q.close);
      const ema9_15 = calcEMA(closes15, 9);
      const ema20_15 = calcEMA(closes15, 20);
      const ema50_15 = calcEMA(closes15, 50);

      // Ignore the still-forming candle; confirmations use closed candles only.
      let last5 = quotes5.length - 1;
      while (last5 >= 0 && dates[last5].getTime() + 5 * 60 * 1000 > Date.now()) last5--;
      let last15 = quotes15.length - 1;
      while (last15 >= 0 && quotes15[last15].date.getTime() + 15 * 60 * 1000 > Date.now()) last15--;
      if (last5 < 50 || last15 < 50) continue;

      // Keep signals from the six most recent completed 5m candles (30 minutes).
      for (let i = Math.max(30, last5 - 5); i <= last5; i++) {
        const ts = dates[i].getTime();
        if (ts < cutoffMs) continue;
        // Use the latest 15m candle that had actually closed at this signal's close.
        let trendIndex = last15;
        const signalClose = ts + 5 * 60 * 1000;
        while (trendIndex >= 50 && quotes15[trendIndex].date.getTime() + 15 * 60 * 1000 > signalClose) trendIndex--;
        if (trendIndex < 50) continue;
        const trendCall = ema9_15[trendIndex] > ema20_15[trendIndex] && closes15[trendIndex] > ema20_15[trendIndex];
        const trendPut = ema9_15[trendIndex] < ema20_15[trendIndex] && closes15[trendIndex] < ema20_15[trendIndex];

        const close = closes[i];
        const rsi = rsiArr[i];
        const atr = atrArr[i];
        if (rsi === null || !atr || atr <= 0) continue;

        const prevHigh = Math.max(...highs.slice(i - 12, i));
        const prevLow = Math.min(...lows.slice(i - 12, i));
        const avgVol = volumes.slice(i - 20, i).reduce((sum, value) => sum + value, 0) / 20;
        const highVol = avgVol > 0 && volumes[i] >= 1.3 * avgVol;

        const breakoutCall = close > prevHigh && trendCall && rsi >= 55;
        const breakoutPut = close < prevLow && trendPut && rsi <= 45;
        const nearLow = lows[i] <= prevLow + 0.4 * atr;
        const nearHigh = highs[i] >= prevHigh - 0.4 * atr;
        const reversalCall = !breakoutCall && wtBuys.has(i) && nearLow && rsi <= 45 && close > closes[i - 1];
        const reversalPut = !breakoutPut && wtSells.has(i) && nearHigh && rsi >= 55 && close < closes[i - 1];

        let type = null, mode = null;
        if (breakoutCall || breakoutPut) {
          type = breakoutCall ? "buy" : "sell";
          mode = "breakout";
        } else if (reversalCall || reversalPut) {
          type = reversalCall ? "buy" : "sell";
          mode = "reversal";
        }
        if (!type) continue;

        let confidence = mode === "breakout" ? 60 : 55;
        if (highVol) confidence += 15;
        if (type === "buy" ? rsi >= 60 || rsi <= 35 : rsi <= 40 || rsi >= 65) confidence += 15;
        if (mode === "breakout" && (type === "buy" ? trendCall : trendPut)) confidence += 10;
        if (mode === "reversal" && (type === "buy" ? nearLow : nearHigh)) confidence += 15;
        confidence = Math.min(100, confidence);

        const key = `${sym}-${type}-${mode}-${ts}`;
        const previous = previousByKey.get(key);
        const keepPlan = previous?.planVersion === "minute-v1";
        const alertedAt = previous?.alertedAt ?? scanStartedAt;
        const alertPrice = previous?.alertPrice ?? +close.toFixed(2);
        const entry = keepPlan ? previous.entry : alertPrice;
        const planAtr = keepPlan ? previous.atr : +atr.toFixed(2);
        const dir = type === "buy" ? 1 : -1;
        const t1 = keepPlan ? previous.t1 : +(entry + dir * 0.5 * planAtr).toFixed(2);
        const t2 = keepPlan ? previous.t2 : +(entry + dir * 1.0 * planAtr).toFixed(2);
        const t3 = keepPlan ? previous.t3 : +(entry + dir * 1.5 * planAtr).toFixed(2);
        const sl = keepPlan ? previous.sl : +(entry - dir * 0.75 * planAtr).toFixed(2);

        signals.push({
          type, mode, symbol: sym,
          level: confidence >= 85 ? "strong" : confidence >= 70 ? "confirmed" : "early",
          date: fmtDate(alertedAt),
          candleDate: fmtDate(dates[i]),
          timestamp: ts,
          session: marketSession(dates[i]),
          alertedAt,
          alertPrice,
          latestPrice: +latestQuote.close.toFixed(2),
          latestPriceAt: latestQuote.date.getTime(),
          entry,
          t1, t2, t3, tp: t3, sl,
          atr: planAtr,
          atrTimeframe: "5m",
          planVersion: "minute-v1",
          confidence,
          rsi: +rsi.toFixed(1),
          volume: Math.round(volumes[i]),
          avgVol: Math.round(avgVol),
          highVol,
          volConf: highVol,
          ema9: +ema9_15[trendIndex].toFixed(2),
          ema20: +ema20_15[trendIndex].toFixed(2),
          ema50: +ema50_15[trendIndex].toFixed(2),
        });
      }
    } catch (e) { errors.push(`${sym}: ${e.message}`); }
  }

  signals.sort((a, b) => b.timestamp - a.timestamp);
  const seen = new Set();
  const unique = signals.filter(signal => {
    const key = `${signal.symbol}-${signal.type}-${signal.mode}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => b.confidence - a.confidence || b.timestamp - a.timestamp);
  const advancers = breadthItems.filter(item => item.direction === 'up').length;
  const decliners = breadthItems.filter(item => item.direction === 'down').length;
  const unchanged = breadthItems.length - advancers - decliners;
  const ranked = [...breadthItems].sort((a, b) => b.changePct - a.changePct);
  return {
    signals: unique,
    errorCount: errors.length,
    breadth: {
      advancers, decliners, unchanged,
      total: breadthItems.length,
      latestCandleAt: Math.max(0, ...breadthItems.map(item => item.timestamp || 0)) || null,
      averageChangePct: breadthItems.length ? +(breadthItems.reduce((sum, item) => sum + item.changePct, 0) / breadthItems.length).toFixed(2) : 0,
      leaders: ranked.filter(item => item.changePct > 0.05).slice(0, 5),
      laggards: ranked.filter(item => item.changePct < -0.05).slice(-5).reverse(),
    },
  };
}

// ════════════════════════════════════════════════════════════════
// STRATEGY 4: Confirmed-pivot wedge setups (5m + 15m)
// Uses closed candles only. A pivot is usable only after its right-side bars
// have closed, so historical detections do not look into the future.
// ════════════════════════════════════════════════════════════════
const WEDGE_CFG = {
  pivotLeft: 2, pivotRight: 2, minBarsBetweenPivots: 3,
  minDuration: 12, maxDuration: 60, minConvergence: 0.18,
  breakoutAtr: 0.06, stopAtrBuffer: 0.18,
};

function linearFit(points) {
  const n = points.length;
  if (n < 2) return null;
  const sx = points.reduce((sum, point) => sum + point.index, 0);
  const sy = points.reduce((sum, point) => sum + point.price, 0);
  const sxx = points.reduce((sum, point) => sum + point.index ** 2, 0);
  const sxy = points.reduce((sum, point) => sum + point.index * point.price, 0);
  const denominator = n * sxx - sx ** 2;
  if (!denominator) return null;
  const slope = (n * sxy - sx * sy) / denominator;
  const intercept = (sy - slope * sx) / n;
  const mean = sy / n;
  const total = points.reduce((sum, point) => sum + (point.price - mean) ** 2, 0);
  const residual = points.reduce((sum, point) => sum + (point.price - (intercept + slope * point.index)) ** 2, 0);
  return { slope, intercept, r2: total ? Math.max(0, 1 - residual / total) : 1, at: index => intercept + slope * index };
}

function confirmedPivots(highs, lows, endIndex, left = 2, right = 2) {
  const highsOut = [], lowsOut = [];
  for (let i = left; i <= endIndex - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (highs[i] <= highs[j]) isHigh = false;
      if (lows[i] >= lows[j]) isLow = false;
    }
    if (isHigh && (!highsOut.length || i - highsOut.at(-1).index >= WEDGE_CFG.minBarsBetweenPivots)) highsOut.push({ index: i, price: highs[i] });
    if (isLow && (!lowsOut.length || i - lowsOut.at(-1).index >= WEDGE_CFG.minBarsBetweenPivots)) lowsOut.push({ index: i, price: lows[i] });
  }
  return { highs: highsOut, lows: lowsOut };
}

function sessionVWAP(quotes, endIndex) {
  const key = nyDateKey(quotes[endIndex].date);
  let value = 0, volume = 0;
  for (let i = endIndex; i >= 0 && nyDateKey(quotes[i].date) === key; i--) {
    const v = Number(quotes[i].volume || 0);
    value += ((quotes[i].high + quotes[i].low + quotes[i].close) / 3) * v;
    volume += v;
  }
  return volume ? value / volume : quotes[endIndex].close;
}

function wedgeGrade(score) {
  return score >= 80 ? 'A+' : score >= 70 ? 'A' : score >= 60 ? 'B' : 'Weak';
}

function marketPoints(type, mood) {
  if (mood === 'neutral' || !mood) return 5;
  return (type === 'buy' && mood === 'bullish') || (type === 'sell' && mood === 'bearish') ? 10 : 0;
}

function applyWedgeMarketBias(result, market) {
  result.signals.forEach(signal => {
    if (signal.scoreFrozen) return;
    // A historical signal cannot use a market snapshot from a later candle.
    const signalClose = signal.signalTimestamp;
    const core = ['SPY', 'QQQ'].map(symbol => market?.items?.find(item => item.symbol === symbol));
    const breadthTime = Number(market?.watchlistBreadth?.latestCandleAt);
    const valid = !!signal.entry && market?.session === 'open'
      && core.every(item => item && Number(item.timestamp) <= signalClose && signalClose - Number(item.timestamp) <= 15 * 60000)
      && breadthTime > 0 && breadthTime <= signalClose && signalClose - breadthTime <= 15 * 60000;
    const breadth = market?.watchlistBreadth;
    const mood = !valid ? 'neutral'
      : core.every(item => item.direction === 'up') && breadth.advancers > breadth.decliners ? 'bullish'
      : core.every(item => item.direction === 'down') && breadth.decliners > breadth.advancers ? 'bearish' : 'neutral';
    const points = marketPoints(signal.type, mood);
    signal.marketBias = mood;
    signal.scoreParts.market = points;
    signal.score = Math.min(100, signal.baseScore + points);
    signal.grade = wedgeGrade(signal.score);
    if (signal.entry) signal.scoreFrozen = true;
  });
  result.signals.sort((a, b) => {
    const stateRank = { TRIGGERED: 5, T1_HIT: 4, T2_HIT: 3, READY: 2, FORMING: 1 };
    return (stateRank[b.status] || 0) - (stateRank[a.status] || 0) || b.score - a.score || b.signalTimestamp - a.signalTimestamp;
  });
  return result;
}

function updateWedgeLifecycle(setup, quotes, lastClosed) {
  if (!setup.entry || !['TRIGGERED', 'T1_HIT', 'T2_HIT'].includes(setup.status)) return setup;
  const buy = setup.type === 'buy';
  let status = setup.status;
  const hits = { ...(setup.hits || {}) };
  const candleMs = (setup.timeframe === '5m' ? 5 : 15) * 60000;
  for (let i = 0; i <= lastClosed; i++) {
    const candle = quotes[i];
    if (candle.date.getTime() < setup.signalTimestamp) continue;
    const hitTime = candle.date.getTime() + candleMs;
    // If stop and target occur inside the same candle, use the conservative outcome.
    if (buy ? candle.low <= setup.stop : candle.high >= setup.stop) { status = 'STOPPED'; hits.stopped ||= hitTime; break; }
    if (buy ? candle.high >= setup.t1 : candle.low <= setup.t1) hits.t1 ||= hitTime;
    if (buy ? candle.high >= setup.t2 : candle.low <= setup.t2) hits.t2 ||= hitTime;
    if (buy ? candle.high >= setup.t3 : candle.low <= setup.t3) { hits.t3 ||= hitTime; status = 'T3_HIT'; break; }
    if (hits.t2) status = 'T2_HIT';
    else if (hits.t1) status = 'T1_HIT';
  }
  return { ...setup, status, hits, finalResult: ['STOPPED', 'T3_HIT'].includes(status) ? status : null };
}

function detectWedgeAt(symbol, timeframe, quotes, i, arrays, previousById, scanStartedAt) {
  const { highs, lows, closes, volumes, atr, ema9, ema20, ema50 } = arrays;
  if (!atr[i] || i < WEDGE_CFG.minDuration) return null;
  const pivots = confirmedPivots(highs, lows, i, WEDGE_CFG.pivotLeft, WEDGE_CFG.pivotRight);
  const recentHighs = pivots.highs.filter(point => i - point.index <= WEDGE_CFG.maxDuration).slice(-3);
  const recentLows = pivots.lows.filter(point => i - point.index <= WEDGE_CFG.maxDuration).slice(-3);
  if (recentHighs.length < 3 || recentLows.length < 3) return null;
  const upper = linearFit(recentHighs), lower = linearFit(recentLows);
  if (!upper || !lower || upper.r2 < 0.35 || lower.r2 < 0.35) return null;
  const startIndex = Math.min(recentHighs[0].index, recentLows[0].index);
  const duration = i - startIndex;
  if (duration < WEDGE_CFG.minDuration || duration > WEDGE_CFG.maxDuration) return null;
  const startGap = upper.at(startIndex) - lower.at(startIndex);
  const currentGap = upper.at(i) - lower.at(i);
  if (startGap <= 0 || currentGap <= 0) return null;
  const convergence = 1 - currentGap / startGap;
  if (convergence < WEDGE_CFG.minConvergence || convergence > 0.88) return null;

  let pattern = null, type = null;
  if (upper.slope > 0 && lower.slope > upper.slope) { pattern = 'rising_wedge'; type = 'sell'; }
  if (upper.slope < 0 && lower.slope > upper.slope) { pattern = 'falling_wedge'; type = 'buy'; }
  if (!pattern) return null;

  const upperNow = upper.at(i), lowerNow = lower.at(i), close = closes[i];
  const previousClose = closes[i - 1];
  const breakoutDistance = type === 'buy' ? close - upperNow : lowerNow - close;
  const body = Math.abs(close - quotes[i].open);
  const avgVolume = volumes.slice(Math.max(0, i - 20), i).reduce((sum, value) => sum + value, 0) / Math.max(1, Math.min(20, i));
  const relativeVolume = avgVolume ? volumes[i] / avgVolume : 0;
  const closedOutside = type === 'buy' ? close > upperNow : close < lowerNow;
  const priorInside = previousClose <= upper.at(i - 1) + 0.12 * atr[i] && previousClose >= lower.at(i - 1) - 0.12 * atr[i];
  const confirmed = marketSession(quotes[i].date) === 'open' && closedOutside && priorInside && breakoutDistance >= WEDGE_CFG.breakoutAtr * atr[i] && body >= 0.2 * atr[i];
  const wrongWay = type === 'buy' ? close < lowerNow - 0.12 * atr[i] : close > upperNow + 0.12 * atr[i];
  const boundaryDistance = type === 'buy' ? upperNow - close : close - lowerNow;
  const ready = !confirmed && boundaryDistance >= -0.06 * atr[i] && boundaryDistance <= 0.35 * atr[i];
  const status = confirmed ? 'TRIGGERED' : wrongWay ? 'INVALIDATED' : ready ? 'READY' : 'FORMING';
  const setupId = `${symbol}-${timeframe}-${pattern}-${quotes[startIndex].date.getTime()}`;
  const signalTimestamp = quotes[i].date.getTime() + (timeframe === '5m' ? 5 : 15) * 60000;
  const previous = previousById.get(setupId);
  if (previous?.entry) return previous;

  const vwap = sessionVWAP(quotes, i);
  const vwapAligned = type === 'buy' ? close > vwap : close < vwap;
  const emaAligned = type === 'buy'
    ? ema9[i] > ema20[i] && ema20[i] > ema50[i]
    : ema9[i] < ema20[i] && ema20[i] < ema50[i];
  const latestPivot = type === 'buy' ? recentLows.at(-1).price : recentHighs.at(-1).price;
  const stopCandidate = type === 'buy' ? latestPivot - WEDGE_CFG.stopAtrBuffer * atr[i] : latestPivot + WEDGE_CFG.stopAtrBuffer * atr[i];
  const risk = Math.abs(close - stopCandidate);
  const riskAtr = risk / atr[i];
  const validStop = type === 'buy' ? stopCandidate < close - 0.1 * atr[i] : stopCandidate > close + 0.1 * atr[i];
  const actionable = confirmed && validStop && riskAtr <= 1.5 && riskAtr >= 0.25;
  const patternPoints = Math.round(Math.min(25, 13 + 6 * ((upper.r2 + lower.r2) / 2) + 8 * Math.min(1, convergence / 0.5)));
  const breakoutPoints = confirmed ? Math.round(Math.min(20, 7 + 7 * breakoutDistance / atr[i] + 6 * body / atr[i])) : ready ? 6 : 2;
  const volumePoints = Math.round(Math.min(15, 5 * relativeVolume));
  const alignmentPoints = (vwapAligned ? 7 : 0) + (emaAligned ? 8 : 0);
  const roomPoints = riskAtr >= 0.3 && riskAtr <= 1.25 ? 10 : riskAtr <= 1.5 ? 5 : 0;
  const freshnessPoints = 5; // Signal quality is immutable; recency is a separate UI filter.
  const scoreParts = { pattern: patternPoints, breakout: breakoutPoints, volume: volumePoints, alignment: alignmentPoints, market: 0, room: roomPoints, freshness: freshnessPoints };
  const baseScore = Object.values(scoreParts).reduce((sum, value) => sum + value, 0);
  const dir = type === 'buy' ? 1 : -1;
  const entry = actionable ? +close.toFixed(2) : null;
  const stop = actionable ? +stopCandidate.toFixed(2) : null;
  const frozenRisk = actionable ? Math.abs(entry - stop) : null;
  return {
    setupId, symbol, timeframe, pattern, type, status: confirmed && !actionable ? 'INVALIDATED' : status,
    patternName: pattern === 'rising_wedge' ? 'وتد صاعد · PUT' : 'وتد هابط · CALL',
    signalTimestamp, timestamp: signalTimestamp, candleTimestamp: quotes[i].date.getTime(),
    alertedAt: previous?.alertedAt || scanStartedAt, date: fmtDate(signalTimestamp),
    session: marketSession(quotes[i].date), latestPrice: +quotes.at(-1).close.toFixed(2), latestPriceAt: quotes.at(-1).date.getTime(),
    triggerPrice: +(type === 'buy' ? upperNow : lowerNow).toFixed(2), entry, stop,
    risk: frozenRisk == null ? null : +frozenRisk.toFixed(2),
    t1: actionable ? +(entry + dir * frozenRisk).toFixed(2) : null,
    t2: actionable ? +(entry + dir * 2 * frozenRisk).toFixed(2) : null,
    t3: actionable ? +(entry + dir * 3 * frozenRisk).toFixed(2) : null,
    rr: actionable ? 3 : null, atr: +atr[i].toFixed(2), riskAtr: +riskAtr.toFixed(2),
    relativeVolume: +relativeVolume.toFixed(2), vwap: +vwap.toFixed(2), vwapAligned, emaAligned,
    ema9: +ema9[i].toFixed(2), ema20: +ema20[i].toFixed(2), ema50: +ema50[i].toFixed(2),
    convergence: +(convergence * 100).toFixed(1), breakoutAtr: +(Math.max(0, breakoutDistance) / atr[i]).toFixed(2),
    upperLine: { start: +upper.at(startIndex).toFixed(2), end: +upperNow.toFixed(2) },
    lowerLine: { start: +lower.at(startIndex).toFixed(2), end: +lowerNow.toFixed(2) },
    chart: { closes: closes.slice(startIndex, i + 1).map(value => +value.toFixed(2)) },
    scoreParts, baseScore, score: baseScore, grade: wedgeGrade(baseScore),
    eventType: confirmed ? actionable ? 'wedge_triggered' : 'wedge_invalidated' : wrongWay ? 'wedge_invalidated' : ready ? 'wedge_ready' : 'wedge_forming',
    finalResult: null,
  };
}

function wedgeTransitionEvents(previous, updated) {
  const event = (type, timestamp) => ({ type: `wedge_${type}`, setupId: updated.setupId, symbol: updated.symbol,
    timeframe: updated.timeframe, status: updated.status, timestamp,
    historical: Date.now() - timestamp > (updated.timeframe === '5m' ? 10 : 20) * 60000 });
  const out = [];
  if (!previous && ['FORMING', 'READY', 'TRIGGERED', 'INVALIDATED'].includes(updated.entry ? 'TRIGGERED' : updated.status))
    out.push(event(updated.entry ? 'triggered' : updated.status.toLowerCase(), updated.signalTimestamp));
  else if (previous && !previous.entry && updated.entry) out.push(event('triggered', updated.signalTimestamp));
  else if (previous && !previous.entry && previous.status !== updated.status) out.push(event(updated.status.toLowerCase(), updated.signalTimestamp));
  for (const key of ['t1', 't2', 't3', 'stopped']) {
    if (updated.hits?.[key] && !previous?.hits?.[key]) out.push(event(key === 'stopped' ? 'stopped' : `${key}_hit`, updated.hits[key]));
  }
  return out;
}

async function scanWedges(previousSignals = [], scanStartedAt = new Date().toISOString()) {
  const signals = [], errors = [], events = [];
  const previousById = new Map(previousSignals.map(signal => [signal.setupId, signal]));
  for (const symbol of SYMBOLS) {
    for (const timeframe of ['5m', '15m']) {
      try {
        const quotes = await fetchYahoo(symbol, timeframe, '5d', true);
        if (quotes.length < 70) { errors.push(`${symbol}-${timeframe}`); continue; }
        const highs = quotes.map(q => q.high), lows = quotes.map(q => q.low), closes = quotes.map(q => q.close), volumes = quotes.map(q => q.volume);
        const atr = calcATR(highs, lows, closes, 14), ema9 = calcEMA(closes, 9), ema20 = calcEMA(closes, 20), ema50 = calcEMA(closes, 50);
        const minutes = timeframe === '5m' ? 5 : 15;
        let lastClosed = quotes.length - 1;
        while (lastClosed >= 0 && quotes[lastClosed].date.getTime() + minutes * 60000 > Date.now()) lastClosed--;
        if (lastClosed < 65) continue;
        const arrays = { highs, lows, closes, volumes, atr, ema9, ema20, ema50 };
        const detected = [];
        for (let i = Math.max(60, lastClosed - 5); i <= lastClosed; i++) {
          const setup = detectWedgeAt(symbol, timeframe, quotes, i, arrays, previousById, scanStartedAt);
          if (setup && (i === lastClosed || setup.entry)) detected.push(setup);
        }
        const byId = new Map();
        for (const setup of detected) {
          const current = byId.get(setup.setupId);
          if (!current || (!current.entry && (setup.entry || setup.signalTimestamp > current.signalTimestamp))) byId.set(setup.setupId, setup);
        }
        for (const setup of byId.values()) {
          if (setup.entry && !previousById.has(setup.setupId) && previousSignals.some(signal =>
            signal.symbol === symbol && signal.timeframe === timeframe && signal.pattern === setup.pattern && signal.entry &&
            Math.abs(signal.signalTimestamp - setup.signalTimestamp) < 45 * 60000)) continue;
          const updated = updateWedgeLifecycle(setup, quotes, lastClosed);
          updated.latestPrice = +quotes[lastClosed].close.toFixed(2);
          updated.latestPriceAt = quotes[lastClosed].date.getTime();
          signals.push(updated);
          const previous = previousById.get(updated.setupId);
          events.push(...wedgeTransitionEvents(previous, updated));
        }
        for (const previous of previousSignals.filter(signal => signal.symbol === symbol && signal.timeframe === timeframe && signal.entry && Date.now() - signal.signalTimestamp < 12 * 60 * 60 * 1000)) {
          if (byId.has(previous.setupId)) continue;
          const updated = updateWedgeLifecycle(previous, quotes, lastClosed);
          updated.latestPrice = +quotes[lastClosed].close.toFixed(2);
          updated.latestPriceAt = quotes[lastClosed].date.getTime();
          signals.push(updated);
          events.push(...wedgeTransitionEvents(previous, updated));
        }
      } catch (error) { errors.push(`${symbol}-${timeframe}: ${error.message}`); }
    }
  }
  const unique = [...new Map(signals.map(signal => [signal.setupId, signal])).values()]
    .filter(signal => Date.now() - signal.signalTimestamp < 12 * 60 * 60 * 1000)
    .sort((a, b) => b.signalTimestamp - a.signalTimestamp);
  return { signals: unique, events: events.slice(-100), errorCount: errors.length };
}

// ════════════════════════════════════════════════════════════════
// MARKET OVERVIEW: broad US index ETFs + volatility
// ════════════════════════════════════════════════════════════════
async function scanMarket() {
  const instruments = [
    { symbol: 'SPY',  name: 'S&P 500',      group: 'core', weight: 2, inverse: false, unit: '$' },
    { symbol: 'QQQ',  name: 'Nasdaq 100',   group: 'core', weight: 2, inverse: false, unit: '$' },
    { symbol: 'DIA',  name: 'Dow Jones',    group: 'core', weight: 1, inverse: false, unit: '$' },
    { symbol: 'IWM',  name: 'Russell 2000', group: 'core', weight: 1, inverse: false, unit: '$' },
    { symbol: '^VIX', name: 'VIX',          group: 'core', weight: 2, inverse: true,  unit: ''  },
    { symbol: 'ES=F', name: 'S&P Futures',  group: 'futures', unit: '' },
    { symbol: 'NQ=F', name: 'Nasdaq Futures', group: 'futures', unit: '' },
    { symbol: 'YM=F', name: 'Dow Futures',  group: 'futures', unit: '' },
    { symbol: 'RTY=F', name: 'Russell Futures', group: 'futures', unit: '' },
    { symbol: '^TNX', name: 'US 10Y Yield', group: 'macro', unit: '%' },
    { symbol: 'DX-Y.NYB', name: 'Dollar Index', group: 'macro', unit: '' },
    { symbol: 'CL=F', name: 'WTI Oil',      group: 'macro', unit: '$' },
    { symbol: 'GC=F', name: 'Gold',         group: 'macro', unit: '$' },
    { symbol: 'XLK',  name: 'Technology',   group: 'sector', unit: '$' },
    { symbol: 'SMH',  name: 'Semiconductors', group: 'sector', unit: '$' },
    { symbol: 'XLF',  name: 'Financials',   group: 'sector', unit: '$' },
    { symbol: 'XLE',  name: 'Energy',       group: 'sector', unit: '$' },
  ];
  const items = [], errors = [];

  await Promise.all(instruments.map(async instrument => {
    try {
      const [quotes, dailyQuotes] = await Promise.all([
        fetchYahoo(instrument.symbol, '5m', '5d', true),
        fetchYahoo(instrument.symbol, '1d', '1mo', false),
      ]);
      if (quotes.length < 20) throw new Error('Insufficient data');
      const closes = quotes.map(quote => quote.close);
      const last = quotes[quotes.length - 1];
      const previousClose = previousDailyClose(dailyQuotes) ?? Number(quotes.meta?.previousClose);
      const ema20 = calcEMA(closes, 20).at(-1);
      const changePct = previousClose > 0
        ? ((last.close - previousClose) / previousClose) * 100
        : 0;
      const momentumBase = closes[Math.max(0, closes.length - 7)];
      const momentum30mPct = momentumBase > 0
        ? ((last.close - momentumBase) / momentumBase) * 100
        : 0;
      const emaDistancePct = ema20 > 0
        ? ((last.close - ema20) / ema20) * 100
        : 0;
      items.push({
        symbol: instrument.symbol,
        name: instrument.name,
        group: instrument.group,
        unit: instrument.unit,
        price: +last.close.toFixed(2),
        previousClose: previousClose > 0 ? +previousClose.toFixed(2) : null,
        changePct: +changePct.toFixed(2),
        momentum30mPct: +momentum30mPct.toFixed(2),
        ema20: +ema20.toFixed(2),
        emaDistancePct: +emaDistancePct.toFixed(2),
        aboveEma20: last.close >= ema20,
        direction: changePct > 0.05 ? 'up' : changePct < -0.05 ? 'down' : 'flat',
        timestamp: last.date.getTime(),
        date: fmtDate(last.date),
        session: marketSession(last.date),
        weight: instrument.weight || 0,
        inverse: instrument.inverse || false,
      });
    } catch (error) {
      errors.push(`${instrument.symbol}: ${error.message}`);
    }
  }));

  items.sort((a, b) => instruments.findIndex(item => item.symbol === a.symbol) - instruments.findIndex(item => item.symbol === b.symbol));
  let weighted = 0, maxWeight = 0;
  for (const item of items.filter(item => item.group === 'core')) {
    const directional = item.direction === 'up' ? 1 : item.direction === 'down' ? -1 : 0;
    const emaBias = item.aboveEma20 ? 0.25 : -0.25;
    const raw = Math.max(-1, Math.min(1, directional + emaBias));
    weighted += (item.inverse ? -raw : raw) * item.weight;
    maxWeight += item.weight;
  }
  const score = maxWeight ? Math.round(50 + (weighted / maxWeight) * 50) : 50;
  const mood = score >= 65 ? 'bullish' : score <= 35 ? 'bearish' : 'neutral';
  const coreItems = items.filter(item => item.group === 'core');
  const breadth = coreItems.filter(item => !item.inverse && item.direction === 'up').length;
  const vix = items.find(item => item.symbol === '^VIX') || null;

  return {
    items,
    score,
    mood,
    breadth,
    breadthTotal: coreItems.filter(item => !item.inverse).length,
    vixChange: vix?.changePct ?? null,
    session: marketSession(),
    errorCount: errors.length,
  };
}

function nyDateKey(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const value = type => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 5500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function scanCalendar() {
  const date = nyDateKey();
  let events = [], earnings = [], eventSource = 'unavailable', earningsSource = 'unavailable';

  try {
    const from = `${date}T00:00:00.000Z`;
    const to = new Date(Date.parse(from) + 36 * 60 * 60 * 1000).toISOString();
    const url = `https://economic-calendar.tradingview.com/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&countries=US`;
    const json = await fetchJsonWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://www.tradingview.com', 'Accept': 'application/json' },
    });
    const rows = Array.isArray(json?.result) ? json.result : Array.isArray(json) ? json : null;
    if (!rows) throw new Error('Unsupported calendar response');
    events = rows.map(event => {
      const rawDate = event.date ?? event.datetime ?? event.timestamp;
      const timestamp = typeof rawDate === 'number' ? rawDate * (rawDate < 1e12 ? 1000 : 1) : Date.parse(rawDate);
      const importance = Number(event.importance ?? event.impact ?? 1);
      return {
        title: event.title || event.name || event.event || 'US Economic Event',
        timestamp,
        impact: importance >= 3 ? 'high' : importance >= 2 ? 'medium' : 'low',
        actual: event.actual ?? null,
        forecast: event.forecast ?? null,
        previous: event.previous ?? null,
        kind: /fed|fomc|powell|governor/i.test(event.title || event.name || '') ? 'fed' : 'economic',
      };
    }).filter(event => Number.isFinite(event.timestamp) && nyDateKey(new Date(event.timestamp)) === date && event.impact !== 'low');
    eventSource = 'third-party';
  } catch (error) {
    events = [];
  }

  events.sort((a, b) => a.timestamp - b.timestamp);

  try {
    const url = `https://api.nasdaq.com/api/calendar/earnings?date=${date}`;
    const json = await fetchJsonWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, text/plain, */*', 'Origin': 'https://www.nasdaq.com' },
    });
    const rows = json?.data?.rows ?? json?.data?.calendar?.rows;
    if (!Array.isArray(rows)) throw new Error('Unsupported earnings response');
    earnings = rows.map(row => ({
      symbol: row.symbol || '—',
      name: row.name || row.companyName || '',
      time: row.time || row.timeOfDay || 'غير محدد',
      epsForecast: row.epsForecast || row.consensusEPSForecast || null,
      fiscalQuarter: row.fiscalQuarterEnding || null,
      watched: SYMBOLS.includes(row.symbol),
    })).sort((a, b) => Number(b.watched) - Number(a.watched)).slice(0, 20);
    earningsSource = 'third-party';
  } catch (error) {
    earnings = [];
  }

  return { date, events, earnings, eventSource, earningsSource };
}

// ════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    yahooRequestCache.clear();
    const now = new Date().toISOString();
    const previous = await kvGet("wt_signals");
    const historyValue = await kvGet("wt_wedge_history").catch(() => null);
    const previousHistory = Array.isArray(historyValue) ? historyValue : [];

    const [tf15m, tf1h, tf4h, breakout, intraday, wedgesRaw, market, calendar] = await Promise.all([
      scanWT("15m", "5d",  1),
      scanWT("1h",  "14d", 2),
      scanWT("4h",  "60d", 7),
      scanBreakout(previous?.breakout?.signals || [], now),
      scanIntraday(previous?.intraday?.signals || [], now),
      scanWedges(previous?.wedges?.signals || [], now),
      scanMarket(),
      scanCalendar(),
    ]);

    const wedges = applyWedgeMarketBias(wedgesRaw, { ...market, watchlistBreadth: intraday.breadth });
    const historyById = new Map(previousHistory.map(item => [item.setupId, item]));
    for (const signal of wedges.signals) {
      if (!signal.entry) continue;
      historyById.set(signal.setupId, {
        setupId: signal.setupId, symbol: signal.symbol, timeframe: signal.timeframe,
        pattern: signal.pattern, type: signal.type, signalTimestamp: signal.signalTimestamp,
        entry: signal.entry, stop: signal.stop, t1: signal.t1, t2: signal.t2, t3: signal.t3,
        score: signal.score, grade: signal.grade, scoreParts: signal.scoreParts,
        relativeVolume: signal.relativeVolume, vwap: signal.vwap, vwapAligned: signal.vwapAligned,
        ema9: signal.ema9, ema20: signal.ema20, ema50: signal.ema50,
        marketBias: signal.marketBias, status: signal.status, hits: signal.hits || {},
        finalResult: signal.finalResult,
      });
    }
    const wedgeHistory = [...historyById.values()].sort((a, b) => b.signalTimestamp - a.signalTimestamp).slice(0, 300);
    const result = {
      wt: {
        "15m": { signals: tf15m.signals, errorCount: tf15m.errorCount },
        "1h":  { signals: tf1h.signals,  errorCount: tf1h.errorCount  },
        "4h":  { signals: tf4h.signals,  errorCount: tf4h.errorCount  },
      },
      breakout: { signals: breakout.signals, errorCount: breakout.errorCount },
      intraday: { signals: intraday.signals, errorCount: intraday.errorCount },
      wedges: { signals: wedges.signals, events: [...(previous?.wedges?.events || []), ...wedges.events].slice(-200), errorCount: wedges.errorCount },
      market: { ...market, watchlistBreadth: intraday.breadth, calendar },
      updatedAt:   now,
      symbolCount: SYMBOLS.length,
      health: {
        failedSymbols: { intraday: intraday.errorCount, breakout: breakout.errorCount, wedges: wedges.errorCount,
          market: market.errorCount, wt15m: tf15m.errorCount, wt1h: tf1h.errorCount, wt4h: tf4h.errorCount },
        intradayLatestCandleAt: intraday.breadth.latestCandleAt,
      },
    };

    await kvSet("wt_signals", result);
    await kvSet("wt_wedge_history", wedgeHistory).catch(() => false);

    res.status(200).json({
      ok: true,
      wt_15m:   tf15m.signals.length,
      wt_1h:    tf1h.signals.length,
      wt_4h:    tf4h.signals.length,
      breakout: breakout.signals.length,
      breakout_setup: breakout.signals.filter(s => s.level === "setup").length,
      breakout_confirmed: breakout.signals.filter(s => s.level === "confirmed").length,
      breakout_strong: breakout.signals.filter(s => s.level === "strong").length,
      intraday: intraday.signals.length,
      intraday_breakout: intraday.signals.filter(s => s.mode === "breakout").length,
      intraday_reversal: intraday.signals.filter(s => s.mode === "reversal").length,
      wedges: wedges.signals.length,
      market_score: market.score,
      market_mood: market.mood,
      calendar_events: calendar.events.length,
      earnings_events: calendar.earnings.length,
      updated:  now,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
