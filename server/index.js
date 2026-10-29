// MemeSim server — zero dependencies, just Node.js 22+.
// Start with:  npm start   (then open http://localhost:3000)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const market = require('./market');
const game = require('./game');
const cloud = require('./cloud');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const SECURE_COOKIES = process.env.SECURE_COOKIES === '1'; // turn on when hosted behind https

// ---------- small helpers ----------
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
function readBody(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new game.GameError('Request too large.', 413)); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new game.GameError('Bad JSON.')); } });
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(token, maxAgeSec) {
  return `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE_COOKIES ? '; Secure' : ''}`;
}
const limits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (limits.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  limits.set(key, hits);
  return hits.length <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of limits) if (!v.some((t) => now - t < 3600_000)) limits.delete(k); }, 600_000);

// Behind a host like Render, the visitor's real address arrives in x-forwarded-for.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ip = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

// ---------- static files ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html'); // SPA fallback
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    // Code and styles: browsers must check for a newer version on every visit, so updates show up right away.
    'cache-control': ext === '.png' || ext === '.ico' ? 'public, max-age=86400' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    ...(ext === '.html' ? { 'content-security-policy': "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' https://api.dexscreener.com https://api.geckoterminal.com; frame-src https://www.geckoterminal.com https://dexscreener.com; frame-ancestors 'none'" } : {}),
  });
  fs.createReadStream(file).pipe(res);
}

// ---------- live stream (Server-Sent Events) ----------
const clients = new Set();
function broadcast(event, data, filter) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) if (!filter || filter(c)) c.res.write(msg);
}
market.events.on('prices', (d) => broadcast('prices', d));
market.events.on('trending', () => broadcast('trending', market.snapshot()));
market.events.on('mode', () => broadcast('trending', market.snapshot()));
market.events.on('tape', (d) => broadcast('tape', d, (c) => c.watch === d.address));
setInterval(() => {
  for (const b of game.takeNewBadges()) broadcast('badge', { badge: b.badge, detail: b.detail, earnedAt: b.earnedAt }, (c) => c.userId === b.userId);
}, 1000);
setInterval(() => broadcast('ping', Date.now()), 20_000);

function openStream(req, res, url, user) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  const client = { res, userId: user?.id || null, watch: url.searchParams.get('watch') || null };
  clients.add(client);
  market.watch(client.watch, +1);
  res.write(`event: trending\ndata: ${JSON.stringify(market.snapshot())}\n\n`);
  if (client.watch) res.write(`event: tape\ndata: ${JSON.stringify({ address: client.watch, trades: market.tapeFor(client.watch).slice().reverse(), initial: true })}\n\n`);
  req.on('close', () => { clients.delete(client); market.watch(client.watch, -1); });
}

