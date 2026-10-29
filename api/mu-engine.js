const { calcRSI } = require('./indicators');

function ema(values, span) {
  if (!values.length) return [];
  const alpha = 2 / (span + 1), out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(alpha * values[i] + (1 - alpha) * out[i - 1]);
  return out;
}

function atr(quotes, period = 14) {
  const tr = quotes.map((q, i) => i ? Math.max(q.high - q.low, Math.abs(q.high - quotes[i - 1].close), Math.abs(q.low - quotes[i - 1].close)) : q.high - q.low);
  const out = new Array(tr.length).fill(null);
  if (tr.length < period) return out;
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = value;
  for (let i = period; i < tr.length; i++) { value = (value * (period - 1) + tr[i]) / period; out[i] = value; }
  return out;
}

function nyParts(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York', year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).formatToParts(new Date(value));
  const get = type => parts.find(p => p.type === type)?.value;
  return { date:`${get('year')}-${get('month')}-${get('day')}`, weekday:get('weekday'), minute:Number(get('hour')) * 60 + Number(get('minute')) };
}

function sessionOf(value) {
  const p = nyParts(value);
  if (!['Mon','Tue','Wed','Thu','Fri'].includes(p.weekday)) return 'closed';
  if (p.minute >= 240 && p.minute < 570) return 'pre';
  if (p.minute >= 570 && p.minute < 960) return 'open';
  if (p.minute >= 960 && p.minute < 1200) return 'after';
  return 'closed';
}

const round = value => Number.isFinite(value) ? +value.toFixed(2) : null;
const average = values => values.length ? values.reduce((a,b)=>a+b,0) / values.length : null;

function analyzeMU(quotes, now = Date.now(), meta = {}) {
  const valid = quotes.filter(q => q && Number.isFinite(q.close) && Number.isFinite(q.high) && Number.isFinite(q.low));
  if (valid.length < 30) throw new Error('Insufficient MU minute data');
  const last = valid.at(-1), latestDate = nyParts(last.date).date;
  const current = valid.filter(q => nyParts(q.date).date === latestDate);
  const regular = current.filter(q => sessionOf(q.date) === 'open');
  const pre = current.filter(q => sessionOf(q.date) === 'pre');
  const active = regular.length ? regular : pre.length ? pre : current;
  const previousDays = [...new Set(valid.map(q => nyParts(q.date).date).filter(d => d < latestDate))];
  const priorDate = previousDays.at(-1);
  const prior = valid.filter(q => nyParts(q.date).date === priorDate && sessionOf(q.date) === 'open');
  const previousClose = Number(meta.previousClose) || prior.at(-1)?.close || null;
  const closes = active.map(q => q.close), volumes = active.map(q => q.volume || 0);
  const ema9 = ema(closes, 9), ema20 = ema(closes, 20), rsi = calcRSI(closes, 14), atrValues = atr(active, 14);
  let cumulativePV = 0, cumulativeVolume = 0;
  const vwapSeries=active.map(q=>{const typical=(q.high+q.low+q.close)/3;cumulativePV+=typical*(q.volume||0);cumulativeVolume+=q.volume||0;return cumulativeVolume?cumulativePV/cumulativeVolume:typical;});
  const vwap = vwapSeries.at(-1) ?? average(closes);
  const i = active.length - 1, latest = active[i];
  const completed = active.slice(0, -1), signalCandle = completed.at(-1) || latest;
  const previousFive = completed.slice(-6, -1);
  const breakoutHigh = previousFive.length ? Math.max(...previousFive.map(q => q.high)) : null;
  const breakoutLow = previousFive.length ? Math.min(...previousFive.map(q => q.low)) : null;
  const recentVolume = completed.slice(-21, -1).map(q => q.volume || 0);
  const volumeBase = average(recentVolume) || 0;
  const relativeVolume = volumeBase ? (signalCandle.volume || 0) / volumeBase : null;
  const signalIndex = Math.max(0, active.indexOf(signalCandle));
  const signalVwap=vwapSeries[signalIndex]??vwap;
  const currentAtr = atrValues[signalIndex] || atrValues.at(-1) || Math.max(latest.close * .002, .05);
  const currentRsi = rsi[signalIndex];
  const e9 = ema9[signalIndex], e20 = ema20[signalIndex];
  const callChecks = {
    vwap: signalCandle.close > signalVwap, ema: e9 > e20, momentum: currentRsi >= 52 && currentRsi <= 78,
    breakout: breakoutHigh != null && signalCandle.close > breakoutHigh,
    volume: relativeVolume != null && relativeVolume >= 1.15,
  };
  const putChecks = {
    vwap: signalCandle.close < signalVwap, ema: e9 < e20, momentum: currentRsi >= 22 && currentRsi <= 48,
    breakout: breakoutLow != null && signalCandle.close < breakoutLow,
    volume: relativeVolume != null && relativeVolume >= 1.15,
  };
  const callScore = Object.values(callChecks).filter(Boolean).length;
  const putScore = Object.values(putChecks).filter(Boolean).length;
  const liveSession = sessionOf(now);
  let direction = callScore >= putScore ? 'buy' : 'sell';
  let score = Math.max(callScore, putScore), state = 'WAIT';
  const chosen = direction === 'buy' ? callChecks : putChecks;
  if (liveSession === 'open' && chosen.breakout && score >= 4) state = direction === 'buy' ? 'CALL_TRIGGERED' : 'PUT_TRIGGERED';
  else if (score >= 3) state = direction === 'buy' ? 'CALL_WATCH' : 'PUT_WATCH';
  else direction = null;
  const regularOpen = regular[0]?.open ?? null;
  const openingRange = regular.filter(q => { const minute=nyParts(q.date).minute; return minute >= 570 && minute < 585; });
  const price = latest.close;
  return {
    symbol:'MU', company:'Micron Technology', fetchedAt:now, quoteAt:new Date(last.date).getTime(), session:liveSession,
    sourceSession:sessionOf(last.date), stale: liveSession === 'open' && now - new Date(last.date).getTime() > 180000,
    price:round(price), previousClose:round(previousClose), change:round(previousClose ? price - previousClose : null),
    changePct:previousClose ? +(((price - previousClose) / previousClose) * 100).toFixed(2) : null,
    vwap:round(vwap), ema9:round(ema9.at(-1)), ema20:round(ema20.at(-1)), rsi:currentRsi == null ? null : +currentRsi.toFixed(1), atr1m:round(currentAtr),
    relativeVolume:relativeVolume == null ? null : +relativeVolume.toFixed(2),
    dayOpen:round(regularOpen), dayHigh:round(regular.length ? Math.max(...regular.map(q=>q.high)) : null), dayLow:round(regular.length ? Math.min(...regular.map(q=>q.low)) : null),
    preHigh:round(pre.length ? Math.max(...pre.map(q=>q.high)) : null), preLow:round(pre.length ? Math.min(...pre.map(q=>q.low)) : null),
    priorHigh:round(prior.length ? Math.max(...prior.map(q=>q.high)) : null), priorLow:round(prior.length ? Math.min(...prior.map(q=>q.low)) : null),
    orHigh:round(openingRange.length ? Math.max(...openingRange.map(q=>q.high)) : null), orLow:round(openingRange.length ? Math.min(...openingRange.map(q=>q.low)) : null),
    state, direction, score, checks:chosen, signalCandleAt:new Date(signalCandle.date).getTime(), signalPrice:round(signalCandle.close),
    breakoutLevel:round(direction === 'buy' ? breakoutHigh : direction === 'sell' ? breakoutLow : null),
    series:active.slice(-90).map(q=>[new Date(q.date).getTime(),round(q.close)]),
  };
}

