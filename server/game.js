// Game logic: accounts, mock wallet, simulated trades, badges, snapshots and leaderboards.
const crypto = require('node:crypto');
const { db, tx } = require('./db');
const market = require('./market');

const CFG = {
  startingUsd: Number(process.env.STARTING_USD || 1000),
  faucetSol: Number(process.env.FAUCET_SOL || 5),
  faucetCooldownMin: Number(process.env.FAUCET_COOLDOWN_MIN || 0),
  maxDepositUsd: Number(process.env.MAX_DEPOSIT_USD || 1_000_000), // biggest single top-up
  whaleTarget: 50_000,
  snapshotMinutes: Number(process.env.SNAPSHOT_MINUTES || 15),
  maxPriceAgeMs: 90_000,
  sessionDays: 30,
};

class GameError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// ---------------- badges ----------------
const BADGES = {
  diamond_hands: {
    name: 'Diamond Hands', icon: '💎', color: '#4de2ff',
    how: 'Held a single token position for more than 48 hours without selling any of it.',
  },
  whale: {
    name: 'Whale Status', icon: '🐋', color: '#b388ff',
    how: 'Grew your account past $50,000 mock USD. Money you add yourself does not count; only your starting $1,000 plus trading profit.',
  },
  paper_hands: {
    name: 'Paper Hands', icon: '🧻', color: '#ffd23f',
    how: 'Sold a position less than 5 minutes after buying it.',
  },
  moonshot: {
    name: 'Moonshot', icon: '🚀', color: '#a6ff00',
    how: 'Locked in a single sell with more than +500% profit.',
  },
};
const awardStmt = db.prepare('INSERT OR IGNORE INTO badges (user_id, badge, earned_at, detail) VALUES (?, ?, ?, ?)');
const newlyEarned = []; // queued for live "badge unlocked" pushes
function award(userId, badge, detail) {
  const r = awardStmt.run(userId, badge, Date.now(), detail || null);
  if (r.changes) newlyEarned.push({ userId, badge, detail, earnedAt: Date.now() });
}
function takeNewBadges() { return newlyEarned.splice(0); }

function badgesFor(userId) {
  return db.prepare('SELECT badge, earned_at, detail FROM badges WHERE user_id = ? ORDER BY earned_at').all(userId)
    .map((b) => ({ id: b.badge, earnedAt: b.earned_at, detail: b.detail }));
}
function badgeMap() {
  const out = new Map();
  for (const b of db.prepare('SELECT user_id, badge, earned_at, detail FROM badges').all()) {
    if (!out.has(b.user_id)) out.set(b.user_id, []);
    out.get(b.user_id).push({ id: b.badge, earnedAt: b.earned_at, detail: b.detail });
  }
  return out;
}

// ---------------- auth ----------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha(token), userId, Date.now() + CFG.sessionDays * 864e5);
  return token;
}
function userFromSession(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(token), Date.now());
  return row || null;
}
function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

