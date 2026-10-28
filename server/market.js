// Live market data: trending Solana memecoins, real-time prices, candles and on-chain trade tape.
//  - GeckoTerminal: which pools are trending, historical 1m candles, recent on-chain trades
//  - DexScreener:   fast live prices for every tracked token (batched 30 per request)
// If the live APIs can't be reached (or MOCK_MARKET=1), it falls back to a clearly-labelled demo market.
const { EventEmitter } = require('node:events');
const { db } = require('./db');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const EXCLUDE = new Set([
  SOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
  'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',  // cbBTC
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH
]);

const CFG = {
  mock: process.env.MOCK_MARKET === '1',
  trendingCount: Number(process.env.TRENDING_COUNT || 20),
  pricePollMs: Number(process.env.PRICE_POLL_MS || 2500),
  trendingRefreshMs: 8_000, // pump.fun's board; the slower fallback lists throttle themselves to once a minute
  maxCandles: 1500, // 1-minute candles kept per token (~25h)
};

const GECKO = 'https://api.geckoterminal.com/api/v2';
const DEX = 'https://api.dexscreener.com';

const events = new EventEmitter();
events.setMaxListeners(0);

const state = {
  mode: CFG.mock ? 'demo' : 'starting', // 'live' | 'demo' | 'starting'
  solPrice: 0,
  solUpdatedAt: 0,
  tokens: new Map(),   // address -> token info
  trending: [],        // ordered addresses
  candles: new Map(),  // address -> [{time, open, high, low, close, volume}] 1m, ascending
  historyLoadedAt: new Map(),
  tape: new Map(),     // address -> recent on-chain trades (newest first)
  seenTx: new Map(),   // address -> Set of tx hashes
  watchers: new Map(), // address -> count of viewers on that token
  liveFailures: 0,
  pending: new Map(),  // big price jumps waiting for a second report
  lastOwnOkAt: 0,      // last time the server fetched prices itself
  lastRelayAt: 0,      // last time a player's browser sent prices
  lastListsAt: 0,      // last time the trending list was refreshed
  log: console.log,
};

// ---------- HTTP helpers ----------
async function getJSON(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'MemeSim/1.0 (paper trading game)' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

// GeckoTerminal allows ~30 requests/min on the free tier, so every call goes through this queue.
const geckoQueue = [];
let geckoBusy = false;
let geckoPausedUntil = 0; // after a "429 too many requests", give GeckoTerminal a rest
function gecko(path) {
  if (Date.now() < geckoPausedUntil) return Promise.reject(new Error('429 from api.geckoterminal.com (cooling down)'));
  return new Promise((resolve, reject) => {
    geckoQueue.push({ path, resolve, reject });
    pumpGecko();
  });
}
async function pumpGecko() {
  if (geckoBusy) return;
  geckoBusy = true;
  while (geckoQueue.length) {
    const job = geckoQueue.shift();
    if (Date.now() < geckoPausedUntil) { job.reject(new Error('429 from api.geckoterminal.com (cooling down)')); continue; }
    try { job.resolve(await getJSON(GECKO + job.path)); }
    catch (e) {
      if (String(e.message).startsWith('429')) geckoPausedUntil = Date.now() + 90_000;
      job.reject(e);
    }
    await sleep(2200);
  }
  geckoBusy = false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// ---------- token bookkeeping ----------
function upsertToken(t) {
  const prev = state.tokens.get(t.address) || {};
  const merged = { ...prev, ...Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined && v !== null)) };
  state.tokens.set(t.address, merged);
  return merged;
}

const saveTokenStmt = db.prepare(`
  INSERT INTO tokens (address, symbol, name, image, pair_address, last_price, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET symbol=excluded.symbol, name=excluded.name,
    image=COALESCE(excluded.image, tokens.image), pair_address=COALESCE(excluded.pair_address, tokens.pair_address),
    last_price=excluded.last_price, updated_at=excluded.updated_at`);
function persistToken(t) {
  if (!t || !t.priceUsd) return;
  saveTokenStmt.run(t.address, t.symbol || '?', t.name || '', t.image || null, t.pairAddress || null, t.priceUsd, t.updatedAt || Date.now());
}

// Load tokens players hold from the DB so their prices keep updating after they leave the trending list.
function heldTokenAddresses() {
  return db.prepare('SELECT DISTINCT token FROM positions WHERE qty > 0').all().map((r) => r.token);
}
function hydrateFromDb() {
  for (const r of db.prepare('SELECT * FROM tokens').all()) {
    if (!state.tokens.has(r.address)) {
      state.tokens.set(r.address, {
        address: r.address, symbol: r.symbol, name: r.name, image: r.image,
        pairAddress: r.pair_address, priceUsd: r.last_price, updatedAt: r.updated_at,
      });
    }
  }
}