// ---------- API routes ----------
async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const sid = cookies(req).sid;
  const user = game.userFromSession(sid);
  const needUser = () => { if (!user) throw new game.GameError('Please log in.', 401); return user; };

  // Basic CSRF protection: state-changing requests must come from this site.
  if (m === 'POST') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new game.GameError('Bad origin.', 403);
  }

  if (p === '/api/auth/register' && m === 'POST') {
    if (!rateLimit(`auth:${ip(req)}`, 20, 15 * 60_000)) throw new game.GameError('Too many attempts — wait a few minutes.', 429);
    const { token } = game.register(await readBody(req));
    return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(token, 30 * 86400) });
  }
  if (p === '/api/auth/login' && m === 'POST') {
    if (!rateLimit(`auth:${ip(req)}`, 20, 15 * 60_000)) throw new game.GameError('Too many attempts — wait a few minutes.', 429);
    const { token } = game.login(await readBody(req));
    return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(token, 30 * 86400) });
  }
  if (p === '/api/auth/logout' && m === 'POST') {
    game.destroySession(sid);
    return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
  }

  if (p === '/api/market' && m === 'GET') return send(res, 200, market.snapshot());
  if (p === '/api/relay/plan' && m === 'GET') return send(res, 200, market.relayPlan());
  if (p === '/api/relay' && m === 'POST') {
    if (!rateLimit(`relay:${ip(req)}`, 150, 60_000)) throw new game.GameError('Too many price reports.', 429);
    return send(res, 200, market.ingestRelay(await readBody(req, 3_000_000)));
  }
  if (p === '/api/health' && m === 'GET') {
    const s = cloud.status;
    return send(res, 200, { ok: true, market: market.mode, feed: market.feedStatus(), cloudSave: s.enabled ? { on: true, pending: s.pending, lastSyncAt: s.lastSyncAt, error: s.lastError } : { on: false } });
  }
  if (p === '/api/badges' && m === 'GET') return send(res, 200, game.BADGES);
  if (p === '/api/feed' && m === 'GET') return send(res, 200, game.recentFeed(40));

  let match;
  if ((match = p.match(/^\/api\/token\/([A-Za-z0-9]{20,64})$/)) && m === 'GET') {
    const t = (await market.lookupToken(match[1]).catch(() => null)) && market.tokenInfo(match[1]);
    if (!t) throw new game.GameError('Token not found on Solana.', 404);
    return send(res, 200, { token: t, tape: market.tapeFor(match[1]).slice(0, 40) });
  }
  if ((match = p.match(/^\/api\/holders\/([A-Za-z0-9]{20,64})$/)) && m === 'GET') {
    if (!rateLimit(`holders:${ip(req)}`, 30, 60_000)) throw new game.GameError('Slow down a little.', 429);
    const d = await market.topHolders(match[1]).catch(() => null);
    if (!d) throw new game.GameError('Holder list is not set up on this server.', 501);
    return send(res, 200, d);
  }
  if ((match = p.match(/^\/api\/candles\/([A-Za-z0-9]{20,64})$/)) && m === 'GET') {
    const tf = Math.max(1, Math.min(240, Number(url.searchParams.get('tf')) || 1));
    return send(res, 200, await market.getCandles(match[1], tf));
  }

  if (p === '/api/stream' && m === 'GET') return openStream(req, res, url, user);

  if (p === '/api/me' && m === 'GET') {
    if (!user) return send(res, 200, { user: null, mode: market.mode });
    return send(res, 200, { user: game.account(user.id), mode: market.mode });
  }
  if (p === '/api/me/trades' && m === 'GET') return send(res, 200, game.myTrades(needUser().id, Number(url.searchParams.get('limit')) || 50));
  if (p === '/api/me/realized' && m === 'GET') {
    const days = Math.max(1, Math.min(800, Number(url.searchParams.get('days')) || 400));
    return send(res, 200, game.realizedFor(needUser().id, Date.now() - days * 864e5));
  }
  if (p === '/api/me/snapshots' && m === 'GET') {
    const days = Math.min(400, Math.max(1, Number(url.searchParams.get('days')) || 120));
    return send(res, 200, game.snapshotsFor(needUser().id, Date.now() - days * 864e5));
  }
  if (p === '/api/faucet' && m === 'POST') return send(res, 200, game.faucet(needUser().id));
  if (p === '/api/reset' && m === 'POST') {
    const u = needUser();
    if (!rateLimit(`reset:${u.id}`, 5, 3_600_000)) throw new game.GameError('You can restart up to 5 times an hour.', 429);
    return send(res, 200, { user: game.resetAccount(u.id, await readBody(req)) });
  }
  if (p === '/api/deposit' && m === 'POST') {
    const u = needUser();
    if (!rateLimit(`deposit:${u.id}`, 30, 60_000)) throw new game.GameError('Slow down — too many top-ups per minute.', 429);
    const r = game.deposit(u.id, await readBody(req));
    return send(res, 200, { deposit: r, user: game.account(u.id) });
  }
  if (p === '/api/profile' && m === 'POST') {
    const u = needUser();
    if (!rateLimit(`profile:${u.id}`, 20, 60_000)) throw new game.GameError('Slow down a little.', 429);
    game.updateProfile(u.id, await readBody(req, 300_000));
    return send(res, 200, { user: game.account(u.id) });
  }
  if (p === '/api/watchlist' && m === 'POST') {
    const u = needUser();
    if (!rateLimit(`watch:${u.id}`, 60, 60_000)) throw new game.GameError('Slow down a little.', 429);
    return send(res, 200, { watchlist: game.setWatch(u.id, await readBody(req)) });
  }
  if ((match = p.match(/^\/api\/avatar\/(\d{1,10})$/)) && m === 'GET') {
    const f = game.photoFile(match[1]);
    if (!f) throw new game.GameError('No picture.', 404);
    res.writeHead(200, { 'content-type': f.mime, 'content-length': f.bytes.length, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
    return res.end(f.bytes);
  }
  if (p === '/api/options' && m === 'GET') return send(res, 200, { avatars: game.AVATARS, colors: game.COLORS, maxDepositUsd: game.CFG.maxDepositUsd });
  if ((match = p.match(/^\/api\/players\/([A-Za-z0-9_]{3,16})$/)) && m === 'GET') return send(res, 200, game.publicProfile(match[1], user?.id));
  if (p === '/api/trade' && m === 'POST') {
    const u = needUser();
    if (!rateLimit(`trade:${u.id}`, 40, 60_000)) throw new game.GameError('Slow down — too many trades per minute.', 429);
    const r = await game.trade(u.id, await readBody(req));
    const feedItem = { side: r.side, symbol: r.symbol, usd_value: r.usdValue, price: r.price, pnl_pct: r.pnlPct ?? null, ts: Date.now(), username: u.username };
    broadcast('feed', feedItem);
    return send(res, 200, { trade: r, user: game.account(u.id) });
  }
  if (p === '/api/leaderboard' && m === 'GET') return send(res, 200, game.leaderboard(url.searchParams.get('range') || '24h', user?.id));

  throw new game.GameError('Not found.', 404);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e instanceof game.GameError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'Something went wrong on the server.' });
  }
});

async function main() {
  const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
  try {
    await cloud.start(log); // loads saved data from Turso before anyone can log in
  } catch {
    process.exit(1);
  }
  await market.start(log);
  game.takeSnapshots();
  game.checkTimedBadges();
  setInterval(() => game.takeSnapshots(), game.CFG.snapshotMinutes * 60_000);
  setInterval(() => game.checkTimedBadges(), 60_000);
  server.listen(PORT, () => {
    console.log(`\n  🟢 MemeSim is running →  http://localhost:${PORT}\n`);
  });
}
main();
