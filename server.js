// ============================================================================
// APEX — Trend Scanner, server edition.
// Same trading logic as the browser prototype (apex.html), stripped of DOM
// rendering, wrapped in an HTTP server so it can run 24/7 on Railway and be
// checked from a phone browser instead of a laptop tab that has to stay open.
// Still PAPER TRADING ONLY — no real orders, no API keys, no funds at risk.
// ============================================================================
const express = require('express');
const fs = require('fs');
const path = require('path');

const BASE = 'https://fapi.binance.com/fapi/v1';
const STATE_FILE = path.join(__dirname, 'data', 'state.json');
const PORT = process.env.PORT || 3000;

// ---------- config (identical to the browser version — this IS the strategy) ----------
const CFG = {
  UNIVERSE_SIZE: 100,
  MIN_QUOTE_VOLUME: 20_000_000,
  SCAN_INTERVAL_MS: 15 * 60_000,
  PRICE_TICK_MS: 20_000,
  KLINE_INTERVAL: '4h',
  KLINE_LIMIT: 150,
  MIN_ADX: 22,
  MAX_POSITIONS: 6,
  POSITION_MARGIN_PCT: 8,
  SIZE_MULT_MIN: 0.4, SIZE_MULT_MAX: 1.6,
  LEVERAGE: 3,
  TAKER_FEE: 0.0004,
  STOP_LOSS_MARGIN_PCT: 20,
  TRAIL_ARM_PCT: 12,
  TRAIL_GAP_PCT: 6,
  MAX_SAME_DIRECTION_FRAC: 0.66,
  DD_PAUSE_PCT: 12,
  DD_FLATTEN_PCT: 20,
  DD_RESUME_PCT: 6,
  PORTFOLIO_HEAT_CAP_PCT: 15,
  LOSS_STREAK_COOLDOWN: 3,
  COOLDOWN_SIZE_MULT: 0.5,
  COOLDOWN_COMPOSITE_BONUS: 0.15,
  COOLDOWN_RESET_WINS: 2,
  WIN_STREAK_STEP: 0.05,
  WIN_STREAK_CAP_MULT: 1.25,
  VOL_REGIME_LOOKBACK: 12,
  VOL_REGIME_MIN_MULT: 0.5,
  VOL_REGIME_MAX_MULT: 1.15,
  PROFIT_LOCK_START_PCT: 15,
  PROFIT_LOCK_FULL_PCT: 60,
  PROFIT_LOCK_FLOOR_FRAC: 0.5,
  FUNDING_INTERVAL_MS: 8 * 3600_000,
  FUNDING_POLL_MS: 5 * 60_000,
  LIQUIDATION_MARGIN_PCT: 90,
  FALLBACK_SPREAD_BPS: 5,
  PAUSE_COOLOFF_MS: 24 * 3600_000,
  FLATTEN_COOLOFF_MS: 3 * 24 * 3600_000,
  HEAT_INTERVAL: '5m',
  HEAT_LOOKBACK_CANDLES: 6,
  HEAT_CHECK_TOP_N: 15,
  HEAT_MIN_ATR_RATIO: 0.15,
  ROTATE_MIN_COMPOSITE: 0.75,
  ROTATE_MIN_HEAT: 0.35,
  ROTATE_MIN_VOL_MULT: 2.0,
  ROTATE_WORST_MAX_MARGIN_PCT: -3,
  ROTATE_MIN_HOLD_MS: 40 * 60_000,
  ROTATE_COOLDOWN_MS: 30 * 60_000,
  MAX_TOTAL_DD_PCT: 35,
};