function register({ email, username, password }) {
  email = String(email || '').trim().toLowerCase();
  username = String(username || '').trim();
  password = String(password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) throw new GameError('Enter a valid email address.');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new GameError('Username must be 3–16 letters, numbers or underscores.');
  if (password.length < 8) throw new GameError('Password must be at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new GameError('That email already has an account.', 409);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new GameError('That username is taken.', 409);
  const now = Date.now();
  const id = tx(() => {
    const r = db.prepare(`INSERT INTO users (email, username, pass_hash, created_at, usd, sol, net_deposits)
                          VALUES (?, ?, ?, ?, ?, 0, ?)`).run(email, username, hashPassword(password), now, CFG.startingUsd, CFG.startingUsd);
    const userId = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO snapshots (user_id, ts, value, net_deposits, profit) VALUES (?, ?, ?, ?, 0)')
      .run(userId, now, CFG.startingUsd, CFG.startingUsd);
    return userId;
  });
  return { userId: id, token: createSession(id) };
}

function login({ email, password }) {
  email = String(email || '').trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Always run the hash so response time doesn't reveal whether the email exists.
  const ok = u ? checkPassword(String(password || ''), u.pass_hash) : (checkPassword('x', 'scrypt$00$00'), false);
  if (!u || !ok) throw new GameError('Wrong email or password.', 401);
  return { userId: u.id, token: createSession(u.id) };
}

// ---------------- valuation ----------------
function priceFor(address) {
  const live = market.priceOf(address);
  if (live?.price) return live.price;
  const row = db.prepare('SELECT last_price FROM tokens WHERE address = ?').get(address);
  return row?.last_price || 0;
}

function positionsFor(userId) {
  return db.prepare('SELECT * FROM positions WHERE user_id = ? AND qty > 0 ORDER BY opened_at').all(userId).map((p) => {
    const price = priceFor(p.token);
    const info = market.tokenInfo(p.token) || db.prepare('SELECT symbol, name, image FROM tokens WHERE address = ?').get(p.token) || {};
    const value = p.qty * price;
    const avg = p.qty > 0 ? p.cost_usd / p.qty : 0;
    return {
      address: p.token, symbol: info.symbol || '?', name: info.name || '', image: info.image || null,
      qty: p.qty, avgEntry: avg, costUsd: p.cost_usd, price, value,
      pnlUsd: value - p.cost_usd, pnlPct: p.cost_usd > 0 ? (value / p.cost_usd - 1) * 100 : 0,
      openedAt: p.opened_at, lastBuyAt: p.last_buy_at,
    };
  });
}

function accountValue(user) {
  const sol = market.solPrice || 0;
  const holdings = db.prepare('SELECT token, qty FROM positions WHERE user_id = ? AND qty > 0').all(user.id)
    .reduce((s, p) => s + p.qty * priceFor(p.token), 0);
  const value = user.usd + user.sol * sol + holdings;
  return { value, holdings, profit: value - user.net_deposits };
}

function account(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) throw new GameError('Account not found.', 404);
  const v = accountValue(u);
  if (CFG.startingUsd + v.profit >= CFG.whaleTarget) award(u.id, 'whale', `Traded $1,000 up to $${Math.round(CFG.startingUsd + v.profit).toLocaleString('en-US')}`);
  return {
    id: u.id, username: u.username, email: u.email, createdAt: u.created_at,
    avatar: u.avatar || null, color: u.color || null, bio: u.bio || '',
    usd: u.usd, sol: u.sol, solPrice: market.solPrice, netDeposits: u.net_deposits,
    holdings: v.holdings, value: v.value, profit: v.profit,
    faucet: { amountSol: CFG.faucetSol, cooldownMin: CFG.faucetCooldownMin, nextAt: u.faucet_at + CFG.faucetCooldownMin * 60_000 },
    positions: positionsFor(u.id),
    badges: badgesFor(u.id),
    watchlist: watchlistFor(u.id),
    deposits: db.prepare('SELECT currency, amount, usd_value AS usdValue, ts FROM deposits WHERE user_id = ? ORDER BY ts DESC LIMIT 20').all(u.id),
    maxDepositUsd: CFG.maxDepositUsd,
  };
}

// ---------------- faucet ----------------
function faucet(userId) {
  const sol = market.solPrice;
  if (!sol) throw new GameError('SOL price is not available yet — try again in a few seconds.', 503);
  const now = Date.now();
  return tx(() => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const next = u.faucet_at + CFG.faucetCooldownMin * 60_000;
    if (now < next) throw new GameError(`Faucet is recharging. Try again in ${Math.ceil((next - now) / 1000)}s.`, 429);
    const usdValue = CFG.faucetSol * sol;
    db.prepare('UPDATE users SET sol = sol + ?, net_deposits = net_deposits + ?, faucet_at = ? WHERE id = ?')
      .run(CFG.faucetSol, usdValue, now, userId);
    db.prepare('INSERT INTO deposits (user_id, currency, amount, usd_value, ts) VALUES (?, ?, ?, ?, ?)').run(userId, 'SOL', CFG.faucetSol, usdValue, now);
    return { addedSol: CFG.faucetSol, solPrice: sol, usdValue };
  });
}