// ---------- candles ----------
function pushPriceToCandles(address, price, ts = Date.now(), volume = 0) {
  if (!price) return;
  const minute = Math.floor(ts / 60_000) * 60;
  let arr = state.candles.get(address);
  if (!arr) { arr = []; state.candles.set(address, arr); }
  const last = arr[arr.length - 1];
  if (last && last.time === minute) {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
    last.volume += volume;
  } else if (!last || minute > last.time) {
    const open = last ? last.close : price;
    arr.push({ time: minute, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume });
    if (arr.length > CFG.maxCandles) arr.splice(0, arr.length - CFG.maxCandles);
  }
}

function aggregate(candles, minutes) {
  if (minutes <= 1) return candles;
  const out = [];
  const step = minutes * 60;
  for (const c of candles) {
    const bucket = Math.floor(c.time / step) * step;
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ ...c, time: bucket });
    }
  }
  return out;
}

async function getCandles(address, tfMinutes = 1) {
  if (!state.mock) await ensureHistory(address).catch(() => {});
  return aggregate(state.candles.get(address) || [], tfMinutes);
}

async function ensureHistory(address) {
  if (state.mode !== 'live') return;
  const t = state.tokens.get(address);
  if (!t || !t.pairAddress) return;
  const last = state.historyLoadedAt.get(address) || 0;
  if (Date.now() - last < 10 * 60_000) return;
  state.historyLoadedAt.set(address, Date.now());
  const json = await gecko(`/networks/solana/pools/${t.pairAddress}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=base`);
  const list = json?.data?.attributes?.ohlcv_list || [];
  const hist = list
    .map(([ts, o, h, l, c, v]) => ({ time: Math.floor(ts / 60) * 60, open: +o, high: +h, low: +l, close: +c, volume: +v || 0 }))
    .filter((c) => c.open > 0 && c.close > 0)
    .sort((a, b) => a.time - b.time);
  if (!hist.length) return;
  const live = state.candles.get(address) || [];
  const newestHist = hist[hist.length - 1].time;
  const merged = hist.concat(live.filter((c) => c.time > newestHist));
  state.candles.set(address, merged.slice(-CFG.maxCandles));
}

// ---------- trending list ----------
// Pump.fun coins first. Every coin launched on Pump.fun has a mint address ending in "pump", and
// DexScreener tracks both the Pump.fun launch curve (dexId "pumpfun") and PumpSwap after a coin graduates.
// Candidate coins come from GeckoTerminal's trending list (when it isn't rate-limiting us) plus
// DexScreener's boosted and newest-profile lists; then everything is ranked by live 24h volume.
const PUMP_DEXES = new Set(['pumpfun', 'pumpswap', 'pump-fun']);
const isPumpCoin = (address, dexId) => address.endsWith('pump') || PUMP_DEXES.has(String(dexId || '').toLowerCase());

// ---------- pump.fun's own trending board ----------
// pump.fun's website reads from these endpoints. Browsers can't call them from another site, but the server can.
// We try a few in order and use whichever answers, so a renamed endpoint just falls back to the next one.
const PUMP_API = 'https://frontend-api-v3.pump.fun';
const PUMP_LISTS = [
  '/coins/for-you?offset=0&limit=50&includeNsfw=false',
  '/coins/currently-live?offset=0&limit=50&includeNsfw=false',
  '/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false',
];
const pumpState = { ok: false, list: [], at: 0, endpoint: null, error: null, pausedUntil: 0 };