// ---------- state (persisted to disk so a Railway restart doesn't lose the run) ----------
let S = {
  balance: 10000, startBalance: 10000, equityPeak: 10000, ddRefPeak: 10000,
  breakerState: 'normal', breakerSince: null, hardStopped: false, hardStopAt: null,
  positions: [], history: [], lastScan: [], medianAtrPct: null,
  scanCount: 0, universeCount: 0, status: 'initializing', log: [],
  winStreak: 0, lossStreak: 0, cooldown: false,
  atrHistory: [], volRegimeMult: 1, riskMultiplier: 1, portfolioHeatPct: 0, lastRotationAt: null,
  startedAt: Date.now(),
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      S = { ...S, ...saved };
      console.log(`[state] restored — balance $${S.balance.toFixed(0)}, ${S.positions.length} open positions, ${S.scanCount} scans so far`);
    }
  } catch (e) { console.log('[state] no previous state, starting fresh:', e.message); }
}
function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(S));
  } catch (e) { console.error('[state] save failed:', e.message); }
}

function pushLog(msg, cls = '') {
  console.log(`[${new Date().toISOString()}] ${msg}`);
  S.log.unshift({ t: Date.now(), msg, cls });
  S.log = S.log.slice(0, 100);
}
async function fj(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------- real market mechanics: live spread + funding ----------
async function getBookTicker(symbol) {
  try {
    const d = await fj(`${BASE}/ticker/bookTicker?symbol=${symbol}`);
    const bid = +d.bidPrice, ask = +d.askPrice;
    if (!(bid > 0) || !(ask > 0)) throw new Error('bad book');
    return { bid, ask };
  } catch (e) { return null; }
}
function syntheticBook(price) {
  const halfSpread = price * (CFG.FALLBACK_SPREAD_BPS / 10000);
  return { bid: price - halfSpread, ask: price + halfSpread };
}
async function getFundingRate(symbol) {
  try {
    const d = await fj(`${BASE}/premiumIndex?symbol=${symbol}`);
    return +d.lastFundingRate || 0;
  } catch (e) { return null; }
}
async function accrueFunding(pos, now) {
  const elapsed = now - pos.lastFundingAt;
  if (elapsed <= 0) return;
  if (pos.fundingRate == null || now - pos.lastFundingPoll >= CFG.FUNDING_POLL_MS) {
    const rate = await getFundingRate(pos.symbol);
    if (rate != null) { pos.fundingRate = rate; pos.lastFundingPoll = now; }
  }
  const rate = pos.fundingRate || 0;
  const cost = pos.notional * rate * (elapsed / CFG.FUNDING_INTERVAL_MS);
  const signedCost = pos.direction === 'long' ? cost : -cost;
  S.balance -= signedCost;
  pos.fundingPaid = (pos.fundingPaid || 0) + signedCost;
  pos.lastFundingAt = now;
}
async function getHeatScore(symbol, direction, atrPct) {
  try {
    const kl = await fj(`${BASE}/klines?symbol=${symbol}&interval=${CFG.HEAT_INTERVAL}&limit=${CFG.HEAT_LOOKBACK_CANDLES + 1}`);
    if (!kl || kl.length < 2) return null;
    const closeNow = +kl[kl.length - 1][4];
    const closeThen = +kl[0][4];
    const movePct = (closeNow - closeThen) / closeThen;
    const signedMove = direction === 'long' ? movePct : -movePct;
    return atrPct > 0 ? signedMove / atrPct : 0;
  } catch (e) { return null; }
}

// ---------- adaptive risk layer ----------
function currentEquity(state = S) {
  let unreal = 0;
  state.positions.forEach(p => {
    if (p.lastPrice == null) return;
    const move = p.direction === 'long' ? (p.lastPrice - p.entry) / p.entry : (p.entry - p.lastPrice) / p.entry;
    unreal += p.notional * move;
  });
  const lockedMargin = state.positions.reduce((sum, p) => sum + p.marginUsd, 0);
  return state.balance + lockedMargin + unreal;
}
function updateVolRegime(state = S) {
  if (state.medianAtrPct) {
    state.atrHistory.push(state.medianAtrPct);
    state.atrHistory = state.atrHistory.slice(-CFG.VOL_REGIME_LOOKBACK);
  }
  if (state.atrHistory.length < 3) { state.volRegimeMult = 1; return; }
  const baseline = median(state.atrHistory);
  const ratio = baseline > 0 ? (state.medianAtrPct / baseline) : 1;
  state.volRegimeMult = clamp(1 / ratio, CFG.VOL_REGIME_MIN_MULT, CFG.VOL_REGIME_MAX_MULT);
}
function streakFactor(state = S) {
  if (state.cooldown) return CFG.COOLDOWN_SIZE_MULT;
  if (state.winStreak > 0) return clamp(1 + state.winStreak * CFG.WIN_STREAK_STEP, 1, CFG.WIN_STREAK_CAP_MULT);
  return 1;
}
function getDDThresholds(state = S) {
  const retPct = ((currentEquity(state) - state.startBalance) / state.startBalance) * 100;
  if (retPct <= CFG.PROFIT_LOCK_START_PCT) {
    return { pause: CFG.DD_PAUSE_PCT, flatten: CFG.DD_FLATTEN_PCT, resume: CFG.DD_RESUME_PCT };
  }
  const span = CFG.PROFIT_LOCK_FULL_PCT - CFG.PROFIT_LOCK_START_PCT;
  const t = clamp((retPct - CFG.PROFIT_LOCK_START_PCT) / span, 0, 1);
  const frac = 1 - t * (1 - CFG.PROFIT_LOCK_FLOOR_FRAC);
  return { pause: CFG.DD_PAUSE_PCT * frac, flatten: CFG.DD_FLATTEN_PCT * frac, resume: CFG.DD_RESUME_PCT * frac };
}
function computeRiskMultiplier(state = S) {
  state.riskMultiplier = clamp(streakFactor(state) * state.volRegimeMult, CFG.VOL_REGIME_MIN_MULT * CFG.COOLDOWN_SIZE_MULT, CFG.WIN_STREAK_CAP_MULT * CFG.VOL_REGIME_MAX_MULT);
  return state.riskMultiplier;
}
function updatePortfolioHeat(state = S) {
  const eq = currentEquity(state);
  const worstCase = state.positions.reduce((sum, p) => sum + p.marginUsd * (CFG.STOP_LOSS_MARGIN_PCT / 100), 0);
  state.portfolioHeatPct = eq > 0 ? (worstCase / eq) * 100 : 0;
  return state.portfolioHeatPct;
}
function exitPrice(p) { return p.direction === 'long' ? (p.lastBid || p.lastPrice) : (p.lastAsk || p.lastPrice); }
function marginPctOf(p) {
  if (p.lastPrice == null) return 0;
  const move = p.direction === 'long' ? (p.lastPrice - p.entry) / p.entry : (p.entry - p.lastPrice) / p.entry;
  return move * p.leverage * 100;
}

// ---------- indicators ----------
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}
function adx(highs, lows, closes, period = 14) {
  const n = highs.length;
  const tr = new Array(n).fill(0), plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1], down = lows[i - 1] - lows[i];
    plusDM[i] = (up > down && up > 0) ? up : 0;
    minusDM[i] = (down > up && down > 0) ? down : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  const smooth = arr => {
    const out = new Array(n).fill(null);
    let sum = arr.slice(1, period + 1).reduce((a, b) => a + b, 0);
    out[period] = sum;
    for (let i = period + 1; i < n; i++) { sum = sum - sum / period + arr[i]; out[i] = sum; }
    return out;
  };
  const trS = smooth(tr), plusS = smooth(plusDM), minusS = smooth(minusDM);
  const plusDI = new Array(n).fill(null), minusDI = new Array(n).fill(null), dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (!trS[i]) continue;
    plusDI[i] = 100 * plusS[i] / trS[i]; minusDI[i] = 100 * minusS[i] / trS[i];
    const s = plusDI[i] + minusDI[i];
    dx[i] = s === 0 ? 0 : 100 * Math.abs(plusDI[i] - minusDI[i]) / s;
  }
  const adxOut = new Array(n).fill(null);
  const firstDx = dx.findIndex(v => v !== null);
  if (firstDx === -1 || firstDx + period > n - 1) return { adx: adxOut };
  let avg = dx.slice(firstDx, firstDx + period).reduce((a, b) => a + b, 0) / period;
  adxOut[firstDx + period - 1] = avg;
  for (let i = firstDx + period; i < n; i++) { avg = (avg * (period - 1) + dx[i]) / period; adxOut[i] = avg; }
  return { adx: adxOut };
}
function atrPctSeries(highs, lows, closes, period = 14) {
  const n = highs.length;
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  const out = new Array(n).fill(null);
  for (let i = period; i < n; i++) out[i] = (tr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period) / closes[i];
  return out;
}

