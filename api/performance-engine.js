// Tracks proposed underlying-stock levels, not executed options positions.
const RETENTION_MS = 120 * 86400000;
const MAX_RECORDS = 1800;

function nyDateKey(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function nySession(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = type => parts.find(item => item.type === type)?.value;
  const minute = Number(part('hour')) * 60 + Number(part('minute'));
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(part('weekday')) && minute >= 570 && minute < 960;
}

function nyMinutes(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = type => Number(parts.find(item => item.type === type)?.value);
  return part('hour') * 60 + part('minute');
}

function fromSignal(signal, strategy, observedAt) {
  const direction = signal.type === 'buy' ? 1 : signal.type === 'sell' ? -1 : 0;
  const sourceTime = strategy === 'wedge' ? Number(signal.signalTimestamp)
    : Date.parse(signal.alertedAt || '') || Number(signal.timestamp);
  const entry = Number(signal.entry), stop = Number(signal.stop ?? signal.sl);
  const targets = [signal.t1, signal.t2, signal.t3].map(Number);
  const risk = Math.abs(entry - stop);
  if (!direction || !Number.isFinite(sourceTime) || !Number.isFinite(entry) || !Number.isFinite(stop)
    || !targets.every(Number.isFinite) || entry <= 0 || stop <= 0 || targets.some(target => target <= 0)
    || risk < 0.01 || direction * (entry - stop) <= 0
    || targets.some((target, index) => direction * (target - (index ? targets[index - 1] : entry)) <= 0)) return null;
  if (strategy === 'wedge' && signal.status !== 'TRIGGERED') return null;
  if (strategy === 'breakout' && signal.level === 'setup') return null;
  const mode = strategy === 'intraday' ? signal.mode : strategy === 'wedge' ? signal.pattern : signal.level;
  const id = strategy === 'wedge' ? `wedge|${signal.setupId}`
    : strategy === 'breakout' ? `breakout|${signal.symbol}|${signal.type}|${signal.timestamp}`
    : `${strategy}|${signal.symbol}|${signal.type}|${mode}|${signal.timestamp}`;
  const startAt = Math.max(sourceTime, observedAt);
  return {
    id, strategy, mode, symbol: signal.symbol, timeframe: strategy === 'wedge' ? signal.timeframe : strategy === 'intraday' ? '5m' : '15m',
    direction: signal.type, signalAt: sourceTime, observedAt, trackingFrom: startAt,
    nyDate: nyDateKey(startAt), entry, stop, t1: targets[0], t2: targets[1], t3: targets[2],
    risk: +risk.toFixed(2), score: Number(signal.score ?? signal.confidence) || null,
    status: 'TRACKING', t1HitAt: null, t2HitAt: null, t3HitAt: null, stoppedAt: null,
    latestPrice: null, latestAt: null, maxFavorableR: 0, maxAdverseR: 0, evaluatedBars: 0,
    outcomeR: null, completedAt: null,
  };
}

function captureNewSignals(existing, scans, observedAt, marketOpen) {
  const records = [...existing], known = new Set(existing.map(record => record.id));
  if (!marketOpen) return records;
  const groups = [
    ['intraday', scans.intraday?.signals || []],
    ['breakout', scans.breakout?.signals || []],
    ['wedge', scans.wedges?.signals || []],
  ];
  for (const [strategy, signals] of groups) for (const signal of signals) {
    const record = fromSignal(signal, strategy, observedAt);
    if (!record || known.has(record.id) || observedAt - record.signalAt > 45 * 60000 || record.signalAt > observedAt + 60000) continue;
    records.push(record);
    known.add(record.id);
  }
  return records;
}

function advanceRecord(record, quotes, now) {
  if (record.status !== 'TRACKING' && record.status !== 'T1_HIT' && record.status !== 'T2_HIT') return record;
  const next = { ...record };
  const buy = record.direction === 'buy';
  const risk = record.risk;
  if (!Number.isFinite(risk) || risk <= 0) return next;
  for (const quote of quotes) {
    const openAt = new Date(quote.date).getTime();
    const closeAt = openAt + 5 * 60000;
    // Evaluate only entire regular-session candles observed after tracking began.
    if (openAt < record.trackingFrom || closeAt > now || closeAt <= (next.latestAt || 0)
      || nyDateKey(openAt) !== record.nyDate || !nySession(openAt)) continue;
    const high = Number(quote.high), low = Number(quote.low), close = Number(quote.close);
    if (![high, low, close].every(Number.isFinite)) continue;
    next.evaluatedBars++;
    next.latestPrice = +close.toFixed(2);
    next.latestAt = closeAt;
    const favorable = buy ? high - record.entry : record.entry - low;
    const adverse = buy ? record.entry - low : high - record.entry;
    // OHLC does not reveal intrabar order: stop wins if both levels are touched.
    if (buy ? low <= record.stop : high >= record.stop) {
      next.status = 'STOPPED'; next.stoppedAt = closeAt; next.completedAt = closeAt; next.outcomeR = -1;
      break;
    }
    next.maxFavorableR = +Math.max(next.maxFavorableR, favorable / risk).toFixed(2);
    next.maxAdverseR = +Math.max(next.maxAdverseR, adverse / risk).toFixed(2);
    if (!next.t1HitAt && (buy ? high >= record.t1 : low <= record.t1)) next.t1HitAt = closeAt;
    if (!next.t2HitAt && (buy ? high >= record.t2 : low <= record.t2)) next.t2HitAt = closeAt;
    if (!next.t3HitAt && (buy ? high >= record.t3 : low <= record.t3)) next.t3HitAt = closeAt;
    if (next.t3HitAt) {
      next.status = 'T3_HIT'; next.completedAt = closeAt; next.outcomeR = 3; break;
    }
    if (next.t2HitAt) next.status = 'T2_HIT';
    else if (next.t1HitAt) next.status = 'T1_HIT';
  }
  if ((nyDateKey(now) !== record.nyDate || nyMinutes(now) >= 970) && ['TRACKING', 'T1_HIT', 'T2_HIT'].includes(next.status)) {
    const eodObserved = next.latestAt && nyDateKey(next.latestAt - 1) === record.nyDate && nyMinutes(next.latestAt) >= 960;
    next.status = eodObserved ? 'SESSION_ENDED' : 'NO_COVERAGE';
    next.completedAt = next.latestAt || now;
    next.outcomeR = eodObserved ? +(((next.latestPrice - record.entry) * (buy ? 1 : -1)) / risk).toFixed(2) : null;
  }
  return next;
}

function keepRecent(records, now) {
  return records.filter(record => now - record.observedAt <= RETENTION_MS)
    .sort((a, b) => b.observedAt - a.observedAt).slice(0, MAX_RECORDS);
}

module.exports = { fromSignal, captureNewSignals, advanceRecord, keepRecent, nyDateKey, nySession };