async function pumpGet(path) {
  const res = await fetch(PUMP_API + path, {
    headers: { accept: 'application/json', origin: 'https://pump.fun', referer: 'https://pump.fun/', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`${res.status} from pump.fun`);
  return res.json();
}

function pumpCoins(json) {
  const raw = Array.isArray(json) ? json : (json?.coins || json?.data || json?.results || []);
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const c = r?.coin || r;
    const mint = c?.mint || c?.address || c?.coinMint;
    if (typeof mint !== 'string' || !BASE58.test(mint) || EXCLUDE.has(mint)) continue;
    const mcap = num(c.usd_market_cap ?? c.usdMarketCap ?? c.marketCap);
    const supply = (num(c.total_supply) || 1e15) / 1e6; // pump.fun coins: 1 billion tokens, 6 decimals
    out.push({
      address: mint, symbol: typeof c.symbol === 'string' ? c.symbol.slice(0, 24) : undefined,
      name: typeof c.name === 'string' ? c.name.slice(0, 64) : undefined,
      image: typeof c.image_uri === 'string' && /^https:\/\//.test(c.image_uri) ? c.image_uri.slice(0, 300) : undefined,
      marketCap: mcap, priceUsd: mcap && supply ? mcap / supply : null,
      createdAt: num(c.created_timestamp) || undefined,
    });
  }
  return out;
}

async function refreshPumpFun() {
  if (Date.now() < pumpState.pausedUntil) return pumpState.ok ? pumpState.list : [];
  const order = pumpState.endpoint ? [pumpState.endpoint, ...PUMP_LISTS.filter((p) => p !== pumpState.endpoint)] : PUMP_LISTS;
  let lastErr;
  for (const path of order) {
    try {
      const coins = pumpCoins(await pumpGet(path));
      if (coins.length < 5) throw new Error('pump.fun list was empty');
      Object.assign(pumpState, { ok: true, list: coins, at: Date.now(), endpoint: path, error: null });
      return coins;
    } catch (e) { lastErr = e; if (/^(403|429)/.test(e.message)) break; }
  }
  pumpState.ok = Date.now() - pumpState.at < 120_000 && pumpState.list.length > 0;
  pumpState.error = lastErr?.message || 'unavailable';
  pumpState.pausedUntil = Date.now() + (/^(403|429)/.test(pumpState.error) ? 120_000 : 20_000);
  return pumpState.ok ? pumpState.list : [];
}

async function refreshTrending() {
  const candidates = [];
  const seen = new Set();
  const add = (a) => { if (a && !EXCLUDE.has(a) && !seen.has(a)) { seen.add(a); candidates.push(a); } };

  // pump.fun's own board, in pump.fun's order. DexScreener adds volume/liquidity/charts where it knows the
  // coin; brand-new coins it hasn't indexed yet still show, priced from pump.fun's market cap.
  const pumpList = await refreshPumpFun().catch(() => []);
  if (pumpList.length) {
    const pairs = await fetchDexTokens(pumpList.slice(0, 60).map((c) => c.address)).catch(() => new Map());
    try { applyPumpTrending(pumpList, pairs); return; } catch { /* fall back to the DexScreener lists */ }
  }
  // pump.fun blocks cloud servers, so the usual source is GeckoTerminal's "trending in the last 5 minutes"
  // list, keeping pump.fun coins. Players' browsers send the same list every ~20s (see relayPlan);
  // the server tries itself at most every 20s too (GeckoTerminal rate-limits shared hosts).
  if (Date.now() - (state.lastDexListsAt || 0) < 20_000 && state.trending.length) return;
  if (Date.now() - (state.lastListsAt || 0) < 15_000 && state.trending.length) return;
  state.lastDexListsAt = Date.now();

  const [geckoList, ...dexLists] = await Promise.allSettled([
    geckoTrendingAddresses(),
    getJSON(`${DEX}/token-boosts/top/v1`),
    getJSON(`${DEX}/token-boosts/latest/v1`),
    getJSON(`${DEX}/token-profiles/latest/v1`),
  ]);
  if (geckoList.status === 'fulfilled') geckoList.value.forEach(add);
  else if (state.lastGeckoNote !== geckoList.reason?.message) {
    state.lastGeckoNote = geckoList.reason?.message;
    console.log(`Trending: GeckoTerminal unavailable (${geckoList.reason?.message}); using DexScreener lists.`);
  }
  for (const l of dexLists) {
    if (l.status !== 'fulfilled' || !Array.isArray(l.value)) continue;
    for (const b of l.value) if (b?.chainId === 'solana') add(b.tokenAddress);
  }
  if (!candidates.length) throw new Error('no trending sources reachable');

  // Pump.fun addresses first (keeping trend order) so they make the cut, then look up live stats for up to 90 coins.
  const order = candidates.filter((a) => a.endsWith('pump')).concat(candidates.filter((a) => !a.endsWith('pump')));
  const pairs = await fetchDexTokens(order.slice(0, 90));
  applyTrending(pairs, geckoList.status === 'fulfilled' ? 'geckoterminal' : 'dexscreener', order);
}

function applyPumpTrending(pumpList, pairs) {
  const now = Date.now();
  const ranked = [];
  for (const c of pumpList) {
    if (ranked.length >= CFG.trendingCount) break;
    const p = pairs.get(c.address);
    if (p && num(p.priceUsd)) {
      upsertToken({
        address: c.address, symbol: p.baseToken.symbol || c.symbol, name: p.baseToken.name || c.name, image: p.info?.imageUrl || c.image,
        pairAddress: state.tokens.get(c.address)?.pairAddress || p.pairAddress, dexId: p.dexId, isPump: true, priceUsd: num(p.priceUsd),
        change5m: num(p.priceChange?.m5), change1h: num(p.priceChange?.h1), change24h: num(p.priceChange?.h24),
        volume24h: num(p.volume?.h24), liquidity: num(p.liquidity?.usd), marketCap: num(p.marketCap) || num(p.fdv) || c.marketCap,
        buys5m: p.txns?.m5?.buys, sells5m: p.txns?.m5?.sells, createdAt: p.pairCreatedAt || c.createdAt, updatedAt: now,
      });
    } else if (c.priceUsd) {
      upsertToken({ ...c, isPump: true, updatedAt: now });
      pushPriceToCandles(c.address, c.priceUsd, now);
    } else continue;
    ranked.push(c.address);
  }
  if (ranked.length < 5) throw new Error('pump.fun list had too few priced coins');
  state.trending = ranked;
  state.trendingSource = 'pump.fun';
  state.lastListsAt = now;
  events.emit('trending', state.trending);
}

// Rank coins from a Map of address -> DexScreener pair: pump.fun coins only (topped up with other Solana
// coins if there are too few), in trending order, then by trades in the last 5 minutes.
function applyTrending(pairs, source, order = []) {
  const alive = [...pairs.values()].filter((p) => {
    if (EXCLUDE.has(p.baseToken.address)) return false;
    if (!num(p.priceUsd)) return false;
    const onCurve = String(p.dexId).toLowerCase() === 'pumpfun'; // launch-curve coins report little/no liquidity
    return onCurve ? (p.volume?.h24 || 0) >= 5000 : (p.liquidity?.usd || 0) >= 5000;
  });
  const rank = new Map(order.map((a, i) => [a, i]));
  const act = (p) => (p.txns?.m5?.buys || 0) + (p.txns?.m5?.sells || 0);
  const byTrend = (a, b) => (rank.get(a.baseToken.address) ?? 1e6) - (rank.get(b.baseToken.address) ?? 1e6) || act(b) - act(a) || (b.volume?.h24 || 0) - (a.volume?.h24 || 0);
  const pump = alive.filter((p) => isPumpCoin(p.baseToken.address, p.dexId)).sort(byTrend);
  const other = alive.filter((p) => !isPumpCoin(p.baseToken.address, p.dexId)).sort(byTrend);
  const ranked = (pump.length >= 10 ? pump : pump.concat(other)).slice(0, CFG.trendingCount);
  if (!ranked.length) throw new Error('no actively traded Solana coins found');

  const now = Date.now();
  for (const p of ranked) {
    const addr = p.baseToken.address;
    upsertToken({
      address: addr, symbol: p.baseToken.symbol, name: p.baseToken.name, image: p.info?.imageUrl,
      pairAddress: state.tokens.get(addr)?.pairAddress || p.pairAddress, dexId: p.dexId,
      isPump: isPumpCoin(addr, p.dexId), priceUsd: num(p.priceUsd),
      change5m: num(p.priceChange?.m5), change1h: num(p.priceChange?.h1), change24h: num(p.priceChange?.h24),
      volume24h: num(p.volume?.h24), liquidity: num(p.liquidity?.usd), marketCap: num(p.marketCap) || num(p.fdv),
      buys5m: p.txns?.m5?.buys, sells5m: p.txns?.m5?.sells, createdAt: p.pairCreatedAt, updatedAt: now,
    });
  }
  state.trending = ranked.map((p) => p.baseToken.address);
  state.trendingSource = source;
  state.lastListsAt = now;
  events.emit('trending', state.trending);
}

// Addresses from GeckoTerminal's Solana trending pools (also remembers each coin's pool for chart history).
async function geckoTrendingAddresses() {
  const json = await gecko('/networks/solana/trending_pools?include=base_token&duration=5m&page=1');
  const included = new Map((json.included || []).map((x) => [x.id, x.attributes || {}]));
  const out = [];
  for (const pool of json.data || []) {
    const baseId = pool.relationships?.base_token?.data?.id;
    const address = included.get(baseId)?.address || (baseId || '').replace(/^solana_/, '');
    if (!address) continue;
    if (!state.tokens.get(address)?.pairAddress && pool.attributes?.address) upsertToken({ address, pairAddress: pool.attributes.address });
    out.push(address);
  }
  return out;
}

// ---------- live prices ----------
async function fetchDexTokens(addresses) {
  const out = new Map();
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    const pairs = await getJSON(`${DEX}/tokens/v1/solana/${batch.join(',')}`);
    for (const p of Array.isArray(pairs) ? pairs : []) {
      const addr = p?.baseToken?.address;
      if (!addr || !batch.includes(addr)) continue;
      const liq = p.liquidity?.usd || 0;
      const prev = out.get(addr);
      if (!prev || liq > (prev.liquidity?.usd || 0)) out.set(addr, p);
    }
  }
  return out;
}