// ---------------- add funds (any amount) ----------------
// Added money raises "net deposits", so it never shows up as profit on the leaderboard.
function deposit(userId, body) {
  const currency = body?.currency === 'SOL' ? 'SOL' : 'USD';
  const amount = Number(body?.amount);
  if (!(amount > 0) || !Number.isFinite(amount)) throw new GameError('Enter an amount to add.');
  const sol = market.solPrice;
  if (currency === 'SOL' && !sol) throw new GameError('SOL price is not available yet — try again in a few seconds.', 503);
  const usdValue = currency === 'USD' ? amount : amount * sol;
  if (usdValue < 0.01) throw new GameError('Minimum is $0.01.');
  if (usdValue > CFG.maxDepositUsd) throw new GameError(`Max per top-up is $${CFG.maxDepositUsd.toLocaleString('en-US')} (add more in another top-up).`);
  const now = Date.now();
  tx(() => {
    if (currency === 'USD') db.prepare('UPDATE users SET usd = usd + ?, net_deposits = net_deposits + ? WHERE id = ?').run(amount, usdValue, userId);
    else db.prepare('UPDATE users SET sol = sol + ?, net_deposits = net_deposits + ? WHERE id = ?').run(amount, usdValue, userId);
    db.prepare('INSERT INTO deposits (user_id, currency, amount, usd_value, ts) VALUES (?, ?, ?, ?, ?)').run(userId, currency, amount, usdValue, now);
  });
  return { currency, amount, usdValue, solPrice: sol || null };
}

// ---------------- profile ----------------
const AVATARS = ['🐸', '🐶', '🐱', '🦊', '🐵', '🐼', '🦍', '🐳', '🦈', '🐙', '🦄', '🐲', '👽', '🤖', '💀', '🤡', '😎', '🥷', '🧙', '👑', '💎', '🚀', '🔥', '🌙'];
const COLORS = ['#a6ff00', '#ff2e88', '#00e5ff', '#ffd23f', '#b388ff', '#ff8a3d', '#5ff2a0', '#ffffff'];
function updateProfile(userId, body) {
  const avatar = body?.avatar == null || body.avatar === '' ? null : String(body.avatar);
  const color = body?.color == null || body.color === '' ? null : String(body.color).toLowerCase();
  const bio = String(body?.bio ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 140);
  if (avatar && !AVATARS.includes(avatar)) throw new GameError('Pick one of the avatars shown.');
  if (color && !COLORS.includes(color)) throw new GameError('Pick one of the colors shown.');
  db.prepare('UPDATE users SET avatar = ?, color = ?, bio = ? WHERE id = ?').run(avatar, color, bio, userId);
  return { avatar, color, bio };
}

// What anyone can see about a player (no email).
function publicProfile(username, meId) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!u) throw new GameError('Player not found.', 404);
  const v = accountValue(u);
  const sells = db.prepare(`SELECT COUNT(*) AS n, SUM(pnl_usd > 0) AS wins, MAX(pnl_pct) AS best FROM trades WHERE user_id = ? AND side = 'sell'`).get(u.id);
  return {
    username: u.username, avatar: u.avatar || null, color: u.color || null, bio: u.bio || '',
    createdAt: u.created_at, isMe: u.id === meId,
    value: v.value, profit: v.profit,
    trades: db.prepare('SELECT COUNT(*) AS n FROM trades WHERE user_id = ?').get(u.id).n,
    sells: sells.n || 0, winRate: sells.n ? (sells.wins || 0) / sells.n * 100 : null, bestTradePct: sells.best ?? null,
    badges: badgesFor(u.id),
    positions: positionsFor(u.id).map((p) => ({ address: p.address, symbol: p.symbol, image: p.image, value: p.value, pnlPct: p.pnlPct })),
    recentTrades: db.prepare('SELECT side, symbol, token, usd_value AS usdValue, pnl_pct AS pnlPct, ts FROM trades WHERE user_id = ? ORDER BY ts DESC LIMIT 10').all(u.id),
  };
}