// ---------- market scan ----------
async function getUniverse() {
  const tickers = await fj(`${BASE}/ticker/24hr`);
  return tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => +t.quoteVolume >= CFG.MIN_QUOTE_VOLUME)
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, CFG.UNIVERSE_SIZE)
    .map(t => t.symbol);
}
function computeSeries(klines) {
  const highs = klines.map(k => +k[2]), lows = klines.map(k => +k[3]), closes = klines.map(k => +k[4]), vols = klines.map(k => +k[5]);
  const ts = klines.map(k => +k[0]);
  return { ts, highs, lows, closes, vols, e20: ema(closes, 20), e50: ema(closes, 50), adxArr: adx(highs, lows, closes, 14).adx, atrArr: atrPctSeries(highs, lows, closes, 14) };
}
function evaluateAt(symbol, series, i) {
  const { highs, lows, closes, vols, e20, e50, adxArr, atrArr } = series;
  if (i < 60 || i >= closes.length) return null;
  const adxNow = adxArr[i];
  if (adxNow == null || adxNow < CFG.MIN_ADX) return null;
  const price = closes[i], a = e20[i], b = e50[i];
  const longAligned = price > a && a > b;
  const shortAligned = price < a && a < b;
  if (!longAligned && !shortAligned) return null;
  const direction = longAligned ? 'long' : 'short';
  let structureHits = 0;
  for (let j = i - 7; j <= i; j++) {
    if (j <= 0) continue;
    if (direction === 'long' && highs[j] >= highs[j - 1] && lows[j] >= lows[j - 1]) structureHits++;
    if (direction === 'short' && highs[j] <= highs[j - 1] && lows[j] <= lows[j - 1]) structureHits++;
  }
  const structureScore = structureHits / 8;
  const recentVol = vols.slice(i - 4, i + 1).reduce((x, y) => x + y, 0) / 5;
  const priorVol = vols.slice(i - 24, i - 4).reduce((x, y) => x + y, 0) / 20;
  const volMult = recentVol / (priorVol || recentVol);
  const volScore = clamp(volMult - 0.5, 0, 1);
  const adxScore = Math.min(1, adxNow / 50);
  const emaGapScore = Math.min(1, Math.abs(a - b) / b / 0.02);
  const composite = adxScore * 0.4 + emaGapScore * 0.2 + volScore * 0.15 + structureScore * 0.25;
  const atrPct = atrArr[i] || 0.02;
  return { symbol, direction, price, adx: adxNow, composite, atrPct, volMult };
}
function scoreSymbol(symbol, klines) {
  if (!klines || klines.length < 60) return null;
  const series = computeSeries(klines);
  return evaluateAt(symbol, series, series.closes.length - 1);
}

