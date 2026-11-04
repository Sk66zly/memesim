// Auto-trader: an optional bot that trades a player's MOCK money for them. Off for everyone until they turn it on.
//
// Every 10 seconds one shared scan looks at the coins on the trending list and, for each trading style, sorts them into:
//   reject  - fails a rug-risk check (creator can still mint/freeze, honeypot, dev or top wallets hold too much,
//             too few holders, thin liquidity, brand new, dumping right now...)
//   pending - no safety data yet (holders, authorities), so it is not bought until there is
//   watch   - looks safe enough but there's no good entry (no momentum, or it already pumped too hard to chase)
//   buy     - passes every check and has a healthy uptrend; the highest scores get bought first
// Then each player's bot manages its own positions: half off at the take-profit target, a trailing stop on the rest,
// a stop-loss, a "no momentum" time limit, and an emergency exit on rug warnings (liquidity pulled, sudden crash).
// It only ever touches coins it bought itself, never the player's own positions, and only spends mock USD.
const { EventEmitter } = require('node:events');
const { db } = require('./db');
const market = require('./market');
const game = require('./game');

const events = new EventEmitter();
const TICK_MS = 10_000;
const MIN_TRADE_USD = 1;

const STYLES = {
  careful: {
    label: 'Careful', blurb: 'Only established coins with lots of holders. Fewer trades, small targets, tight stop.',
    maxPositions: 3, minLiq: 25_000, minMcap: 60_000, minAgeMin: 45, minHolders: 400, maxTop10: 45, maxDev: 5, minGt: 35,
    needGraduated: true, maxChase5m: 12, maxChase1h: 150, minBuyRatio: 1.15, minScore: 70,
    tp1: 25, trail: 10, stop: 12, maxHoldMin: 90,
  },
  balanced: {
    label: 'Balanced', blurb: 'Newer coins that still pass the rug checks. Medium targets and stops.',
    maxPositions: 4, minLiq: 12_000, minMcap: 25_000, minAgeMin: 15, minHolders: 200, maxTop10: 55, maxDev: 8, minGt: 25,
    needGraduated: false, maxChase5m: 20, maxChase1h: 300, minBuyRatio: 1.05, minScore: 60,
    tp1: 40, trail: 14, stop: 18, maxHoldMin: 60,
  },
  aggressive: {
    label: 'Aggressive', blurb: 'Very young coins with fast momentum. Still skips obvious rugs, but expect more losses.',
    maxPositions: 6, minLiq: 6_000, minMcap: 10_000, minAgeMin: 5, minHolders: 80, maxTop10: 70, maxDev: 15, minGt: 12,
    needGraduated: false, maxChase5m: 35, maxChase1h: 600, minBuyRatio: 1.0, minScore: 50,
    tp1: 60, trail: 20, stop: 25, maxHoldMin: 40,
  },
};
const styleOf = (s) => STYLES[s] || STYLES.balanced;