// ---------------- watchlist ----------------
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function watchlistFor(userId) {
  return db.prepare('SELECT w.token, w.added_at, t.symbol, t.name, t.image FROM watchlist w LEFT JOIN tokens t ON t.address = w.token WHERE w.user_id = ? ORDER BY w.added_at DESC').all(userId)
    .map((w) => {
      const live = market.tokenInfo(w.token) || {};
      return {
        address: w.token, addedAt: w.added_at, symbol: live.symbol || w.symbol || '?', name: live.name || w.name || '',
        image: live.image || w.image || null, priceUsd: live.priceUsd ?? priceFor(w.token) ?? null,
        change24h: live.change24h ?? null, change5m: live.change5m ?? null, marketCap: live.marketCap ?? null,
        volume24h: live.volume24h ?? null, isPump: live.isPump ?? w.token.endsWith('pump'), pairAddress: live.pairAddress ?? null,
      };
    });
}
function setWatch(userId, body) {
  const address = String(body?.address || '');
  if (!BASE58.test(address)) throw new GameError('That is not a Solana token address.');
  if (body?.on === false) {
    db.prepare('DELETE FROM watchlist WHERE user_id = ? AND token = ?').run(userId, address);
  } else {
    const n = db.prepare('SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?').get(userId).n;
    if (n >= 50) throw new GameError('Your watchlist is full (50 coins). Remove one first.');
    db.prepare('INSERT OR IGNORE INTO watchlist (user_id, token, added_at) VALUES (?, ?, ?)').run(userId, address, Date.now());
    market.rememberToken(address);
  }
  return watchlistFor(userId);
}