let scanning = false;
async function scanMarket() {
  if (scanning) return;
  scanning = true;
  S.status = 'scanning';
  let universe;
  try { universe = await getUniverse(); }
  catch (e) { pushLog('⚠ universe fetch failed: ' + e.message, 'warn'); S.status = 'idle'; scanning = false; return; }
  S.universeCount = universe.length;

  const results = [];
  const CHUNK = 8;
  for (let i = 0; i < universe.length; i += CHUNK) {
    const chunk = universe.slice(i, i + CHUNK);
    const settled = await Promise.allSettled(chunk.map(sym => fj(`${BASE}/klines?symbol=${sym}&interval=${CFG.KLINE_INTERVAL}&limit=${CFG.KLINE_LIMIT}`)));
    settled.forEach((r, idx) => { if (r.status === 'fulfilled') { const sc = scoreSymbol(chunk[idx], r.value); if (sc) results.push(sc); } });
    await new Promise(r => setTimeout(r, 150));
  }
  results.sort((a, b) => b.composite - a.composite);
  S.lastScan = results;
  S.medianAtrPct = median(results.map(r => r.atrPct)) || 0.02;
  updateVolRegime();
  computeRiskMultiplier();
  S.scanCount++;
  S.status = 'idle';
  pushLog(`scan #${S.scanCount}: ${universe.length} symbols checked, ${results.length} trending (ADX≥${CFG.MIN_ADX}), median ATR ${(S.medianAtrPct * 100).toFixed(2)}%`, 'info');
  await manageEntries(results);
  saveState();
  scanning = false;
}