function watchlistAddresses() {
  return db.prepare('SELECT token FROM watchlist GROUP BY token ORDER BY COUNT(*) DESC LIMIT 120').all().map((r) => r.token);
}
function trackedAddresses() {
  const real = (a) => !a.startsWith('DEMO');
  return [...new Set([SOL_MINT, ...heldTokenAddresses().filter(real), ...[...state.watchers.keys()].filter(real),
    ...state.trending.filter(real), ...watchlistAddresses()])].slice(0, 210);
}
// A coin someone just started watching: fetch its details now if we can (players' browsers fill in otherwise).
function rememberToken(address) {
  if (state.tokens.get(address)?.priceUsd || state.mode !== 'live') return;
  lookupToken(address).then((t) => persistToken(t)).catch(() => {});
}

async function pollPrices() {
  const pairs = await fetchDexTokens(trackedAddresses());
  ingestPairs(pairs);
  state.lastOwnOkAt = Date.now();
}

// Apply a Map of address -> DexScreener pair to live prices and candles.
function ingestPairs(pairs) {
  const now = Date.now();
  const changed = [];
  for (const [addr, p] of pairs) {
    const price = num(p.priceUsd);
    if (!price) continue;
    if (addr === SOL_MINT) {
      state.solPrice = price;
      state.solUpdatedAt = now;
      continue;
    }
    const prev = state.tokens.get(addr);
    const t = upsertToken({
      address: addr,
      symbol: p.baseToken.symbol,
      name: p.baseToken.name,
      image: p.info?.imageUrl,
      pairAddress: prev?.pairAddress || p.pairAddress,
      priceUsd: price,
      change5m: num(p.priceChange?.m5),
      change1h: num(p.priceChange?.h1),
      change24h: num(p.priceChange?.h24),
      volume24h: num(p.volume?.h24),
      liquidity: num(p.liquidity?.usd),
      marketCap: num(p.marketCap) || num(p.fdv),
      dexId: p.dexId,
      isPump: isPumpCoin(addr, p.dexId),
      buys5m: p.txns?.m5?.buys,
      sells5m: p.txns?.m5?.sells,
      createdAt: p.pairCreatedAt,
      updatedAt: now,
    });
    pushPriceToCandles(addr, price, now);
    if (!prev || prev.priceUsd !== price) changed.push(publicToken(t));
  }
  persistHeld();
  events.emit('prices', { sol: state.solPrice, tokens: changed, ts: now });
}