// ---------------- trading ----------------
// body: { address, side: 'buy'|'sell', amount, currency: 'USD'|'SOL', percent? }
// buy:  amount = how much USD or SOL to spend
// sell: amount = how much USD/SOL worth to sell (proceeds paid in that currency), or percent = 1..100 of position
async function trade(userId, body) {
  const side = body.side === 'sell' ? 'sell' : body.side === 'buy' ? 'buy' : null;
  const currency = body.currency === 'SOL' ? 'SOL' : 'USD';
  const address = String(body.address || '');
  if (!side) throw new GameError('Choose buy or sell.');
  if (!address || address.length > 64) throw new GameError('Pick a token first.');

  let p = market.priceOf(address);
  if (!p?.price || Date.now() - p.updatedAt > CFG.maxPriceAgeMs) {
    await market.lookupToken(address).catch(() => null);
    p = market.priceOf(address);
  }
  if (!p?.price) throw new GameError('No live price for this token right now.', 503);
  if (Date.now() - p.updatedAt > CFG.maxPriceAgeMs) throw new GameError('Price feed is stale for this token — try again in a moment.', 503);
  const price = p.price;
  const sol = market.solPrice;
  if (currency === 'SOL' && !sol) throw new GameError('SOL price unavailable.', 503);
  const info = market.tokenInfo(address) || {};
  const now = Date.now();

  const result = tx(() => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const pos = db.prepare('SELECT * FROM positions WHERE user_id = ? AND token = ?').get(userId, address);

    if (side === 'buy') {
      const amount = Number(body.amount);
      if (!(amount > 0)) throw new GameError('Enter an amount to buy.');
      const usdCost = currency === 'USD' ? amount : amount * sol;
      if (usdCost < 0.01) throw new GameError('Minimum trade is $0.01.');
      if (currency === 'USD' && amount > u.usd + 1e-9) throw new GameError(`Not enough mock USD (you have $${u.usd.toFixed(2)}).`);
      if (currency === 'SOL' && amount > u.sol + 1e-12) throw new GameError(`Not enough mock SOL (you have ${u.sol.toFixed(4)} SOL).`);
      const qty = usdCost / price;
      if (currency === 'USD') db.prepare('UPDATE users SET usd = MAX(0, usd - ?) WHERE id = ?').run(amount, userId);
      else db.prepare('UPDATE users SET sol = MAX(0, sol - ?) WHERE id = ?').run(amount, userId);

      if (!pos || pos.qty <= 1e-12) {
        db.prepare(`INSERT INTO positions (user_id, token, qty, cost_usd, opened_at, last_buy_at, sold_since_open)
                    VALUES (?, ?, ?, ?, ?, ?, 0)
                    ON CONFLICT(user_id, token) DO UPDATE SET qty = excluded.qty, cost_usd = excluded.cost_usd,
                      opened_at = excluded.opened_at, last_buy_at = excluded.last_buy_at, sold_since_open = 0`)
          .run(userId, address, qty, usdCost, now, now);
      } else {
        db.prepare('UPDATE positions SET qty = qty + ?, cost_usd = cost_usd + ?, last_buy_at = ? WHERE user_id = ? AND token = ?')
          .run(qty, usdCost, now, userId, address);
      }
      db.prepare(`INSERT INTO trades (user_id, token, symbol, side, qty, price, usd_value, currency, sol_price, ts)
                  VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, ?, ?)`).run(userId, address, info.symbol || '?', qty, price, usdCost, currency, sol || null, now);
      return { side, qty, price, usdValue: usdCost, currency, symbol: info.symbol };
    }

    // sell
    if (!pos || pos.qty <= 1e-12) throw new GameError("You don't hold this token.");
    let qty;
    if (body.percent != null) {
      const pct = Number(body.percent);
      if (!(pct > 0 && pct <= 100)) throw new GameError('Percent must be between 1 and 100.');
      qty = pos.qty * (pct / 100);
    } else {
      const amount = Number(body.amount);
      if (!(amount > 0)) throw new GameError('Enter an amount to sell.');
      const usdWanted = currency === 'USD' ? amount : amount * sol;
      qty = usdWanted / price;
    }
    if (qty > pos.qty * 0.9999) qty = pos.qty; // selling (almost) everything closes the position
    const proceeds = qty * price;
    if (proceeds < 0.000001) throw new GameError('That sell is too small.');
    const avg = pos.cost_usd / pos.qty;
    const costPart = avg * qty;
    const pnlUsd = proceeds - costPart;
    const pnlPct = avg > 0 ? (price / avg - 1) * 100 : 0;
    const remaining = pos.qty - qty;

    db.prepare('UPDATE positions SET qty = ?, cost_usd = ?, sold_since_open = 1 WHERE user_id = ? AND token = ?')
      .run(remaining <= 1e-12 ? 0 : remaining, remaining <= 1e-12 ? 0 : Math.max(0, pos.cost_usd - costPart), userId, address);
    if (currency === 'USD') db.prepare('UPDATE users SET usd = usd + ? WHERE id = ?').run(proceeds, userId);
    else db.prepare('UPDATE users SET sol = sol + ? WHERE id = ?').run(proceeds / sol, userId);
    db.prepare(`INSERT INTO trades (user_id, token, symbol, side, qty, price, usd_value, currency, sol_price, pnl_usd, pnl_pct, ts)
                VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, address, info.symbol || '?', qty, price, proceeds, currency, sol || null, pnlUsd, pnlPct, now);

    if (now - pos.last_buy_at < 5 * 60_000) {
      award(userId, 'paper_hands', `Sold ${info.symbol || 'a token'} ${Math.round((now - pos.last_buy_at) / 1000)}s after buying`);
    }
    if (pnlPct > 500) award(userId, 'moonshot', `+${pnlPct.toFixed(0)}% on ${info.symbol || 'a token'}`);
    return { side, qty, price, usdValue: proceeds, currency, symbol: info.symbol, pnlUsd, pnlPct, closed: remaining <= 1e-12 };
  });
  account(userId); // re-checks whale status
  return result;
}

function myTrades(userId, limit = 50) {
  return db.prepare('SELECT * FROM trades WHERE user_id = ? ORDER BY ts DESC LIMIT ?').all(userId, Math.min(200, limit));
}
function recentFeed(limit = 30) {
  return db.prepare(`SELECT t.side, t.symbol, t.token, t.usd_value, t.price, t.pnl_pct, t.ts, u.username
                     FROM trades t JOIN users u ON u.id = t.user_id ORDER BY t.ts DESC LIMIT ?`).all(limit);
}

// ---------------- periodic jobs ----------------
function checkTimedBadges() {
  const cutoff = Date.now() - 48 * 3600_000;
  for (const r of db.prepare(`SELECT p.user_id, p.token, p.opened_at, t.symbol FROM positions p LEFT JOIN tokens t ON t.address = p.token
                              WHERE p.qty > 0 AND p.sold_since_open = 0 AND p.opened_at < ?`).all(cutoff)) {
    const sym = r.symbol || market.tokenInfo(r.token)?.symbol || 'a token';
    award(r.user_id, 'diamond_hands', `Held ${sym} for ${Math.floor((Date.now() - r.opened_at) / 3600_000)}h without selling`);
  }
  for (const u of db.prepare('SELECT * FROM users').all()) {
    const v = accountValue(u);
    if (CFG.startingUsd + v.profit >= CFG.whaleTarget) award(u.id, 'whale', `Traded $1,000 up to $${Math.round(CFG.startingUsd + v.profit).toLocaleString('en-US')}`);
  }
}

function takeSnapshots() {
  if (!market.solPrice) return 0;
  const now = Date.now();
  const ins = db.prepare('INSERT OR REPLACE INTO snapshots (user_id, ts, value, net_deposits, profit) VALUES (?, ?, ?, ?, ?)');
  const users = db.prepare('SELECT * FROM users').all();
  tx(() => {
    for (const u of users) {
      const v = accountValue(u);
      ins.run(u.id, now, v.value, u.net_deposits, v.profit);
    }
  });
  // Keep fine-grained snapshots for 3 days, then thin older ones to the last snapshot of each UTC day.
  db.prepare(`DELETE FROM snapshots WHERE ts < ? AND (user_id, ts) NOT IN (
                SELECT user_id, MAX(ts) FROM snapshots WHERE ts < ? GROUP BY user_id, ts / 86400000)`)
    .run(now - 3 * 864e5, now - 3 * 864e5);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return users.length;
}

function snapshotsFor(userId, sinceMs) {
  return db.prepare('SELECT ts, value, profit FROM snapshots WHERE user_id = ? AND ts >= ? ORDER BY ts').all(userId, sinceMs);
}

// ---------------- leaderboard ----------------
const RANGES = { '24h': 864e5, '30d': 30 * 864e5, '60d': 60 * 864e5, all: null };
function leaderboard(range, meId) {
  if (!(range in RANGES)) range = '24h';
  const span = RANGES[range];
  const start = span ? Date.now() - span : null;
  const badges = badgeMap();
  const baseAt = start == null ? null : db.prepare('SELECT profit FROM snapshots WHERE user_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1');
  const earliest = db.prepare('SELECT profit FROM snapshots WHERE user_id = ? ORDER BY ts ASC LIMIT 1');

  const rows = db.prepare('SELECT * FROM users').all().map((u) => {
    const v = accountValue(u);
    let baseline = 0;
    if (start != null) {
      if (u.created_at >= start) baseline = 0; // joined during the window: everything counts
      else baseline = (baseAt.get(u.id, start) || earliest.get(u.id) || { profit: 0 }).profit;
    }
    const gain = v.profit - baseline;
    const base = u.net_deposits + baseline;
    return {
      userId: u.id, username: u.username, avatar: u.avatar || null, color: u.color || null, value: v.value, profit: gain,
      profitPct: base > 0 ? (gain / base) * 100 : 0,
      badges: badges.get(u.id) || [],
    };
  });
  rows.sort((a, b) => b.profit - a.profit || a.userId - b.userId);
  rows.forEach((r, i) => { r.rank = i + 1; });
  const me = rows.find((r) => r.userId === meId) || null;
  return { range, total: rows.length, top: rows.slice(0, 100).map(({ userId, ...r }) => ({ ...r, isMe: userId === meId })), me: me && (({ userId, ...r }) => ({ ...r, isMe: true }))(me) };
}

module.exports = {
  CFG, BADGES, AVATARS, COLORS, GameError, register, deposit, updateProfile, publicProfile, setWatch, login, userFromSession, destroySession, account, faucet, trade,
  myTrades, recentFeed, leaderboard, snapshotsFor, takeSnapshots, checkTimedBadges, takeNewBadges, badgesFor,
};