// ---------- equity / risk engine ----------
function updateBreaker() {
  const eq = currentEquity();
  if (eq > S.equityPeak) S.equityPeak = eq;
  if (eq > S.ddRefPeak) S.ddRefPeak = eq;

  const trueDD = ((S.equityPeak - eq) / S.equityPeak) * 100;
  if (!S.hardStopped && trueDD >= CFG.MAX_TOTAL_DD_PCT) {
    [...S.positions].forEach(p => { if (p.lastPrice != null) closePosition(p, exitPrice(p), 'hard-stop'); });
    S.hardStopped = true; S.breakerState = 'flattened'; S.hardStopAt = Date.now();
    pushLog(`⛔ HARD STOP: drawdown from all-time peak ${trueDD.toFixed(1)}% ≥ ${CFG.MAX_TOTAL_DD_PCT}% — trading halted, manual restart required via /api/resume`, 'warn');
  }
  if (S.hardStopped) { updatePortfolioHeat(); return trueDD; }

  const dd = ((S.ddRefPeak - eq) / S.ddRefPeak) * 100;
  const th = getDDThresholds();

  if (S.breakerState !== 'flattened' && dd >= th.flatten) {
    [...S.positions].forEach(p => { if (p.lastPrice != null) closePosition(p, exitPrice(p), 'circuit-breaker'); });
    S.breakerState = 'flattened'; S.breakerSince = Date.now();
    pushLog(`🚨 CIRCUIT BREAKER: drawdown ${dd.toFixed(1)}% ≥ adaptive flatten line ${th.flatten.toFixed(1)}% — flattened, cooling off ${(CFG.FLATTEN_COOLOFF_MS / 3600000).toFixed(0)}h`, 'warn');
  } else if (S.breakerState === 'flattened') {
    if (Date.now() - S.breakerSince >= CFG.FLATTEN_COOLOFF_MS) {
      S.ddRefPeak = eq; S.breakerState = 'normal';
      pushLog(`✅ flatten cool-off elapsed — resuming, fresh operational reference at $${eq.toFixed(0)}`, 'info');
    }
  } else if (S.breakerState === 'normal' && dd >= th.pause) {
    S.breakerState = 'paused'; S.breakerSince = Date.now();
    pushLog(`⏸ drawdown ${dd.toFixed(1)}% ≥ adaptive pause line ${th.pause.toFixed(1)}% — pausing new entries`, 'warn');
  } else if (S.breakerState === 'paused') {
    if (dd < th.pause * 0.6) {
      S.breakerState = 'normal';
      pushLog(`▶ drawdown eased to ${dd.toFixed(1)}% — new entries resumed`, 'info');
    } else if (Date.now() - S.breakerSince >= CFG.PAUSE_COOLOFF_MS) {
      S.ddRefPeak = eq; S.breakerState = 'normal';
      pushLog(`▶ pause cool-off elapsed without recovery — resuming, fresh reference at $${eq.toFixed(0)}`, 'info');
    }
  }
  updatePortfolioHeat();
  return dd;
}