// ---------- safety data (GeckoTerminal token info), cached ----------
const info = new Map(); // address -> { at, src, holders, top10, dev, mint, freeze, honeypot, gt, graduated }
const INFO_TTL = 15 * 60_000;
const str = (v) => (typeof v === 'string' ? v.toLowerCase().slice(0, 12) : null);
const pct = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
function cleanInfo(a) {
  if (!a || typeof a !== 'object') return null;
  const lp = a.launchpad_details;
  return {
    holders: pct(a.holders?.count),
    top10: pct(a.holders?.distribution_percentage?.top_10),
    dev: pct(a.developer_holding_percentage),
    mint: str(a.mint_authority), freeze: str(a.freeze_authority), honeypot: str(a.is_honeypot),
    gt: pct(a.gt_score),
    graduated: lp && typeof lp === 'object' ? Boolean(lp.completed) : null,
  };
}
function demoInfo(address) {
  // demo market: made-up but stable safety data, with a few coins that are clearly risky so the checks show up
  let h = 7;
  for (const ch of address) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const risky = /RUGPROOF|NGMI|SENDIT/.test(address);
  return {
    holders: risky ? 60 + (h % 50) : 300 + (h % 4000), top10: risky ? 72 + (h % 20) : 18 + (h % 30), dev: risky ? 12 + (h % 20) : h % 4,
    mint: /RUGPROOF/.test(address) ? 'yes' : 'no', freeze: 'no', honeypot: 'no', gt: risky ? 8 : 40 + (h % 50), graduated: true,
  };
}
function infoFor(address) {
  if (String(address).startsWith('DEMO')) return demoInfo(address);
  const hit = info.get(address);
  return hit && Date.now() - hit.at < INFO_TTL * 2 ? hit : null;
}
function needInfo(limit = 3) {
  const out = [];
  for (const a of market.trendingAddresses()) {
    if (a.startsWith('DEMO')) continue;
    const hit = info.get(a);
    if (!hit || Date.now() - hit.at > INFO_TTL) out.push(a);
    if (out.length >= limit) break;
  }
  return out;
}
let infoBusy = false;
async function fetchSomeInfo() {
  if (infoBusy || market.mode !== 'live' || market.geckoPaused()) return;
  const [a] = needInfo(1);
  if (!a) return;
  infoBusy = true;
  try {
    const j = await market.geckoGet(`/networks/solana/tokens/${a}/info`);
    const c = cleanInfo(j?.data?.attributes);
    if (c) info.set(a, { ...c, at: Date.now(), src: 'server' });
  } catch { /* rate-limited: players' browsers can fill in */ } finally { infoBusy = false; }
}
// Players' browsers can send safety data for coins the server couldn't fetch (same idea as the price relay).
function ingestInfo(body) {
  const a = String(body?.address || '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) || !market.trendingAddresses().includes(a)) return { ok: false };
  const cur = info.get(a);
  if (cur && Date.now() - cur.at < INFO_TTL) return { ok: true };
  const c = cleanInfo(body?.attributes);
  if (!c || c.holders == null) return { ok: false };
  info.set(a, { ...c, at: Date.now(), src: 'browser' });
  return { ok: true };
}

// ---------- scoring ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtK = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${Math.round(n)}`);

function candleStats(address) {
  const c = market.candlesOf(address);
  if (c.length < 3) return null;
  const last = c.slice(-15);
  const closes = last.map((x) => x.close);
  const now = closes[closes.length - 1];
  const hi = Math.max(...last.map((x) => x.high || x.close));
  const avg10 = closes.slice(-10).reduce((s, v) => s + v, 0) / Math.min(10, closes.length);
  const prev = closes[closes.length - 2];
  return { now, fromHigh: (now / hi - 1) * 100, aboveAvg: now >= avg10, lastMin: (now / prev - 1) * 100 };
}

// Returns { status: 'buy'|'watch'|'pending'|'reject', score, safety, momentum, reason, checks: [{ok, text}] }
function assess(t, st) {
  const checks = [];
  const fail = (text) => checks.push({ ok: false, text });
  const pass = (text) => checks.push({ ok: true, text });
  if (!t?.priceUsd || Date.now() - (t.updatedAt || 0) > 90_000) return { status: 'pending', score: 0, safety: 0, momentum: 0, reason: 'No live price right now', checks };
  const inf = infoFor(t.address);
  const liq = t.liquidity || 0;
  const mcap = t.marketCap || 0;
  const ageMin = t.createdAt ? (Date.now() - t.createdAt) / 60_000 : null;
  const cs = candleStats(t.address);
  let safety = 100;

  // --- rug-risk checks (any failure = never buy) ---
  if (inf) {
    if (inf.mint && inf.mint !== 'no') fail('Creator can still mint more coins'); else pass('Mint authority revoked');
    if (inf.freeze && inf.freeze !== 'no') fail('Creator can freeze wallets'); else pass('Freeze authority revoked');
    if (inf.honeypot === 'yes') fail('Honeypot: holders can\'t sell'); else pass('Not flagged as a honeypot');
    if (inf.dev != null) { if (inf.dev > st.maxDev) fail(`Dev wallet holds ${inf.dev.toFixed(1)}%`); else { pass(`Dev holds ${inf.dev.toFixed(1)}%`); safety -= inf.dev * 1.5; } }
    if (inf.holders != null) { if (inf.holders < st.minHolders) fail(`Only ${inf.holders} holders`); else { pass(`${inf.holders.toLocaleString('en-US')} holders`); safety -= clamp(15 - Math.log10(inf.holders) * 4, 0, 10); } }
    if (inf.top10 != null && inf.top10 > 0 && inf.top10 <= 100) { // >100% means the data includes pools and is unreliable
      if (inf.top10 > st.maxTop10) fail(`Top 10 wallets own ${inf.top10.toFixed(0)}%`); else { pass(`Top 10 wallets own ${inf.top10.toFixed(0)}%`); safety -= inf.top10 * 0.35; }
    }
    if (inf.gt != null) { if (inf.gt < st.minGt) fail(`Low trust score (${inf.gt.toFixed(0)}/100)`); else { pass(`Trust score ${inf.gt.toFixed(0)}/100`); safety += (inf.gt - 50) * 0.2; } }
    if (st.needGraduated && inf.graduated === false) fail('Still on the pump.fun bonding curve');
  } else if (!String(t.address).startsWith('DEMO')) {
    return { status: 'pending', score: 0, safety: 0, momentum: 0, reason: 'Checking holders & contract…', checks };
  }
  if (liq > 0) { if (liq < st.minLiq) fail(`Liquidity only ${fmtK(liq)}`); else pass(`Liquidity ${fmtK(liq)}`); }
  else if (inf?.graduated !== false) fail('No liquidity data');
  if (liq > 0 && mcap > 0) { const r = liq / mcap; if (r < 0.03) fail('Very thin liquidity for its size'); else safety -= clamp((0.1 - r) * 150, 0, 12); }
  if (mcap && mcap < st.minMcap) fail(`Market cap only ${fmtK(mcap)}`);
  if (ageMin != null) { if (ageMin < st.minAgeMin) fail(`Too new (${Math.max(1, Math.round(ageMin))} min old)`); else { pass(`${ageMin >= 120 ? `${Math.round(ageMin / 60)}h` : `${Math.round(ageMin)} min`} old`); if (ageMin < 60) safety -= 8; } }
  if (t.change5m != null && t.change5m < -15) fail(`Dumping (${t.change5m.toFixed(0)}% in 5 min)`);
  const buys = t.buys5m ?? null, sells = t.sells5m ?? null;
  if (buys != null && sells != null && sells > 10 && sells > buys * 1.8) fail('Heavy selling right now');
  if (cs && cs.fromHigh < -35) fail(`Crashed ${Math.abs(cs.fromHigh).toFixed(0)}% from its 15-min high`);
  safety = clamp(Math.round(safety), 0, 100);
  const bad = checks.filter((c) => !c.ok);
  if (bad.length) return { status: 'reject', score: 0, safety, momentum: 0, reason: bad[0].text, checks };

  // --- entry: healthy uptrend, not a chase ---
  const c5 = t.change5m ?? 0, c1h = t.change1h ?? 0;
  const ratio = buys != null && sells != null ? buys / Math.max(1, sells) : 1;
  let why = null;
  if (c5 > st.maxChase5m) why = `Already up ${c5.toFixed(0)}% in 5 min (won't chase)`;
  else if (c1h > st.maxChase1h) why = `Already up ${c1h.toFixed(0)}% in 1h (too late)`;
  else if (c5 < 1) why = 'No upward momentum yet';
  else if (c1h < -10) why = 'Down-trend over the last hour';
  else if (ratio < st.minBuyRatio) why = 'More sellers than buyers';
  else if (cs && !cs.aboveAvg) why = 'Below its 10-min average';
  const momentum = clamp(Math.round(40 + Math.min(30, c5 * 2) + clamp((ratio - 1) * 30, -15, 15) + (cs?.aboveAvg ? 10 : 0) + clamp(c1h / 10, -10, 10)), 0, 100);
  const score = Math.round(safety * 0.55 + momentum * 0.45);
  if (why) return { status: 'watch', score, safety, momentum, reason: why, checks };
  if (score < st.minScore) return { status: 'watch', score, safety, momentum, reason: `Score ${score} is below ${st.minScore}`, checks };
  return { status: 'buy', score, safety, momentum, reason: `Passes all checks · score ${score}`, checks };
}

let scans = {}; // style -> [{ address, symbol, image, status, score, safety, momentum, reason, checks }]
let scannedAt = 0;
function scan() {
  const out = {};
  const tokens = market.trendingAddresses().map((a) => market.tokenInfo(a)).filter(Boolean);
  for (const [k, st] of Object.entries(STYLES)) {
    out[k] = tokens.map((t) => ({ address: t.address, symbol: t.symbol, image: t.image, marketCap: t.marketCap, ...assess(t, st) }))
      .sort((a, b) => ['buy', 'watch', 'pending', 'reject'].indexOf(a.status) - ['buy', 'watch', 'pending', 'reject'].indexOf(b.status) || b.score - a.score);
  }
  scans = out;
  scannedAt = Date.now();
}

// ---------- per-player activity log (kept in memory) ----------
const logs = new Map(); // userId -> [{ ts, kind, text, symbol, address }]
const notes = new Map(); // userId -> last status note, so "waiting" messages aren't repeated every tick
function log(userId, kind, text, extra = {}) {
  const arr = logs.get(userId) || [];
  arr.unshift({ ts: Date.now(), kind, text, ...extra });
  logs.set(userId, arr.slice(0, 80));
}
function noteOnce(userId, text) {
  if (notes.get(userId) === text) return;
  notes.set(userId, text);
  log(userId, 'info', text);
}

// ---------- settings ----------
function settingsFor(userId) {
  const r = db.prepare('SELECT * FROM bots WHERE user_id = ?').get(userId);
  return { enabled: Boolean(r?.enabled), style: STYLES[r?.style] ? r.style : 'balanced', budgetPct: r?.budget_pct ?? 50 };
}
function updateSettings(userId, body) {
  const cur = settingsFor(userId);
  const next = {
    enabled: typeof body?.enabled === 'boolean' ? body.enabled : cur.enabled,
    style: STYLES[body?.style] ? body.style : cur.style,
    budgetPct: Number.isFinite(Number(body?.budgetPct)) ? clamp(Math.round(Number(body.budgetPct)), 10, 100) : cur.budgetPct,
  };
  db.prepare(`INSERT INTO bots (user_id, enabled, style, budget_pct, updated_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, style = excluded.style, budget_pct = excluded.budget_pct, updated_at = excluded.updated_at`)
    .run(userId, next.enabled ? 1 : 0, next.style, next.budgetPct, Date.now());
  if (next.enabled !== cur.enabled) {
    notes.delete(userId);
    log(userId, next.enabled ? 'on' : 'off', next.enabled
      ? `Auto-trader on · ${STYLES[next.style].label} · can use ${next.budgetPct}% of your cash`
      : 'Auto-trader off. Coins it already bought stay in your positions; sell them whenever you like.');
  } else if (next.style !== cur.style || next.budgetPct !== cur.budgetPct) {
    log(userId, 'info', `Settings: ${STYLES[next.style].label} · ${next.budgetPct}% of cash`);
  }
  return next;
}

// ---------- trading ----------
const cooldown = new Map(); // `${userId}:${address}` -> no re-buy until this time
const busyUsers = new Set();

async function sell(userId, bp, pos, fraction, kind, why) {
  const qty = Math.min(bp.qty, pos.qty) * fraction;
  if (!(qty > 0)) return null;
  const percent = clamp((qty / pos.qty) * 100, 0.0001, 100);
  const r = await game.trade(userId, { side: 'sell', address: bp.token, percent, currency: 'USD', bot: true });
  const left = bp.qty - r.qty;
  if (fraction >= 0.999 || left <= bp.qty * 0.001 || r.closed) db.prepare('DELETE FROM bot_positions WHERE user_id = ? AND token = ?').run(userId, bp.token);
  else db.prepare('UPDATE bot_positions SET qty = ?, tp_done = 1 WHERE user_id = ? AND token = ?').run(left, userId, bp.token);
  log(userId, kind, `${why} · sold ${fraction >= 0.999 ? 'all' : `${Math.round(fraction * 100)}%`} of ${r.symbol} for $${r.usdValue.toFixed(2)} (${r.pnlUsd >= 0 ? '+' : '−'}$${Math.abs(r.pnlUsd).toFixed(2)}, ${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(1)}%)`, { symbol: r.symbol, address: bp.token, pnl: r.pnlUsd });
  events.emit('trade', { userId, side: 'sell', symbol: r.symbol, address: bp.token, usd: r.usdValue, pnlUsd: r.pnlUsd, pnlPct: r.pnlPct, why });
  if (kind === 'stop' || kind === 'rug') cooldown.set(`${userId}:${bp.token}`, Date.now() + 2 * 3600_000);
  else cooldown.set(`${userId}:${bp.token}`, Date.now() + 30 * 60_000);
  return r;
}

async function manage(userId, st) {
  const mine = db.prepare('SELECT * FROM bot_positions WHERE user_id = ?').all(userId);
  for (const bp of mine) {
    const pos = db.prepare('SELECT * FROM positions WHERE user_id = ? AND token = ?').get(userId, bp.token);
    const t = market.tokenInfo(bp.token);
    if (!pos || pos.qty <= 1e-12) {
      db.prepare('DELETE FROM bot_positions WHERE user_id = ? AND token = ?').run(userId, bp.token);
      log(userId, 'info', `You closed ${t?.symbol || 'a coin'} yourself, so the bot stopped managing it.`);
      continue;
    }
    if (!t?.priceUsd || Date.now() - (t.updatedAt || 0) > 90_000) continue; // no fresh price: hold, never act on stale data
    const price = t.priceUsd;
    const pnl = (price / bp.entry - 1) * 100;
    if (price > bp.peak * 1.005) { db.prepare('UPDATE bot_positions SET peak = ? WHERE user_id = ? AND token = ?').run(price, userId, bp.token); bp.peak = price; }
    const fromPeak = (price / bp.peak - 1) * 100;
    const cs = candleStats(bp.token);
    const inf = infoFor(bp.token);
    const heldMin = (Date.now() - bp.opened_at) / 60_000;
    try {
      if (bp.entry_liq && t.liquidity && t.liquidity < bp.entry_liq * 0.6) { await sell(userId, bp, pos, 1, 'rug', `Rug warning: liquidity dropped ${Math.round((1 - t.liquidity / bp.entry_liq) * 100)}%`); continue; }
      if (cs && cs.lastMin < -25) { await sell(userId, bp, pos, 1, 'rug', `Rug warning: −${Math.abs(cs.lastMin).toFixed(0)}% in one minute`); continue; }
      if (inf && ((inf.mint && inf.mint !== 'no') || inf.honeypot === 'yes')) { await sell(userId, bp, pos, 1, 'rug', 'Rug warning: contract risk appeared'); continue; }
      if (pnl <= -st.stop) { await sell(userId, bp, pos, 1, 'stop', `Stop-loss at ${pnl.toFixed(1)}%`); continue; }
      const peakGain = (bp.peak / bp.entry - 1) * 100;
      if (!bp.tp_done && peakGain >= st.tp1 / 2 && pnl <= 1) { await sell(userId, bp, pos, 1, 'stop', 'Gave back its gains · sold at break-even'); continue; }
      if (!bp.tp_done && pnl >= st.tp1) { await sell(userId, bp, pos, 0.5, 'profit', `Take-profit hit (+${pnl.toFixed(0)}%)`); continue; }
      if (bp.tp_done && fromPeak <= -st.trail) { await sell(userId, bp, pos, 1, 'profit', `Trailing stop (${fromPeak.toFixed(0)}% from peak)`); continue; }
      if (heldMin > st.maxHoldMin && pnl < 5 && !bp.tp_done) { await sell(userId, bp, pos, 1, 'time', `No momentum after ${Math.round(heldMin)} min`); continue; }
    } catch (e) { noteOnce(userId, `Couldn't sell ${t.symbol} yet (${e.message}). Will retry.`); }
  }
}

async function openNew(userId, st, settings) {
  const u = db.prepare('SELECT usd FROM users WHERE id = ?').get(userId);
  const mine = db.prepare('SELECT bp.token, bp.qty, bp.entry FROM bot_positions bp WHERE bp.user_id = ?').all(userId);
  if (mine.length >= st.maxPositions) return noteOnce(userId, `Holding ${mine.length}/${st.maxPositions} coins · managing exits`);
  const invested = mine.reduce((s, p) => s + p.qty * p.entry, 0);
  const cap = (settings.budgetPct / 100) * (u.usd + invested);
  const size = Math.min(cap / st.maxPositions, cap - invested, u.usd);
  if (size < MIN_TRADE_USD) {
    return noteOnce(userId, u.usd < MIN_TRADE_USD ? 'Out of mock USD. Add funds or sell something (the bot doesn\'t spend SOL).' : 'Its budget is fully invested · waiting for exits');
  }
  const held = new Set(db.prepare('SELECT token FROM positions WHERE user_id = ? AND qty > 0').all(userId).map((r) => r.token));
  const pick = (scans[settings.style] || []).find((c) => c.status === 'buy' && !held.has(c.address) && (cooldown.get(`${userId}:${c.address}`) || 0) < Date.now());
  if (!pick) return noteOnce(userId, 'Scanning · no new coin passes every check right now');
  const t = market.tokenInfo(pick.address);
  try {
    const r = await game.trade(userId, { side: 'buy', address: pick.address, amount: Math.floor(size * 100) / 100, currency: 'USD', bot: true });
    db.prepare(`INSERT INTO bot_positions (user_id, token, qty, entry, peak, entry_liq, tp_done, opened_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
                ON CONFLICT(user_id, token) DO UPDATE SET qty = excluded.qty, entry = excluded.entry, peak = excluded.peak, entry_liq = excluded.entry_liq, tp_done = 0, opened_at = excluded.opened_at`)
      .run(userId, pick.address, r.qty, r.price, r.price, t?.liquidity || null, Date.now());
    notes.delete(userId);
    log(userId, 'buy', `Bought ${r.symbol} for $${r.usdValue.toFixed(2)} · score ${pick.score} (safety ${pick.safety}, momentum ${pick.momentum}) · target +${st.tp1}%, stop −${st.stop}%`, { symbol: r.symbol, address: pick.address });
    events.emit('trade', { userId, side: 'buy', symbol: r.symbol, address: pick.address, usd: r.usdValue, why: `score ${pick.score}` });
  } catch (e) {
    cooldown.set(`${userId}:${pick.address}`, Date.now() + 5 * 60_000);
    noteOnce(userId, `Skipped ${pick.symbol}: ${e.message}`);
  }
}

async function runUser(userId) {
  if (busyUsers.has(userId)) return;
  busyUsers.add(userId);
  try {
    const settings = settingsFor(userId);
    const st = styleOf(settings.style);
    await manage(userId, st);
    if (settings.enabled) {
      if (market.mode === 'starting') return noteOnce(userId, 'Waiting for live prices…');
      await openNew(userId, st, settings);
    }
  } catch (e) {
    noteOnce(userId, `Paused for a moment: ${e.message}`);
  } finally { busyUsers.delete(userId); }
}

async function tick() {
  scan();
  // Only bots that are on do anything. When a player turns theirs off, they're in charge of the coins it bought.
  const users = db.prepare('SELECT user_id FROM bots WHERE enabled = 1').all().map((r) => r.user_id);
  for (const id of users) await runUser(id);
}
let lastViewAt = 0;
function start() {
  setInterval(() => { tick().catch((e) => console.error('bot tick', e)); }, TICK_MS);
  // safety-data lookups only while someone uses the bot (it shares GeckoTerminal's ~30/min allowance)
  setInterval(() => {
    const anyOn = db.prepare('SELECT 1 FROM bots WHERE enabled = 1 LIMIT 1').get();
    if (anyOn || Date.now() - lastViewAt < 120_000) fetchSomeInfo();
  }, 8_000);
}

// ---------- what the player sees ----------
function stats(userId) {
  const r = db.prepare(`SELECT COUNT(*) AS sells, SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS wins, COALESCE(SUM(pnl_usd), 0) AS realized
                        FROM trades WHERE user_id = ? AND bot = 1 AND side = 'sell'`).get(userId);
  const buys = db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND bot = 1 AND side = 'buy'`).get(userId).n;
  return { buys, sells: r.sells, wins: r.wins || 0, realized: r.realized };
}
function view(userId) {
  lastViewAt = Date.now();
  const settings = settingsFor(userId);
  const st = styleOf(settings.style);
  const positions = db.prepare('SELECT * FROM bot_positions WHERE user_id = ? ORDER BY opened_at').all(userId).map((bp) => {
    const t = market.tokenInfo(bp.token) || {};
    const price = t.priceUsd || bp.entry;
    return {
      address: bp.token, symbol: t.symbol || '?', image: t.image || null, qty: bp.qty, entry: bp.entry, price, peak: bp.peak,
      value: bp.qty * price, pnlUsd: bp.qty * (price - bp.entry), pnlPct: (price / bp.entry - 1) * 100, tpDone: Boolean(bp.tp_done), openedAt: bp.opened_at,
      plan: bp.tp_done
        ? `Half sold at target · trailing stop ${st.trail}% under its peak`
        : `Sell half at +${st.tp1}% · stop at −${st.stop}% · exit after ${st.maxHoldMin} min if flat`,
    };
  });
  const styles = Object.fromEntries(Object.entries(STYLES).map(([k, s]) => [k, {
    label: s.label, blurb: s.blurb, maxPositions: s.maxPositions, tp1: s.tp1, stop: s.stop, trail: s.trail,
    rules: [`${s.minHolders}+ holders`, `top 10 wallets ≤ ${s.maxTop10}%`, `dev ≤ ${s.maxDev}%`, `liquidity ≥ ${fmtK(s.minLiq)}`, `${s.minAgeMin}+ min old`],
  }]));
  return {
    settings, styles, positions, stats: stats(userId), log: logs.get(userId) || [],
    scan: (scans[settings.style] || []).slice(0, 25), scannedAt, mode: market.mode,
    needInfo: needInfo(3),
  };
}

module.exports = { start, view, updateSettings, ingestInfo, events, STYLES, runOnce: tick };