let lastPersist = 0;
function persistHeld() {
  if (Date.now() - lastPersist < 30_000) return;
  lastPersist = Date.now();
  for (const a of new Set([...heldTokenAddresses(), ...watchlistAddresses()])) persistToken(state.tokens.get(a));
}

// Look up a token that isn't on the trending list (e.g. pasted address)
async function lookupToken(address) {
  const cur = state.tokens.get(address);
  if (cur?.priceUsd && Date.now() - cur.updatedAt < 60_000) return cur;
  if (CFG.mock || String(address).startsWith('DEMO') || !BASE58.test(address)) return cur || null;
  const p = (await fetchDexTokens([address]).catch(() => new Map())).get(address);
  if (!p) return (await lookupNewCoin(address).catch(() => null)) || cur || null;
  const t = upsertToken({
    address, symbol: p.baseToken.symbol, name: p.baseToken.name, image: p.info?.imageUrl,
    pairAddress: p.pairAddress, priceUsd: num(p.priceUsd), change24h: num(p.priceChange?.h24),
    change1h: num(p.priceChange?.h1), change5m: num(p.priceChange?.m5), volume24h: num(p.volume?.h24),
    liquidity: num(p.liquidity?.usd), marketCap: num(p.marketCap) || num(p.fdv), updatedAt: Date.now(),
  });
  pushPriceToCandles(address, t.priceUsd);
  return t;
}

// Coins DexScreener hasn't listed yet (brand-new pump.fun launches): ask pump.fun, then GeckoTerminal.
async function lookupNewCoin(address) {
  const now = Date.now();
  try {
    const c = pumpCoins([await pumpGet(`/coins/${address}`)])[0];
    if (c?.priceUsd) {
      const t = upsertToken({ ...c, isPump: true, dexId: 'pumpfun', updatedAt: now });
      pushPriceToCandles(address, t.priceUsd, now);
      return t;
    }
  } catch { /* pump.fun unreachable from here */ }
  const j = await gecko(`/networks/solana/tokens/${address}?include=top_pools`);
  const a = j?.data?.attributes;
  const price = num(a?.price_usd);
  if (!price) return null;
  const pool = (j.data.relationships?.top_pools?.data?.[0]?.id || '').replace(/^solana_/, '');
  const t = upsertToken({
    address, symbol: typeof a.symbol === 'string' ? a.symbol.slice(0, 24) : '?', name: typeof a.name === 'string' ? a.name.slice(0, 64) : '',
    image: /^https:\/\//.test(a.image_url || '') ? a.image_url : undefined, pairAddress: BASE58.test(pool) ? pool : undefined,
    priceUsd: price, marketCap: num(a.market_cap_usd) || num(a.fdv_usd), volume24h: num(a.volume_usd?.h24),
    isPump: address.endsWith('pump'), updatedAt: now,
  });
  pushPriceToCandles(address, price, now);
  return t;
}