async function openPosition(cand) {
  const volSizeMult = clamp((S.medianAtrPct || cand.atrPct) / cand.atrPct, CFG.SIZE_MULT_MIN, CFG.SIZE_MULT_MAX);
  const riskMult = computeRiskMultiplier();
  const sizeMult = volSizeMult * riskMult;
  const marginUsd = S.balance * (CFG.POSITION_MARGIN_PCT / 100) * sizeMult;
  const notional = marginUsd * CFG.LEVERAGE;

  const book = (await getBookTicker(cand.symbol)) || syntheticBook(cand.price);
  const fillPrice = cand.direction === 'long' ? book.ask : book.bid;
  const spreadCostPct = Math.abs(fillPrice - cand.price) / cand.price;

  const fee = notional * CFG.TAKER_FEE;
  if (S.balance < marginUsd + fee) return;

  const eq = currentEquity();
  const existingHeat = S.positions.reduce((sum, p) => sum + p.marginUsd * (CFG.STOP_LOSS_MARGIN_PCT / 100), 0);
  const addedHeat = marginUsd * (CFG.STOP_LOSS_MARGIN_PCT / 100);
  const projectedHeatPct = eq > 0 ? ((existingHeat + addedHeat) / eq) * 100 : 0;
  if (projectedHeatPct > CFG.PORTFOLIO_HEAT_CAP_PCT) {
    pushLog(`⛔ skip ${cand.symbol}: would push portfolio heat to ${projectedHeatPct.toFixed(1)}% (cap ${CFG.PORTFOLIO_HEAT_CAP_PCT}%)`, 'warn');
    return;
  }

  S.balance -= (marginUsd + fee);
  const now = Date.now();
  S.positions.push({
    symbol: cand.symbol, direction: cand.direction, entry: fillPrice, marginUsd, notional,
    leverage: CFG.LEVERAGE, openedAt: now, peakMarginPct: 0, trailing: false, entryAdx: cand.adx,
    lastPrice: fillPrice, lastBid: book.bid, lastAsk: book.ask, sizeMult,
    fundingRate: null, lastFundingAt: now, lastFundingPoll: 0, fundingPaid: 0
  });
  const tag = S.cooldown ? ' [cooldown]' : (riskMult > 1 ? ' [streak-boost]' : '');
  const heatNote = cand.heat != null ? ` · heat ${cand.heat.toFixed(2)}×ATR/30m` : '';
  pushLog(`OPEN ${cand.direction.toUpperCase()} ${cand.symbol} @ ${fillPrice} (spread cost ${(spreadCostPct * 100).toFixed(3)}%) · size×${sizeMult.toFixed(2)} (vol×${volSizeMult.toFixed(2)} risk×${riskMult.toFixed(2)})${tag}${heatNote} (ADX ${cand.adx.toFixed(1)}, score ${cand.composite.toFixed(2)})`, 'open');
}
function closePosition(pos, price, reason) {
  const priceMove = (price - pos.entry) / pos.entry;
  const signedMove = pos.direction === 'long' ? priceMove : -priceMove;
  const grossPnl = pos.notional * signedMove;
  const fee = pos.notional * CFG.TAKER_FEE;
  const netPnl = grossPnl - fee;
  S.balance += pos.marginUsd + netPnl;
  S.positions = S.positions.filter(p => p !== pos);
  S.history.unshift({
    symbol: pos.symbol, direction: pos.direction, entry: pos.entry, exit: price,
    pnlPct: signedMove * 100, pnlUsd: netPnl, fundingPaid: pos.fundingPaid || 0, balanceAfter: S.balance, reason, closedAt: Date.now()
  });
  S.history = S.history.slice(0, 300);
  const fundingNote = pos.fundingPaid ? ` · funding ${pos.fundingPaid >= 0 ? '-' : '+'}$${Math.abs(pos.fundingPaid).toFixed(2)}` : '';
  pushLog(`CLOSE ${pos.direction.toUpperCase()} ${pos.symbol} @ ${price} → ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)} USD (${reason})${fundingNote}`, 'close-pos');

  if (netPnl >= 0) {
    S.winStreak++; S.lossStreak = 0;
    if (S.cooldown && S.winStreak >= CFG.COOLDOWN_RESET_WINS) {
      S.cooldown = false;
      pushLog(`🟢 cooldown lifted after ${S.winStreak} wins`, 'info');
    }
  } else {
    S.lossStreak++; S.winStreak = 0;
    if (!S.cooldown && S.lossStreak >= CFG.LOSS_STREAK_COOLDOWN) {
      S.cooldown = true;
      pushLog(`🟡 cooldown triggered after ${S.lossStreak} consecutive losses`, 'warn');
    }
  }
  computeRiskMultiplier();
}
async function manageEntries(ranked) {
  if (S.breakerState !== 'normal') return;
  if (S.cooldown && ranked.length) {
    const bar = Math.max(...ranked.map(c => c.composite)) - CFG.COOLDOWN_COMPOSITE_BONUS;
    ranked = ranked.filter(c => c.composite >= bar);
  }
  const shortlist = ranked.slice(0, CFG.HEAT_CHECK_TOP_N);
  const hot = [];
  for (const cand of shortlist) {
    const heat = await getHeatScore(cand.symbol, cand.direction, cand.atrPct);
    if (heat != null && heat >= CFG.HEAT_MIN_ATR_RATIO) hot.push({ ...cand, heat });
  }
  hot.sort((a, b) => b.heat - a.heat);
  ranked = hot;

  const maxSameDir = Math.ceil(CFG.MAX_POSITIONS * CFG.MAX_SAME_DIRECTION_FRAC);
  const open = new Set(S.positions.map(p => p.symbol));
  let longCount = S.positions.filter(p => p.direction === 'long').length;
  let shortCount = S.positions.filter(p => p.direction === 'short').length;
  for (const cand of ranked) {
    if (S.positions.length >= CFG.MAX_POSITIONS) break;
    if (open.has(cand.symbol)) continue;
    if (cand.direction === 'long' && longCount >= maxSameDir) continue;
    if (cand.direction === 'short' && shortCount >= maxSameDir) continue;
    const before = S.positions.length;
    await openPosition(cand);
    if (S.positions.length > before) {
      open.add(cand.symbol);
      if (cand.direction === 'long') longCount++; else shortCount++;
    }
  }

  if (S.positions.length >= CFG.MAX_POSITIONS) {
    const now = Date.now();
    const rotationReady = !S.lastRotationAt || (now - S.lastRotationAt) >= CFG.ROTATE_COOLDOWN_MS;
    if (rotationReady) {
      const target = ranked.find(c => !open.has(c.symbol)
        && c.composite >= CFG.ROTATE_MIN_COMPOSITE && c.heat >= CFG.ROTATE_MIN_HEAT && (c.volMult || 0) >= CFG.ROTATE_MIN_VOL_MULT);
      if (target) {
        const eligible = S.positions
          .filter(p => marginPctOf(p) <= CFG.ROTATE_WORST_MAX_MARGIN_PCT && (now - p.openedAt) >= CFG.ROTATE_MIN_HOLD_MS)
          .sort((a, b) => marginPctOf(a) - marginPctOf(b));
        if (eligible.length) {
          const worst = eligible[0];
          pushLog(`🔄 ROTATE: ${worst.symbol} (${marginPctOf(worst).toFixed(1)}% margin) → ${target.symbol} (composite ${target.composite.toFixed(2)})`, 'warn');
          closePosition(worst, exitPrice(worst), 'rotated-out');
          await openPosition(target);
          S.lastRotationAt = now;
        }
      }
    }
  }
}