function createPlan(snapshot, existingIds = new Set()) {
  if (!['CALL_TRIGGERED','PUT_TRIGGERED'].includes(snapshot.state)) return null;
  const direction = snapshot.direction, id = `MU|1m|${direction}|${snapshot.signalCandleAt}`;
  if (existingIds.has(id)) return null;
  const entry = snapshot.signalPrice, atrValue = Math.max(snapshot.atr1m || 0, entry * .001);
  const risk = Math.min(atrValue * .75, Math.max(atrValue * .35, entry * .0015));
  const dir = direction === 'buy' ? 1 : -1;
  return { id, symbol:'MU', timeframe:'1m', direction, signalAt:snapshot.signalCandleAt, createdAt:snapshot.fetchedAt,
    entry:round(entry), stop:round(entry-dir*risk), t1:round(entry+dir*risk), t2:round(entry+dir*risk*1.5), t3:round(entry+dir*risk*2),
    risk:round(risk), status:'TRACKING', t1HitAt:null,t2HitAt:null,t3HitAt:null,stoppedAt:null,latestPrice:entry,latestAt:snapshot.signalCandleAt };
}

function updatePlan(plan, quotes, now = Date.now()) {
  if (!['TRACKING','T1_HIT','T2_HIT'].includes(plan.status)) return plan;
  const next={...plan}, buy=plan.direction==='buy';
  for(const q of quotes) {
    const at=new Date(q.date).getTime();
    if(at < plan.signalAt || at <= (next.latestAt || 0) || at + 60000 > now || sessionOf(at)!=='open') continue;
    next.latestPrice=round(q.close); next.latestAt=at;
    if(buy ? q.low<=plan.stop : q.high>=plan.stop){next.status='STOPPED';next.stoppedAt=at;break;}
    if(!next.t1HitAt&&(buy?q.high>=plan.t1:q.low<=plan.t1)) next.t1HitAt=at;
    if(!next.t2HitAt&&(buy?q.high>=plan.t2:q.low<=plan.t2)) next.t2HitAt=at;
    if(!next.t3HitAt&&(buy?q.high>=plan.t3:q.low<=plan.t3)) next.t3HitAt=at;
    next.status=next.t3HitAt?'T3_HIT':next.t2HitAt?'T2_HIT':next.t1HitAt?'T1_HIT':'TRACKING';
    if(next.status==='T3_HIT') break;
  }
  const nowParts=nyParts(now), signalParts=nyParts(plan.signalAt);
  if(['TRACKING','T1_HIT','T2_HIT'].includes(next.status)&&(nowParts.date!==signalParts.date||nowParts.minute>=970)){
    next.status='SESSION_ENDED';next.completedAt=next.latestAt||now;
  }
  return next;
}

module.exports={analyzeMU,createPlan,updatePlan,sessionOf};