// ---------- on-chain trade tape for tokens people are watching ----------
async function pollTape() {
  const watched = [...state.watchers.entries()].filter(([, n]) => n > 0).map(([a]) => a);
  for (const address of watched.slice(0, 3)) {
    const t = state.tokens.get(address);
    if (!t?.pairAddress) continue;
    try {
      const json = await gecko(`/networks/solana/pools/${t.pairAddress}/trades`);
      const seen = state.seenTx.get(address) || new Set();
      const fresh = [];
      for (const row of (json.data || []).slice().reverse()) {
        const a = row.attributes || {};
        const id = a.tx_hash || row.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        fresh.push({
          id, side: a.kind === 'sell' ? 'sell' : 'buy', usd: num(a.volume_in_usd) || 0,
          price: num(a.kind === 'sell' ? a.price_from_in_usd : a.price_to_in_usd),
          wallet: a.tx_from_address ? `${a.tx_from_address.slice(0, 4)}…${a.tx_from_address.slice(-4)}` : '',
          ts: a.block_timestamp ? Date.parse(a.block_timestamp) : Date.now(),
        });
      }
      if (seen.size > 500) state.seenTx.set(address, new Set([...seen].slice(-300))); else state.seenTx.set(address, seen);
      if (fresh.length) {
        const tape = (state.tape.get(address) || []);
        tape.unshift(...fresh.reverse());
        state.tape.set(address, tape.slice(0, 60));
        events.emit('tape', { address, trades: fresh });
      }
    } catch { /* tape is a nice-to-have */ }
  }
}

function watch(address, delta) {
  if (!address) return;
  const n = (state.watchers.get(address) || 0) + delta;
  if (n <= 0) state.watchers.delete(address); else state.watchers.set(address, n);
}

// ---------- demo market (offline / testing) ----------
const DEMO = [
  ['BONKZILLA', 'Bonkzilla'], ['GIGACHAD', 'Giga Chad Coin'], ['FROGGO', 'Froggo'], ['MOONCAT', 'Moon Cat'],
  ['WAGMI', 'We All Gonna Make It'], ['PEPEX', 'Pepe Extreme'], ['DOGWIF2', 'Dog Wif Two Hats'], ['RUGPROOF', 'Rug Proof'],
  ['SENDIT', 'Send It'], ['NGMI', 'Not Gonna Make It'], ['LAMBO', 'Lambo Soon'], ['HODL', 'Hodl Forever'],
];
function startDemo() {
  state.mode = 'demo';
  state.solPrice = state.solPrice || 180;
  state.solUpdatedAt = Date.now();
  const now = Date.now();
  state.trending = [];
  DEMO.forEach(([symbol, name], i) => {
    const address = `DEMO${String(i).padStart(2, '0')}${symbol}`.padEnd(32, 'x');
    let price = Math.pow(10, -(2 + (i % 6))) * (1 + Math.random() * 8);
    const candles = [];
    for (let m = 600; m > 0; m--) {
      const o = price;
      price *= Math.exp((Math.random() - 0.495) * 0.03);
      const c = price;
      candles.push({ time: Math.floor((now - m * 60_000) / 60_000) * 60, open: o, close: c,
        high: Math.max(o, c) * (1 + Math.random() * 0.01), low: Math.min(o, c) * (1 - Math.random() * 0.01), volume: Math.random() * 5000 });
    }
    state.candles.set(address, candles);
    upsertToken({ address, symbol, name, priceUsd: price, pairAddress: null, change24h: (Math.random() - 0.4) * 200,
      change1h: (Math.random() - 0.5) * 40, change5m: (Math.random() - 0.5) * 10, volume24h: 1e5 + Math.random() * 5e6,
      liquidity: 5e4 + Math.random() * 1e6, marketCap: 1e5 + Math.random() * 5e7, updatedAt: now, demo: true });
    state.trending.push(address);
  });
  events.emit('trending', state.trending);
}
function tickDemo() {
  const now = Date.now();
  const changed = [];
  state.solPrice *= Math.exp((Math.random() - 0.5) * 0.002);
  state.solUpdatedAt = now;
  for (const address of new Set([...state.trending, ...heldTokenAddresses()])) {
    const t = state.tokens.get(address);
    if (!t?.demo) { if (t) { t.updatedAt = now; } continue; }
    const shock = Math.random() < 0.02 ? (Math.random() - 0.4) * 0.25 : 0;
    const price = t.priceUsd * Math.exp((Math.random() - 0.497) * 0.012 + shock);
    upsertToken({ address, priceUsd: price, updatedAt: now });
    pushPriceToCandles(address, price, now, Math.random() * 300);
    changed.push(publicToken(state.tokens.get(address)));
    if (state.watchers.get(address) && Math.random() < 0.6) {
      const side = Math.random() < 0.5 ? 'buy' : 'sell';
      const trade = { id: `${now}-${Math.random()}`, side, usd: Math.random() ** 3 * 4000, price, wallet: 'demo…' + Math.floor(Math.random() * 9999), ts: now };
      const tape = state.tape.get(address) || [];
      tape.unshift(trade);
      state.tape.set(address, tape.slice(0, 60));
      events.emit('tape', { address, trades: [trade] });
    }
  }
  events.emit('prices', { sol: state.solPrice, tokens: changed, ts: now });
}