async function tickPositions() {
  if (!S.positions.length) { updateBreaker(); return; }
  const symbols = [...new Set(S.positions.map(p => p.symbol))];
  const books = {};
  try {
    const settled = await Promise.allSettled(symbols.map(sym => getBookTicker(sym)));
    settled.forEach((r, i) => { if (r.status === 'fulfilled' && r.value) books[symbols[i]] = r.value; });
  } catch (e) { return; }
  const now = Date.now();
  for (const p of S.positions) {
    const book = books[p.symbol];
    if (!book) continue;
    p.lastBid = book.bid; p.lastAsk = book.ask; p.lastPrice = (book.bid + book.ask) / 2;
    await accrueFunding(p, now);
  }

  updateBreaker();

  const trendKey = new Map((S.lastScan || []).map(c => [c.symbol + ':' + c.direction, c]));
  const universeSet = new Set((S.lastScan || []).map(c => c.symbol));

  [...S.positions].forEach(pos => {
    const price = pos.lastPrice;
    if (!price) return;
    const priceMove = (price - pos.entry) / pos.entry;
    const signedMove = pos.direction === 'long' ? priceMove : -priceMove;
    const marginPct = signedMove * pos.leverage * 100;
    if (marginPct > pos.peakMarginPct) pos.peakMarginPct = marginPct;
    if (!pos.trailing && pos.peakMarginPct >= CFG.TRAIL_ARM_PCT) pos.trailing = true;

    if (marginPct <= -CFG.LIQUIDATION_MARGIN_PCT) { closePosition(pos, exitPrice(pos), 'liquidation'); return; }
    if (marginPct <= -CFG.STOP_LOSS_MARGIN_PCT) { closePosition(pos, exitPrice(pos), 'stop-loss'); return; }
    if (pos.trailing && (pos.peakMarginPct - marginPct) >= CFG.TRAIL_GAP_PCT) { closePosition(pos, exitPrice(pos), 'trailing-stop'); return; }

    const stillGood = trendKey.get(pos.symbol + ':' + pos.direction);
    if (S.lastScan.length && !stillGood) {
      const reason = universeSet.has(pos.symbol) ? 'trend-reversed' : 'dropped-from-universe';
      closePosition(pos, exitPrice(pos), reason);
    }
  });
  saveState();
}