// ---------- public shape ----------
function publicToken(t) {
  if (!t) return null;
  return {
    address: t.address, symbol: t.symbol, name: t.name, image: t.image || null, pairAddress: t.pairAddress || null,
    priceUsd: t.priceUsd, change5m: t.change5m ?? null, change1h: t.change1h ?? null, change24h: t.change24h ?? null,
    volume24h: t.volume24h ?? null, liquidity: t.liquidity ?? null, marketCap: t.marketCap ?? null,
    dexId: t.dexId ?? null, isPump: Boolean(t.isPump ?? String(t.address).endsWith('pump')),
    buys5m: t.buys5m ?? null, sells5m: t.sells5m ?? null, createdAt: t.createdAt ?? null, updatedAt: t.updatedAt,
  };
}
// Last ~30 minutes of 1-minute closes, for the small trend lines on coin cards.
function sparkFor(address) {
  const c = state.candles.get(address) || [];
  return c.slice(-30).map((x) => +x.close.toPrecision(5));
}
function snapshot() {
  return {
    mode: state.mode, sol: state.solPrice, source: state.trendingSource || null,
    tokens: state.trending.map((a) => { const t = publicToken(state.tokens.get(a)); return t && { ...t, spark: sparkFor(a) }; }).filter(Boolean),
  };
}
function priceOf(address) {
  const t = state.tokens.get(address);
  return t ? { price: t.priceUsd, updatedAt: t.updatedAt || 0 } : null;
}

// ---------- player-powered prices ----------
// Free hosts share one internet address between many apps, so DexScreener/GeckoTerminal sometimes
// answer "429 too many requests" to the server. When that happens, players' browsers (each with their
// own address) fetch the same public data and send it here. The server prefers its own data whenever
// it can get it, and only asks browsers for help while it's blocked.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function relayPlan() {
  const now = Date.now();
  if (CFG.mock) return { want: false };
  const serverOk = now - (state.lastOwnOkAt || 0) < 15_000;
  const justRelayed = now - (state.lastRelayAt || 0) < 2_500;
  return {
    want: !serverOk && !justRelayed,
    serverBlocked: !serverOk,   // viewers should also send their 1-second price for the coin they have open
    addresses: trackedAddresses(),
    needLists: !pumpState.ok && now - (state.lastListsAt || 0) > 20_000,
  };
}

function cleanPair(p) {
  const addr = p?.baseToken?.address;
  if (!p || p.chainId !== 'solana' || typeof addr !== 'string' || !BASE58.test(addr)) return null;
  const price = num(p.priceUsd);
  if (!(price > 0) || price > 1e9) return null;
  const s = (v, n = 64) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const img = s(p.info?.imageUrl, 300);
  return {
    chainId: 'solana', dexId: s(p.dexId, 32), pairAddress: BASE58.test(p.pairAddress || '') ? p.pairAddress : undefined,
    baseToken: { address: addr, name: s(p.baseToken.name), symbol: s(p.baseToken.symbol, 24) },
    priceUsd: String(price),
    priceChange: { m5: num(p.priceChange?.m5), h1: num(p.priceChange?.h1), h24: num(p.priceChange?.h24) },
    volume: { h24: num(p.volume?.h24) }, liquidity: { usd: num(p.liquidity?.usd) },
    marketCap: num(p.marketCap), fdv: num(p.fdv),
    txns: { m5: { buys: num(p.txns?.m5?.buys), sells: num(p.txns?.m5?.sells) } },
    pairCreatedAt: num(p.pairCreatedAt), info: { imageUrl: img && /^https:\/\//.test(img) ? img : undefined },
  };
}

function ingestRelay(body) {
  if (CFG.mock) return { ok: false };
  const now = Date.now();
  const best = new Map();
  for (const raw of Array.isArray(body?.pairs) ? body.pairs.slice(0, 600) : []) {
    const p = cleanPair(raw);
    if (!p) continue;
    const prev = best.get(p.baseToken.address);
    if (!prev || (p.liquidity.usd || 0) > (prev.liquidity.usd || 0)) best.set(p.baseToken.address, p);
  }
  // Spike guard: a sudden big jump from one report is held until a second report agrees with it,
  // so one player can't instantly fake a price.
  for (const [addr, p] of best) {
    const cur = state.tokens.get(addr) || (addr === SOL_MINT ? { priceUsd: state.solPrice, updatedAt: state.solUpdatedAt } : null);
    const np = num(p.priceUsd);
    if (state.mode !== 'live') continue; // demo prices are made up, so there's nothing real to compare against
    if (!cur?.priceUsd || now - (cur.updatedAt || 0) > 30_000) continue;
    const ratio = np / cur.priceUsd;
    if (ratio < 1.5 && ratio > 0.67) { state.pending.delete(addr); continue; }
    const pend = state.pending.get(addr);
    if (pend && Math.abs(pend.price / np - 1) < 0.1 && now - pend.at >= 5_000) { state.pending.delete(addr); continue; }
    if (!pend || Math.abs(pend.price / np - 1) >= 0.1) state.pending.set(addr, { price: np, at: now });
    best.delete(addr);
  }
  if (body?.pools && typeof body.pools === 'object') {
    for (const [a, pool] of Object.entries(body.pools).slice(0, 100)) {
      if (BASE58.test(a) && BASE58.test(String(pool)) && !state.tokens.get(a)?.pairAddress) upsertToken({ address: a, pairAddress: pool });
    }
  }
  if (Array.isArray(body?.lists) && body.lists.length && !(pumpState.ok && Date.now() - pumpState.at < 60_000)) {
    const order = body.lists.filter((a) => typeof a === 'string' && BASE58.test(a)).slice(0, 120);
    const listed = new Set(order);
    const ranked = new Map([...best].filter(([a]) => listed.has(a)));
    if (ranked.size >= 5) {
      try { applyTrending(ranked, 'geckoterminal', order); } catch { /* not enough data yet */ }
    }
  }
  ingestPairs(best);
  // A one-coin report (someone's live chart) doesn't cover the whole list, so it doesn't count as a full refresh.
  if (best.size > 2 || body?.lists?.length) state.lastRelayAt = now;
  if (state.mode !== 'live' && state.solPrice && state.trending.length && !state.trending[0].startsWith('DEMO')) switchToLive('price data from players\' browsers');
  return { ok: true, accepted: best.size };
}

let liveLoopsStarted = false;
function switchToLive(why) {
  clearInterval(state.demoTimer);
  clearInterval(state.retryTimer);
  state.mode = 'live';
  state.log(`Market: LIVE (${why}).`);
  events.emit('mode', 'live');
  if (!liveLoopsStarted) runLiveLoops(state.log);
}

// ---------- start ----------
async function start(log = console.log) {
  state.log = log;
  hydrateFromDb();
  if (CFG.mock) {
    startDemo();
    setInterval(tickDemo, 1500);
    log('Market: DEMO mode (MOCK_MARKET=1) — prices are simulated.');
    return;
  }
  try {
    await refreshTrending();
    await pollPrices();
    if (!state.solPrice) throw new Error('no SOL price');
    state.mode = 'live';
    log(`Market: LIVE — tracking ${state.trending.length} trending Solana tokens. SOL = $${state.solPrice.toFixed(2)}`);
  } catch (e) {
    log(`Market: could not reach live data (${e.message}). Running DEMO market instead; will keep retrying.`);
    startDemo();
    state.demoTimer = setInterval(tickDemo, 1500);
    state.retryTimer = setInterval(async () => {
      try {
        await refreshTrending();
        await pollPrices();
        if (state.solPrice && state.mode !== 'live') switchToLive('server reached the price sites');
      } catch { /* keep demo running until the server or a player's browser gets data */ }
    }, 60_000);
    return;
  }
  runLiveLoops(log);
}

function runLiveLoops(log) {
  liveLoopsStarted = true;
  let pricesBusy = false;
  let backoffUntil = 0;
  setInterval(async () => {
    if (pricesBusy || Date.now() < backoffUntil) return;
    pricesBusy = true;
    try { await pollPrices(); state.liveFailures = 0; }
    catch (e) {
      // Being rate-limited: back off (up to 2 min) instead of hammering; players' browsers fill in meanwhile.
      state.liveFailures++;
      backoffUntil = Date.now() + Math.min(120_000, 5_000 * 2 ** Math.min(state.liveFailures, 5));
      if (state.liveFailures === 1 || state.liveFailures % 20 === 0) log('Price poll failed:', e.message, '— players\' browsers will supply prices meanwhile.');
    }
    finally { pricesBusy = false; }
  }, CFG.pricePollMs);
  let trendBusy = false;
  setInterval(async () => {
    if (trendBusy) return;
    trendBusy = true;
    try { await refreshTrending(); }
    catch (e) { if (state.lastTrendErr !== e.message) { state.lastTrendErr = e.message; log('Trending refresh failed:', e.message); } }
    finally { trendBusy = false; }
  }, CFG.trendingRefreshMs);
  let tapeBusy = false;
  setInterval(async () => {
    if (tapeBusy) return;
    tapeBusy = true;
    try { await pollTape(); } finally { tapeBusy = false; }
  }, 8000);
}

module.exports = {
  start, events, snapshot, publicToken, priceOf, lookupToken, getCandles, watch, relayPlan, ingestRelay, rememberToken,
  get solPrice() { return state.solPrice; },
  get solUpdatedAt() { return state.solUpdatedAt; },
  get mode() { return state.mode; },
  feedStatus: () => ({ source: state.trendingSource || null, pumpFun: { ok: pumpState.ok, coins: pumpState.list.length, ageSec: pumpState.at ? Math.round((Date.now() - pumpState.at) / 1000) : null, endpoint: pumpState.endpoint, error: pumpState.error } }),
  tapeFor: (a) => state.tape.get(a) || [],
  tokenInfo: (a) => publicToken(state.tokens.get(a)),
  SOL_MINT,
};