// ============================================================================
// HTTP layer
// ============================================================================
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  const eq = currentEquity();
  res.json({
    status: S.status, breakerState: S.breakerState, hardStopped: S.hardStopped,
    balance: S.balance, equity: eq, startBalance: S.startBalance,
    equityPeak: S.equityPeak, ddRefPeak: S.ddRefPeak,
    scanCount: S.scanCount, universeCount: S.universeCount,
    positions: S.positions, history: S.history.slice(0, 50), lastScan: S.lastScan.slice(0, 30),
    log: S.log.slice(0, 60), medianAtrPct: S.medianAtrPct,
    riskMultiplier: S.riskMultiplier, volRegimeMult: S.volRegimeMult,
    portfolioHeatPct: S.portfolioHeatPct, cooldown: S.cooldown, winStreak: S.winStreak, lossStreak: S.lossStreak,
    startedAt: S.startedAt, uptimeMs: Date.now() - S.startedAt,
    cfg: { MAX_POSITIONS: CFG.MAX_POSITIONS, MAX_TOTAL_DD_PCT: CFG.MAX_TOTAL_DD_PCT, PORTFOLIO_HEAT_CAP_PCT: CFG.PORTFOLIO_HEAT_CAP_PCT },
  });
});
// Manual resume after a hard-stop — mirrors the button in the browser prototype.
// No auth: fine for a personal paper-trading toy, do NOT expose this pattern once real money is involved.
app.post('/api/resume', (req, res) => {
  const eq = currentEquity();
  S.hardStopped = false; S.breakerState = 'normal';
  S.equityPeak = eq; S.ddRefPeak = eq;
  pushLog(`🔓 manual resume via API — peak tracking reset to $${eq.toFixed(0)}`, 'info');
  saveState();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`APEX server listening on :${PORT}`);
  loadState();
  scanMarket();
  setInterval(scanMarket, CFG.SCAN_INTERVAL_MS);
  setInterval(tickPositions, CFG.PRICE_TICK_MS);
});
