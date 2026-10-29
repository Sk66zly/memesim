// MemeSim front-end — vanilla JS, no build step.
import { CandleChart } from './chart.js';

// ================= helpers =================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isMobile = () => matchMedia('(max-width: 860px)').matches;
const isDrawer = () => matchMedia('(max-width: 860px)').matches;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? { credentials: 'same-origin' } : {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error(data?.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}

const SUBS = '₀₁₂₃₄₅₆₇₈₉';
function fmtPrice(p) {
  if (p == null || !isFinite(p) || p <= 0) return '—';
  if (p >= 1000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 1) return '$' + p.toFixed(4).replace(/0{1,2}$/, '');
  if (p >= 0.001) return '$' + p.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  const zeros = Math.floor(-Math.log10(p)) - 1; // zeros after "0."
  const digits = Math.round(p * Math.pow(10, zeros + 4)).toString().slice(0, 4);
  return '$0.0' + String(zeros).split('').map((d) => SUBS[d]).join('') + digits;
}
function fmtUsd(n, { sign = false, compact = false } = {}) {
  if (n == null || !isFinite(n)) return '—';
  const s = sign ? (n > 0 ? '+' : n < 0 ? '−' : '') : n < 0 ? '−' : '';
  const a = Math.abs(n);
  let body;
  if (compact && a >= 1e9) body = (a / 1e9).toFixed(2) + 'B';
  else if (compact && a >= 1e6) body = (a / 1e6).toFixed(2) + 'M';
  else if (compact && a >= 1e4) body = (a / 1e3).toFixed(1) + 'K';
  else body = a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${s}$${body}`;
}
function fmtPct(n, digits = 2) {
  if (n == null || !isFinite(n)) return '—';
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}%`;
}
function fmtQty(q) {
  if (!isFinite(q)) return '—';
  const a = Math.abs(q);
  if (a >= 1e9) return (q / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (q / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (q / 1e3).toFixed(2) + 'K';
  if (a >= 1) return q.toFixed(2);
  return q.toPrecision(3);
}
const fmtSol = (n) => (n == null || !isFinite(n) ? '—' : `◎${n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 3 })}`);
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'muted');
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function coinImg(t, cl = 'coin-img') {
  const letter = esc((t?.symbol || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 1) || '?');
  const ph = `<span class="${cl} ph" style="background:hsl(${hue(t?.symbol)} 90% 60%)">${letter}</span>`;
  if (!t?.image) return ph;
  return `<img class="${cl}" src="${esc(t.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-ph="${esc(letter)}" data-h="${hue(t?.symbol)}">`;
}
document.addEventListener('error', (e) => { // swap broken logos for a placeholder
  const img = e.target;
  if (img.tagName === 'IMG' && img.dataset.ph) {
    const span = document.createElement('span');
    span.className = img.className + ' ph';
    span.style.background = `hsl(${img.dataset.h} 90% 60%)`;
    span.textContent = img.dataset.ph;
    img.replaceWith(span);
  }
}, true);
function flashEl(el, dir) {
  if (!el || !dir) return;
  const c = dir > 0 ? 'flash-up' : 'flash-down';
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth;
  el.classList.add(c);
}
function flashText(el, dir) {
  if (!el || !dir) return;
  el.classList.remove('txt-up', 'txt-down');
  void el.offsetWidth;
  el.classList.add(dir > 0 ? 'txt-up' : 'txt-down');
}

function toast(html, type = '', ms = 3800) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = html;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, ms);
  return t;
}

// ================= state =================
const S = {
  user: null,
  mode: 'starting',
  sol: 0,
  tokens: new Map(),
  trending: [],
  selected: null,
  tf: 1,             // candle size in seconds (1s like pump.fun)
  scale: 'mcap',
  query: '',
  onCoin: false,
  serverBlocked: false,
  side: 'buy',
  cur: 'USD',
  sellPercent: null,
  sort: 'hot',
  view: 'trending',
  lbRange: '24h',
  badgeDefs: {},
  feed: [],
  snapshots: [],
  calMonth: (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })(),
  lastPnl: new Map(),
  myTokenTrades: [],
  tapeSeen: new Set(),
  lastTapeAt: 0,
  trades: [],        // on-chain trades for the open coin (oldest first)
  tradeIds: new Set(),
  pairs: new Map(),   // address -> latest full DexScreener pair
  info: new Map(),    // address -> GeckoTerminal token info
  pool: new Map(),    // address -> GeckoTerminal pool stats
  statsTf: 'h24',
  tape: 'live',
  cview: (() => { try { return localStorage.getItem('memesim.cview') || 'live'; } catch { return 'live'; } })(),
};
let chart = null;
let es = null;

// ================= live stream =================
function connectStream() {
  if (es) es.close();
  const url = '/api/stream' + (S.selected ? `?watch=${encodeURIComponent(S.selected)}` : '');
  es = new EventSource(url);
  es.addEventListener('trending', (e) => {
    const d = JSON.parse(e.data);
    setMode(d.mode);
    if (d.sol) S.sol = d.sol;
    S.trending = d.tokens.map((t) => t.address);
    S.source = d.source || null;
    const allPump = d.tokens.length && d.tokens.every((t) => t.isPump);
    $('#listTitle').textContent = S.source === 'pump.fun' || allPump ? 'Hot pump.fun coins' : 'Trending on Solana';
    for (const t of d.tokens) S.tokens.set(t.address, { ...S.tokens.get(t.address), ...t });
    renderCoinList();
    renderTicker();
    renderHomeSide();
    if (d.mode === 'live' && String(S.selected || '').startsWith('DEMO') && S.trending.length && S.view === 'trending' && S.onCoin) {
      location.replace(`#coin/${S.trending[0]}`);
    }
  });
  es.addEventListener('prices', (e) => onPrices(JSON.parse(e.data)));
  es.addEventListener('tape', (e) => {
    const d = JSON.parse(e.data);
    if (d.address !== S.selected) return;
    addTrades(d.trades, !d.initial);
  });
  es.addEventListener('feed', (e) => {
    S.feed.unshift(JSON.parse(e.data));
    S.feed = S.feed.slice(0, 30);
    renderTicker(true);
  });
  es.addEventListener('badge', (e) => onBadge(JSON.parse(e.data)));
}

function setMode(mode) {
  S.mode = mode;
  const b = $('#modeBadge');
  b.textContent = mode === 'demo' ? 'DEMO DATA' : 'LIVE';
  b.classList.toggle('demo', mode === 'demo');
  b.title = mode === 'demo' ? 'Live market APIs are unreachable — showing simulated prices.' : 'Prices stream live from Solana DEXes.';
}

// The open coin's price comes from its newest on-chain trade; slower feeds (DexScreener, the server)
// must not drag it back to an older value for a few seconds afterwards.
const tradePriced = (addr) => addr === S.selected && Date.now() - (S.tokens.get(addr)?.tradePriceAt || 0) < 15_000;
function keepTradePrice(addr, next) {
  if (!tradePriced(addr)) return next;
  const prev = S.tokens.get(addr);
  return { ...next, priceUsd: prev.priceUsd, marketCap: prev.marketCap, tradePriceAt: prev.tradePriceAt, tradeTs: prev.tradeTs };
}
function onPrices({ sol, tokens }) {
  if (sol) S.sol = sol;
  for (let t of tokens) {
    const prev = S.tokens.get(t.address);
    t = keepTradePrice(t.address, { ...prev, ...t });
    const dir = prev?.priceUsd ? Math.sign(t.priceUsd - prev.priceUsd) : 0;
    S.tokens.set(t.address, t);
    updateCoinRow(t.address, dir);
    if (t.address === S.selected) onSelectedTick(t, dir);
  }
  if (S.user) {
    for (const p of S.user.positions) {
      const live = S.tokens.get(p.address)?.priceUsd;
      if (live) { p.price = live; p.value = p.qty * live; p.pnlUsd = p.value - p.costUsd; p.pnlPct = p.costUsd > 0 ? (p.value / p.costUsd - 1) * 100 : 0; }
    }
    recomputeAccount();
    renderAcct();
    renderPositions();
    updateEstimate();
  }
}

function recomputeAccount() {
  const u = S.user;
  if (!u) return;
  u.solPrice = S.sol || u.solPrice;
  u.holdings = u.positions.reduce((s, p) => s + p.value, 0);
  u.value = u.usd + u.sol * u.solPrice + u.holdings;
  u.profit = u.value - u.netDeposits;
}

// ================= header / account =================
function renderAcct() {
  const el = $('#acct');
  if (!S.user) {
    if (el.dataset.state !== 'guest') {
      el.dataset.state = 'guest';
      el.innerHTML = `<button class="login-btn" data-auth="login">Log in</button>`;
    }
    return;
  }
  const u = S.user;
  if (el.dataset.state !== 'user') {
    el.dataset.state = 'user';
    el.innerHTML = `
      <button class="faucet-btn" id="hdrFunds" title="Add mock money to your wallet">＋ Funds</button>
      <a class="bal-chip" href="#profile">
        <span class="v" id="hdrVal"></span><span class="p" id="hdrPnl"></span>
      </a>
      <a class="hdr-av" href="#profile" id="hdrAv" aria-label="Your profile"></a>`;
    $('#hdrFunds').addEventListener('click', () => openFunds());
  }
  const avKey = `${u.photoUrl}|${u.avatar}|${u.color}`;
  if ($('#hdrAv').dataset.key !== avKey) { $('#hdrAv').dataset.key = avKey; $('#hdrAv').innerHTML = avatarHtml(u, 'md'); }
  const v = $('#hdrVal');
  const nv = fmtUsd(u.value);
  if (v.textContent !== nv) { flashText(v, Math.sign(u.value - (+v.dataset.n || u.value))); v.textContent = nv; v.dataset.n = u.value; }
  const p = $('#hdrPnl');
  p.className = `p ${cls(u.profit)}`;
  p.textContent = `${fmtUsd(u.profit, { sign: true })} all-time`;
  updateFaucetButtons();
}

function updateFaucetButtons() {
  if (!S.user) return;
  const left = Math.max(0, S.user.faucet.nextAt - Date.now());
  const amt = S.user.faucet.amountSol;
  const usd = amt * (S.sol || S.user.solPrice || 0);
  const big = $('#pfFaucet');
  if (big) {
    big.disabled = left > 0;
    big.textContent = left > 0 ? `Recharging · ${fmtCountdown(left)}` : `💧 Free drop +${amt} SOL (≈ ${fmtUsd(usd)})`;
  }
}
const fmtCountdown = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
setInterval(updateFaucetButtons, 1000);

async function claimFaucet() {
  if (!S.user) return openAuth('signup');
  try {
    const r = await api('/api/faucet', {});
    toast(`💧 <b>+${r.addedSol} mock SOL</b> added<br><span class="muted">≈ ${fmtUsd(r.usdValue)} at SOL ${fmtUsd(r.solPrice)}</span>`, 'info');
    await refreshMe();
  } catch (e) { toast(esc(e.message), 'err'); }
}

async function refreshMe() {
  const d = await api('/api/me');
  setMode(d.mode);
  const had = S.user;
  S.user = d.user;
  if (S.user && S.user.solPrice) S.sol = S.sol || S.user.solPrice;
  mergeWatchlist();
  renderAcct();
  renderHomeSide();
  renderPositions();
  updateBalances();
  updateEstimate();
  if (S.selected) updateChartLines();
  renderCoinList();
  updateWatchBtn();
  if (S.view === 'profile') renderProfile();
  if (!had !== !S.user) connectStream(); // reconnect so badge pushes reach us
}

// ================= coin list =================
function watchedSet() { return new Set((S.user?.watchlist || []).map((w) => w.address)); }
function mergeWatchlist() {
  for (const w of S.user?.watchlist || []) {
    const cur = S.tokens.get(w.address);
    if (!cur?.priceUsd) S.tokens.set(w.address, { ...w, ...(cur || {}) , priceUsd: cur?.priceUsd ?? w.priceUsd });
  }
}
function sortedTrending() {
  if (S.sort === 'watch') return (S.user?.watchlist || []).map((w) => S.tokens.get(w.address) || w);
  const list = S.trending.map((a) => S.tokens.get(a)).filter(Boolean);
  const by = { gainers: 'change24h', m5: 'change5m', volume: 'volume24h' }[S.sort];
  if (by) list.sort((a, b) => (b[by] ?? -Infinity) - (a[by] ?? -Infinity));
  return list;
}
function renderCoinList() {
  const rows = $('#coinRows');
  const q = (S.query || '').toLowerCase();
  const list = sortedTrending().filter((t) => !q || `${t.symbol} ${t.name}`.toLowerCase().includes(q));
  $('#coinCount').textContent = `${list.length} coins`;
  renderFeatured();
  const held = new Set((S.user?.positions || []).map((p) => p.address));
  const watched = watchedSet();
  if (!list.length) {
    rows.innerHTML = `<div class="grid-empty">${S.sort === 'watch'
      ? (S.user ? 'Nothing on your watchlist yet. Open any coin and tap <b>☆ Watch</b> to track it here.' : '<button class="link-btn" data-auth="signup">Make an account</button> to keep a watchlist.')
      : q ? `No trending coin matches “${esc(S.query)}”. Paste a token address to open any Solana coin.` : 'Loading trending coins…'}</div>`;
    return;
  }
  rows.innerHTML = list.map((t, i) => `
    <button class="coin-card" role="listitem" data-addr="${esc(t.address)}">
      <span class="cc-img">${coinImg(t, 'coin-img lg')}<span class="cc-rank">#${i + 1}</span></span>
      <span class="cc-body">
        <span class="cc-top"><b class="cc-name">${esc(t.name || t.symbol)}</b><span class="cc-tick">$${esc(t.symbol)}</span></span>
        <span class="cc-mc">market cap: <b data-f="mc">${fmtUsd(t.marketCap, { compact: true })}</b></span>
        <span class="cc-tags">${t.isPump ? '<span class="pump-tag">pump</span>' : ''}${held.has(t.address) ? '<span class="held-dot">held</span>' : ''}${watched.has(t.address) ? '<span class="star-on" title="On your watchlist">★</span>' : ''}<span class="muted">vol ${fmtUsd(t.volume24h, { compact: true })}</span></span>
      </span>
      <span class="cc-right">
        ${sparkSvg(t.spark, t.change24h)}
        <span class="cc-price" data-f="price">${fmtPrice(t.priceUsd)}</span>
        <span class="chg-pill ${cls(t.change24h)}" data-f="chg">${fmtPct(t.change24h, 1)}</span>
      </span>
    </button>`).join('');
}
function sparkSvg(spark, chg, w = 84, h = 30) {
  if (!spark || spark.length < 2) return `<svg class="spark" width="${w}" height="${h}" aria-hidden="true"></svg>`;
  const lo = Math.min(...spark), hi = Math.max(...spark);
  const pts = spark.map((v, i) => `${(i / (spark.length - 1) * w).toFixed(1)},${(h - 3 - (hi > lo ? (v - lo) / (hi - lo) : 0.5) * (h - 6)).toFixed(1)}`).join(' ');
  const up = spark[spark.length - 1] >= spark[0];
  return `<svg class="spark ${up ? 'up' : 'down'}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function renderFeatured() {
  const t = S.tokens.get(S.trending[0]);
  const box = $('#featured');
  if (!t) { box.innerHTML = '<div class="grid-empty">Finding the hottest coin…</div>'; return; }
  const key = `${t.address}|${fmtUsd(t.marketCap, { compact: true })}|${(t.spark || []).length}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = `
    <button class="feat-inner" data-addr="${esc(t.address)}">
      <span class="feat-label">#1 trending</span>
      <span class="feat-row">
        ${coinImg(t, 'coin-img xl')}
        <span class="feat-body">
          <span class="feat-name">${esc(t.name || t.symbol)} <span class="cc-tick">$${esc(t.symbol)}</span>${t.isPump ? ' <span class="pump-tag">pump</span>' : ''}</span>
          <span class="feat-mc">${fmtUsd(t.marketCap, { compact: true })} <small>market cap</small></span>
          <span class="feat-stats"><span class="chg-pill ${cls(t.change24h)}">${fmtPct(t.change24h, 1)} 24h</span><span class="muted">vol ${fmtUsd(t.volume24h, { compact: true })}</span><span class="muted">liq ${fmtUsd(t.liquidity, { compact: true })}</span></span>
        </span>
        <span class="feat-spark">${sparkSvg(t.spark, t.change24h, 220, 70)}</span>
      </span>
      <span class="feat-cta">Trade</span>
    </button>`;
}
function renderHomeSide() {
  const box = $('#homeSide');
  if (!box) return;
  if (!S.user) {
    box.innerHTML = `<div class="hs-title">Paper trading on live Solana markets</div>
      <p class="muted">Live Solana prices. $1,000 of fake money to start. Zero risk.</p>
      <button class="exec buy" data-auth="signup">Create free account</button>
      <button class="link-btn" data-auth="login">I already have one</button>`;
    return;
  }
  const u = S.user;
  box.innerHTML = `<div class="hs-user">${avatarHtml(u, 'md')}<div><b>${esc(u.username)}</b><div class="muted small">${u.positions.length} open position${u.positions.length === 1 ? '' : 's'}</div></div></div>
    <div class="hs-val">${fmtUsd(u.value)}</div>
    <div class="${cls(u.profit)} hs-pnl">${fmtUsd(u.profit, { sign: true })} all-time</div>
    <div class="hs-actions"><button class="btn-soft" id="hsFunds">＋ Add funds</button><a class="btn-ghost" href="#profile">My profile</a></div>`;
  $('#hsFunds').addEventListener('click', () => openFunds());
}
function updateCoinRow(addr, dir) {
  const row = $(`.coin-card[data-addr="${CSS.escape(addr)}"]`);
  if (!row) return;
  const t = S.tokens.get(addr);
  row.querySelector('[data-f="price"]').textContent = fmtPrice(t.priceUsd);
  row.querySelector('[data-f="mc"]').textContent = fmtUsd(t.marketCap, { compact: true });
  const chg = row.querySelector('[data-f="chg"]');
  chg.textContent = fmtPct(t.change24h, 1);
  chg.className = `chg-pill ${cls(t.change24h)}`;
  flashEl(row, dir);
}

$('#coinRows').addEventListener('click', (e) => {
  const row = e.target.closest('.coin-card');
  if (row) location.hash = `coin/${row.dataset.addr}`;
});
$('#featured').addEventListener('click', (e) => {
  const b = e.target.closest('[data-addr]');
  if (b) location.hash = `coin/${b.dataset.addr}`;
});
$$('.sort-chips .chip').forEach((b) => b.addEventListener('click', () => {
  S.sort = b.dataset.sort;
  $$('.sort-chips .chip').forEach((x) => x.setAttribute('aria-pressed', x === b));
  renderCoinList();
}));
// Search: typing filters the trending grid; pasting an address opens that coin.
// Finds a Solana address in whatever was pasted: a bare CA, a pump.fun / DexScreener / Solscan link, etc.
function extractAddr(text) {
  const m = String(text || '').match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
  return m ? m.sort((a, b) => b.length - a.length)[0] : null;
}
$('#caInput').addEventListener('input', () => {
  const v = $('#caInput').value.trim();
  const a = extractAddr(v);
  if (a && a.length >= 32 && (v.length >= 32)) { $('#caInput').value = ''; $('#caInput').blur(); S.query = ''; location.hash = `coin/${a}`; return; }
  S.query = v;
  if (S.view !== 'trending' || S.onCoin) location.hash = 'trending';
  renderCoinList();
});
$('#caSearch').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#caInput').value.trim();
  const a = extractAddr(v);
  if (a) { $('#caInput').value = ''; S.query = ''; location.hash = `coin/${a}`; return; }
  const first = $('.coin-card');
  if (first) { $('#caInput').value = ''; S.query = ''; location.hash = `coin/${first.dataset.addr}`; }
  else toast('No coin matches that. Paste a Solana token address to open any coin.', 'err');
});

// ================= coin page =================
async function selectToken(addr) {
  const changed = S.selected !== addr;
  S.selected = addr;
  S.onCoin = true;
  S.sellPercent = null;
  $('#homeView').hidden = true;
  $('#coinView').hidden = false;

  if (!S.tokens.get(addr)?.priceUsd) {
    $('#tokSym').textContent = 'Looking up coin…';
    $('#tokName').textContent = shortAddr(addr);
    $('#tokMeta').innerHTML = ''; $('#tokMeta').dataset.key = '';
    $('#tokImg').style.display = 'none';
    let tok = null;
    for (let i = 0; i < 7 && !tok?.priceUsd; i++) {
      if (i) await new Promise((r) => setTimeout(r, 5000));
      if (addr !== S.selected) return;
      try { tok = (await api(`/api/token/${addr}`)).token; } catch { /* the server couldn't reach it; try from this browser */ }
      if (!tok?.priceUsd) {
        const r = await browserLookup(addr).catch(() => null);
        if (r?.redirect) { location.replace(`#coin/${r.redirect}`); return; }
        tok = r || tok;
      }
      if (!tok?.priceUsd && i === 1) toast('Brand-new coins can take a few seconds to show up. Still looking…', 'info', 4000);
    }
    if (addr !== S.selected) return;
    if (!tok?.priceUsd) { toast("Couldn't find a live price for that address. Make sure it's a Solana token address (CA) that has been traded.", 'err', 7000); location.hash = 'trending'; return; }
    S.tokens.set(addr, { ...S.tokens.get(addr), ...tok });
  }
  if (!chart) {
    chart = new CandleChart($('#chartWrap'), { formatPrice: (v) => chartFmt(v), onActivate: activateTrade });
    chart.setMode('candles');
  }
  renderTermHead();
  if (changed) {
    chart.setData([]);
    chart.setEmpty('loading trades…');
    S.lastFeedPrice = null;
    $('#tapeRows').innerHTML = `<div class="tape-empty">Loading on-chain trades…</div>`;
    S.tapeSeen = new Set();
    S.lastTapeAt = 0;
    S.trades = [];
    S.tradeIds = new Set();
    tradeKey.addr = addr; tradeKey.newest = 0;
    $('#holdersPane').innerHTML = ''; $('#tradersPane').innerHTML = '';
    connectStream();
    loadCandles();
    loadMyTokenTrades();
    loadCoinInfo(addr);
    pollTrades();
    feedTick();
  }
  updateLegend();
  renderSidePanels();
  setChartView(S.cview);
  applyChartScale();
  updateChartLines();
  renderPositions();
  updateBalances();
  updateEstimate();
  window.scrollTo({ top: 0 });
}

// Market cap view: multiply price by circulating supply (market cap ÷ price).
function supplyOf(t) { return t?.marketCap && t?.priceUsd ? t.marketCap / t.priceUsd : 0; }
function chartFmt(v) { return S.scale === 'mcap' && chart?.mult > 1 ? fmtUsd(v, { compact: true }) : fmtPrice(v).replace('$', ''); }
function applyChartScale() {
  if (!chart) return;
  const s = supplyOf(S.tokens.get(S.selected));
  const mult = S.scale === 'mcap' && s ? s : 1;
  if (Math.abs(mult / (chart.mult || 1) - 1) > 0.02) chart.setValueScale(mult);
}

const TF_LABEL = { 1: '1s', 15: '15s', 60: '1m', 300: '5m', 900: '15m', 3600: '1h', 14400: '4h', 86400: 'D' };
function updateLegend() {
  const t = S.tokens.get(S.selected);
  if (!chart || !t) return;
  const what = S.scale === 'mcap' ? 'Market Cap' : 'Price';
  chart.setLegend(`${t.symbol || '?'}/SOL ${what} (USD) · ${TF_LABEL[S.tf] || ''} · ${t.isPump ? 'Pump' : (t.dexId || 'DEX')}`, S.tf);
}

// Candles from individual on-chain trades (1s / 15s), like pump.fun's live chart.
function tradeCandles(trades, tf) {
  const out = [];
  let cur = null;
  for (const x of trades) {
    const time = Math.floor(x.ts / 1000 / tf) * tf;
    if (!cur || time !== cur.time) {
      cur = { time, open: cur ? cur.close : x.price, high: x.price, low: x.price, close: x.price, volume: 0 };
      cur.high = Math.max(cur.high, cur.open); cur.low = Math.min(cur.low, cur.open);
      out.push(cur);
    }
    cur.high = Math.max(cur.high, x.price); cur.low = Math.min(cur.low, x.price);
    cur.close = x.price; cur.volume += x.usd || 0;
  }
  return out;
}
function redrawTradeChart() {
  if (!chart || S.tf >= 60) return;
  const c = tradeCandles(S.trades, S.tf);
  chart.setEmpty(S.trades.length ? 'loading…' : 'waiting for the first trade…');
  chart.setData(c, { keepView: true });
}

async function loadCandles() {
  const addr = S.selected;
  updateLegend();
  if (S.tf < 60) { redrawTradeChart(); return; }
  const tfMin = S.tf / 60;
  chart.setData([]);
  chart.setEmpty('loading candles…');
  try {
    let candles = tfMin <= 240 ? await api(`/api/candles/${addr}?tf=${tfMin}`) : [];
    if (addr !== S.selected) return;
    if (candles.length < 60) {
      const hist = await browserHistory(addr, tfMin).catch(() => []);
      if (addr !== S.selected) return;
      const firstLive = candles.length ? candles[0].time : Infinity;
      candles = hist.filter((c) => c.time < firstLive).concat(candles);
    }
    if (S.tf / 60 !== tfMin) return;
    chart.setEmpty('no candles yet');
    chart.setData(candles);
  } catch { chart.setEmpty('no candles yet'); }
}
async function loadMyTokenTrades() {
  if (!S.user) { S.myTokenTrades = []; renderMyTrades(); return; }
  try { S.myTokenTrades = (await api('/api/me/trades?limit=200')).filter((t) => t.token === S.selected); } catch { S.myTokenTrades = []; }
  renderMyTrades();
}
function renderMyTrades() {
  chart?.setMarkers((S.myTokenTrades || []).map((t) => ({ t: t.ts, side: t.side })));
  const box = $('#myTradesRows');
  const list = S.myTokenTrades || [];
  box.innerHTML = list.length ? list.map((t) => `<div class="tape-row">
      <span class="side-tag ${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? 'Buy' : 'Sell'}</span>
      <span class="muted">${fmtQty(t.qty)} @ ${fmtPrice(t.price)}</span>
      <span class="usd r ${t.side === 'buy' ? 'up' : 'down'}">${fmtUsd(t.usd_value)}${t.side === 'sell' && t.pnl_usd != null ? ` <small class="${cls(t.pnl_usd)}">${fmtPct(t.pnl_pct, 0)}</small>` : ''}</span>
      <span class="t r">${ago(t.ts)}</span></div>`).join('')
    : `<div class="tape-empty">${S.user ? 'You haven\'t traded this coin yet.' : 'Log in to see your trades.'}</div>`;
}
$$('.ctab').forEach((b) => b.addEventListener('click', () => {
  $$('.ctab').forEach((x) => x.setAttribute('aria-selected', x === b));
  S.tape = b.dataset.tape;
  $$('.tape-pane').forEach((p) => { p.hidden = p.dataset.pane !== S.tape; });
  if (S.tape === 'mine') renderMyTrades();
  if (S.tape === 'holders') renderHoldersPane();
  if (S.tape === 'traders') renderTraders();
}));

function renderTermHead() {
  const t = S.tokens.get(S.selected);
  if (!t) return;
  const img = $('#tokImg');
  if (t.image) { img.src = t.image; img.style.display = ''; img.referrerPolicy = 'no-referrer'; img.onerror = () => { img.style.display = 'none'; }; }
  else img.style.display = 'none';
  $('#tokSym').textContent = t.name || t.symbol || '?';
  $('#tokName').textContent = '$' + (t.symbol || '?');
  const isDemo = String(t.address).startsWith('DEMO');
  const metaKey = `${t.address}|${t.isPump}|${t.pairAddress}`;
  if ($('#tokMeta').dataset.key !== metaKey) {
    $('#tokMeta').dataset.key = metaKey;
    $('#tokMeta').innerHTML = `${isDemo ? '<span class="pump-tag demo">demo coin</span>' : `<button class="addr-chip" data-copy="${esc(t.address)}" title="Copy token address">${esc(t.address.slice(0, 4))}…${esc(t.address.slice(-4))} ⧉</button>`}
      ${t.isPump ? '<span class="pump-tag">pump.fun</span>' : ''}
      ${isDemo ? '' : `<span class="ext-links">${t.isPump ? `<a href="https://pump.fun/coin/${encodeURIComponent(t.address)}" target="_blank" rel="noopener">pump.fun ↗</a>` : ''}<a href="https://dexscreener.com/solana/${encodeURIComponent(t.pairAddress || t.address)}" target="_blank" rel="noopener">dexscreener ↗</a></span>`}`;
  }
  setFlash($('#tokMcap'), fmtUsd(t.marketCap, { compact: true }), t.marketCap);
  setFlash($('#tokPrice'), fmtPrice(t.priceUsd), t.priceUsd);
  $('#tokVol').textContent = fmtUsd(t.volume24h, { compact: true });
  const chg = $('#tokChg');
  chg.textContent = fmtPct(t.change24h, 1);
  chg.className = `v ${cls(t.change24h)}`;
  const info = S.info.get(t.address);
  $('#tokHolders').textContent = info?.holders?.count ? fmtInt(info.holders.count) : '—';
  const ath = athOf(t.address);
  $('#tokAth').textContent = ath ? fmtUsd(ath, { compact: true }) : '—';
  document.title = `${t.symbol} ${fmtUsd(t.marketCap, { compact: true })} · MemeSim`;
  updateWatchBtn();
  renderEmbed();
}
function setFlash(el, text, n) {
  if (el.textContent === text) return;
  const prev = Number(el.dataset.n);
  el.textContent = text;
  if (Number.isFinite(prev) && n !== prev) flashText(el, Math.sign(n - prev));
  el.dataset.n = n;
}
document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-copy]');
  if (!c) return;
  try { await navigator.clipboard.writeText(c.dataset.copy); toast('Address copied', 'info', 1500); } catch { toast(esc(c.dataset.copy), 'info', 6000); }
});

function onSelectedTick(t, dir) {
  renderTermHead();
  applyChartScale();
  renderSidePanels();
  if (!chart || !t.priceUsd) return;
  if (S.tf >= 60 && !(Date.now() - (S.tradeFeedAt || 0) < 12_000)) {
    const step = S.tf;
    const bucket = Math.floor(Date.now() / 1000 / step) * step;
    const last = chart.data[chart.data.length - 1];
    if (last && last.time === bucket) chart.update({ ...last, high: Math.max(last.high, t.priceUsd), low: Math.min(last.low, t.priceUsd), close: t.priceUsd });
    else if (!last || bucket > last.time) chart.update({ time: bucket, open: last ? last.close : t.priceUsd, high: t.priceUsd, low: t.priceUsd, close: t.priceUsd, volume: 0 });
  }
}

function updateChartLines() {
  if (!chart) return;
  const p = S.user?.positions.find((x) => x.address === S.selected);
  chart.setLines(p ? [{ price: p.avgEntry, label: 'Your entry', color: '#7dd3fc' }] : []);
}

// ---- chart type: embedded real-time chart (default) or our own chart with your entry + trades ----
function setChartView(v) {
  S.cview = v === 'mine' ? 'mine' : 'live';
  try { localStorage.setItem('memesim.cview', S.cview); } catch { /* private mode */ }
  $('#chartCard').dataset.cview = S.cview;
  $$('.cview').forEach((b) => b.setAttribute('aria-pressed', b.dataset.cview === S.cview));
  if (S.cview === 'live') renderEmbed(); else chart?.resize();
}
function renderEmbed() {
  const box = $('#embedWrap');
  const t = S.tokens.get(S.selected);
  if (!box || !t || S.cview !== 'live') return;
  const pool = t.pairAddress;
  let src = '';
  if (pool && !String(t.address).startsWith('DEMO')) {
    src = `https://www.geckoterminal.com/solana/pools/${encodeURIComponent(pool)}?embed=1&info=0&swaps=0&light_chart=0&chart_type=market_cap&resolution=1s`;
  }
  if (box.dataset.src === src && box.firstElementChild) return;
  box.dataset.src = src;
  box.innerHTML = src
    ? `<iframe src="${esc(src)}" title="Live chart for ${esc(t.symbol || '')}" allow="clipboard-write" referrerpolicy="strict-origin-when-cross-origin"></iframe>`
    : `<div class="embed-empty">${String(t.address).startsWith('DEMO') ? 'Demo coins only have the My trades view.' : 'Finding this coin\'s pool…'}<br><button class="link-btn" data-cview="mine">Open My trades view</button></div>`;
}
$$('.cview').forEach((b) => b.addEventListener('click', () => setChartView(b.dataset.cview)));
document.addEventListener('click', (e) => { const b = e.target.closest('.embed-empty [data-cview]'); if (b) setChartView(b.dataset.cview); });

$$('.tf').forEach((b) => b.addEventListener('click', () => {
  S.tf = Number(b.dataset.tf);
  $$('.tf').forEach((x) => x.setAttribute('aria-pressed', x === b));
  chart?.resetView();
  loadCandles();
}));
$$('.scale').forEach((b) => b.addEventListener('click', () => {
  S.scale = b.dataset.scale;
  $$('.scale').forEach((x) => x.setAttribute('aria-pressed', x === b));
  if (chart) chart.setValueScale(1);
  applyChartScale();
  updateLegend();
}));
$('#resetView').addEventListener('click', () => chart?.resetView());

// ---- 1-second live feed for the open coin ----
// Reads the coin's live pair straight from DexScreener every second (from this browser), moves the chart,
// and, while the server is being rate-limited, hands the price to the server so trades use it too.
let feedBusy = false;
let lastOpenRelay = 0;
async function feedTick() {
  const addr = S.selected;
  if (feedBusy || document.hidden || !S.onCoin || !addr || String(addr).startsWith('DEMO')) return;
  feedBusy = true;
  try {
    const pair = await dexPairFor(addr);
    if (!pair || addr !== S.selected) return;
    const price = Number(pair.priceUsd);
    if (!(price > 0)) return;
    applyLivePair(addr, pair);
    // Keep the server's price for this coin fresh, so your trades fill at the price you're looking at.
    if (!tradePriced(addr) && (S.serverBlocked || Date.now() - lastOpenRelay > 3000)) { lastOpenRelay = Date.now(); api('/api/relay', { pairs: [slimPair(pair)] }).catch(() => {}); }
  } catch { /* busy; next second */ } finally { feedBusy = false; }
}
setInterval(feedTick, 1000);

// ---- home page: every trending coin's price, refreshed every second from this browser ----
let homeBusy = false;
async function homeTick() {
  if (homeBusy || document.hidden || S.view !== 'trending' || S.onCoin) return;
  const addrs = S.trending.filter((a) => !String(a).startsWith('DEMO')).slice(0, 30);
  if (!addrs.length) return;
  homeBusy = true;
  try {
    const arr = await getJ(`${DEX}/tokens/v1/solana/${addrs.join(',')}`);
    const best = new Map();
    for (const p of Array.isArray(arr) ? arr : []) {
      const a = p?.baseToken?.address;
      if (!addrs.includes(a) || !(Number(p.priceUsd) > 0)) continue;
      if (!best.has(a) || (p.liquidity?.usd || 0) > (best.get(a).liquidity?.usd || 0)) best.set(a, p);
    }
    for (const [a, p] of best) {
      const prev = S.tokens.get(a);
      if (prev?.priceUsd === Number(p.priceUsd) && prev?.change5m === p.priceChange?.m5) continue;
      applyLivePair(a, p);
    }
    // other sort orders (top 24h, movers, volume) re-rank live
    const order = sortedTrending().map((t) => t.address).join(',');
    const shown = [...document.querySelectorAll('#coinRows .coin-card')].map((el) => el.dataset.addr).join(',');
    if (!S.query && shown && order !== shown) renderCoinList(); else renderFeatured();
  } catch { /* busy; next second */ } finally { homeBusy = false; }
}
setInterval(homeTick, 1000);

// The coin's best DexScreener pair (null if DexScreener doesn't list it yet, e.g. a brand-new pump.fun coin).
async function dexPairFor(addr) {
  const t = S.tokens.get(addr);
  if (t?.pairAddress && !t.geckoOnly) {
    const j = await getJ(`${DEX}/latest/dex/pairs/solana/${t.pairAddress}`).catch(() => null);
    const p = j?.pairs?.[0] || j?.pair;
    if (p?.baseToken?.address === addr) return p;
  }
  const arr = await getJ(`${DEX}/tokens/v1/solana/${addr}`).catch(() => null);
  return (Array.isArray(arr) ? arr : []).filter((p) => p?.baseToken?.address === addr && p.chainId === 'solana')
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
}

// Fold a live price update into the page: header, chart, coin card and your position.
function applyLivePair(addr, pair) {
  const price = Number(pair.priceUsd);
  if (pair.txns) S.pairs.set(addr, pair);
  const prev = S.tokens.get(addr) || {};
  const next = {
    ...prev, priceUsd: price, change5m: pair.priceChange?.m5 ?? prev.change5m, change1h: pair.priceChange?.h1 ?? prev.change1h,
    change24h: pair.priceChange?.h24 ?? prev.change24h, volume24h: pair.volume?.h24 ?? prev.volume24h, liquidity: pair.liquidity?.usd ?? prev.liquidity,
    marketCap: pair.marketCap || pair.fdv || prev.marketCap, buys5m: pair.txns?.m5?.buys ?? prev.buys5m, sells5m: pair.txns?.m5?.sells ?? prev.sells5m,
    pairAddress: prev.pairAddress || pair.pairAddress, updatedAt: Date.now(),
  };
  if (prev.priceUsd && prev.marketCap && !pair.marketCap && !pair.fdv) next.marketCap = prev.marketCap * price / prev.priceUsd;
  const final = keepTradePrice(addr, next);
  const dir = prev.priceUsd ? Math.sign(final.priceUsd - prev.priceUsd) : 0;
  S.tokens.set(addr, final);
  if (addr === S.selected) { priceTick(addr, final.priceUsd); onSelectedTick(final, dir); }
  updateCoinRow(addr, dir);
  repricePosition(addr, final.priceUsd);
}
function repricePosition(addr, price) {
  const p = S.user?.positions.find((x) => x.address === addr);
  if (!p) return;
  p.price = price; p.value = p.qty * price; p.pnlUsd = p.value - p.costUsd; p.pnlPct = p.costUsd > 0 ? (p.value / p.costUsd - 1) * 100 : 0;
  recomputeAccount(); renderAcct(); renderPositions(); updateEstimate();
}

// Look a coin up from this browser (DexScreener, then GeckoTerminal for coins DexScreener hasn't listed yet)
// and hand it to the server, so any Solana / pump.fun token address can be opened and traded.
async function browserLookup(addr) {
  let pair = await dexPairFor(addr);
  if (!pair) {
    // maybe it's a pool/pair address (e.g. from a DexScreener link): open its coin instead
    const pj = await getJ(`${DEX}/latest/dex/pairs/solana/${addr}`).catch(() => null);
    const pp = pj?.pairs?.[0] || pj?.pair;
    if (pp?.baseToken?.address && pp.baseToken.address !== addr) return { redirect: pp.baseToken.address };
  }
  if (!pair) {
    const j = await getJ(`${GT}/networks/solana/tokens/${addr}?include=top_pools`).catch(() => null);
    const a = j?.data?.attributes;
    const price = Number(a?.price_usd);
    if (!a || !(price > 0)) return null;
    const pool = (j.data.relationships?.top_pools?.data?.[0]?.id || '').replace(/^solana_/, '') || undefined;
    pair = {
      chainId: 'solana', dexId: addr.endsWith('pump') ? 'pumpfun' : 'unknown', pairAddress: pool,
      baseToken: { address: addr, name: a.name, symbol: a.symbol }, priceUsd: String(price),
      marketCap: Number(a.market_cap_usd) || Number(a.fdv_usd) || undefined, fdv: Number(a.fdv_usd) || undefined,
      volume: { h24: Number(a.volume_usd?.h24) || undefined }, info: { imageUrl: /^https:/.test(a.image_url || '') ? a.image_url : undefined },
      geckoOnly: true,
    };
  }
  await api('/api/relay', { pairs: [slimPair(pair)] }).catch(() => {});
  return {
    address: addr, symbol: pair.baseToken.symbol, name: pair.baseToken.name, image: pair.info?.imageUrl || null,
    pairAddress: pair.pairAddress || null, priceUsd: Number(pair.priceUsd), marketCap: pair.marketCap || pair.fdv || null,
    change5m: pair.priceChange?.m5 ?? null, change1h: pair.priceChange?.h1 ?? null, change24h: pair.priceChange?.h24 ?? null,
    volume24h: pair.volume?.h24 ?? null, liquidity: pair.liquidity?.usd ?? null, dexId: pair.dexId,
    isPump: addr.endsWith('pump') || /pump/.test(String(pair.dexId)), createdAt: pair.pairCreatedAt || null,
    geckoOnly: !!pair.geckoOnly, updatedAt: Date.now(),
  };
}

function updateWatchBtn() {
  const b = $('#watchBtn');
  if (!b) return;
  const on = watchedSet().has(S.selected);
  b.setAttribute('aria-pressed', on);
  b.textContent = on ? '★' : '☆';
  b.title = on ? 'On your watchlist' : 'Add to watchlist';
  b.hidden = !S.selected || String(S.selected).startsWith('DEMO');
}
async function toggleWatch(address = S.selected) {
  if (!S.user) return openAuth('signup');
  const on = !watchedSet().has(address);
  try {
    const r = await api('/api/watchlist', { address, on });
    S.user.watchlist = r.watchlist;
    mergeWatchlist();
    updateWatchBtn();
    renderCoinList();
    if (S.view === 'profile') renderMyCoins();
    const sym = S.tokens.get(address)?.symbol || 'Coin';
    toast(on ? `★ <b>${esc(sym)}</b> added to your watchlist` : `${esc(sym)} removed from your watchlist`, 'info', 2200);
  } catch (e) { toast(esc(e.message), 'err'); }
}
$('#watchBtn').addEventListener('click', () => toggleWatch());
$('#backBtn').addEventListener('click', () => { location.hash = 'trending'; });

// ---------- tape ----------
function addTape(trades, fresh) {
  trades = trades.filter((t) => { const id = t.id || `${t.ts}${t.usd}`; if (S.tapeSeen.has(id)) return false; S.tapeSeen.add(id); return true; });
  if (!trades.length) return;
  S.lastTapeAt = Date.now();
  const box = $('#tapeRows');
  if (box.querySelector('.tape-empty')) box.innerHTML = '';
  const html = trades.slice().reverse().map((t) => {
    const big = t.usd >= 1000;
    const who = t.trader ? `<a class="mono" href="${solscan(t.trader)}" target="_blank" rel="noopener">${esc(t.wallet)}</a>` : `<span class="muted">${esc(t.wallet || '')}</span>`;
    return `<div class="tape-row ${big ? 'big' : ''} ${fresh ? 'fresh-' + t.side : ''}">
      <span class="side-tag ${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? 'Buy' : 'Sell'}</span>
      ${who}
      <span class="r mono">${t.qty ? fmtQty(t.qty) : '—'}</span>
      <span class="usd ${t.side === 'buy' ? 'up' : 'down'}">${fmtUsd(t.usd, { compact: true })}</span>
      <span class="t" data-ts="${t.ts}">${ago(t.ts)}</span>
    </div>`;
  }).join('');
  box.insertAdjacentHTML('afterbegin', html);
  while (box.children.length > 60) box.lastElementChild.remove();
}
setInterval(() => $$('#tapeRows .t').forEach((el) => { el.textContent = ago(+el.dataset.ts); }), 5000);

// ================= trade module =================
const tradeBox = $('#tradeBox');
const amountInput = $('#amountInput');

function activateTrade(opts = {}) {
  if (!S.selected) return;
  if (opts.side) setSide(opts.side);
  tradeBox.classList.add('armed');
  $('#chartWrap').classList.add('activated');
  clearTimeout(activateTrade.t);
  activateTrade.t = setTimeout(() => { $('#chartWrap').classList.remove('activated'); }, 900);
  if (isMobile()) openSheet();
  setTimeout(() => amountInput.focus({ preventScroll: true }), isMobile() ? 260 : 0);
}
function openSheet() {
  tradeBox.classList.add('open');
  $('#sheetBackdrop').hidden = false;
}
function closeSheet() {
  tradeBox.classList.remove('open');
  if (!$('#posTab').classList.contains('open')) $('#sheetBackdrop').hidden = true;
}
$('#sheetBackdrop').addEventListener('click', () => { closeSheet(); closePositions(); });
$$('#mobileTradeBar [data-open-side]').forEach((b) => b.addEventListener('click', () => activateTrade({ side: b.dataset.openSide })));

function setSide(side) {
  S.side = side;
  S.sellPercent = null;
  $$('.tb-sides .side').forEach((b) => b.setAttribute('aria-selected', b.dataset.side === side));
  tradeBox.classList.toggle('sell-mode', side === 'sell');
  const exec = $('#execBtn');
  exec.className = `exec ${side}`;
  exec.textContent = side === 'buy' ? 'Buy' : 'Sell';
  $('#amountLabel').textContent = side === 'buy' ? 'Amount to spend' : `Amount to sell (paid out in ${S.cur})`;
  amountInput.value = '';
  renderQuick();
  updateEstimate();
}
function setCur(cur) {
  S.cur = cur;
  $$('.cur-toggle button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.cur === cur));
  $('#amountPrefix').textContent = cur === 'USD' ? '$' : '◎';
  amountInput.placeholder = cur === 'USD' ? '0.00' : '0.000';
  if (S.side === 'sell') $('#amountLabel').textContent = `Amount to sell (paid out in ${cur})`;
  if (S.sellPercent != null) fillSellPercent(S.sellPercent); else amountInput.value = '';
  renderQuick();
  updateEstimate();
}
function renderQuick() {
  const q = $('#quickBtns');
  if (S.side === 'sell') q.innerHTML = [25, 50, 75, 100].map((p) => `<button type="button" data-pct="${p}">${p === 100 ? 'ALL' : p + '%'}</button>`).join('');
  else if (S.cur === 'USD') q.innerHTML = [10, 50, 100, 500].map((v) => `<button type="button" data-amt="${v}">$${v}</button>`).join('');
  else q.innerHTML = [0.1, 0.5, 1, 5].map((v) => `<button type="button" data-amt="${v}">◎${v}</button>`).join('');
}
function currentPosition() { return S.user?.positions.find((p) => p.address === S.selected) || null; }
function fillSellPercent(pct) {
  const pos = currentPosition();
  S.sellPercent = pct;
  if (!pos) { amountInput.value = ''; return; }
  const usd = pos.value * pct / 100;
  amountInput.value = S.cur === 'USD' ? (Math.floor(usd * 100) / 100).toFixed(2) : (usd / (S.sol || 1)).toFixed(4);
}

$$('.tb-sides .side').forEach((b) => b.addEventListener('click', () => { setSide(b.dataset.side); activateTrade(); }));
$$('.cur-toggle button').forEach((b) => b.addEventListener('click', () => { setCur(b.dataset.cur); activateTrade(); }));
$('#quickBtns').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.pct) fillSellPercent(Number(b.dataset.pct));
  else { S.sellPercent = null; amountInput.value = b.dataset.amt; }
  activateTrade();
  updateEstimate();
});
$('#maxBtn').addEventListener('click', () => {
  if (!S.user) return openAuth('signup');
  if (S.side === 'sell') fillSellPercent(100);
  else amountInput.value = S.cur === 'USD' ? (Math.floor(S.user.usd * 100) / 100).toFixed(2) : (Math.floor(S.user.sol * 10000) / 10000).toFixed(4);
  activateTrade();
  updateEstimate();
});
amountInput.addEventListener('input', () => {
  amountInput.value = amountInput.value.replace(',', '.').replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
  S.sellPercent = null;
  tradeBox.classList.add('armed');
  updateEstimate();
});
amountInput.addEventListener('focus', () => tradeBox.classList.add('armed'));
amountInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); executeTrade(); } });
tradeBox.addEventListener('focusout', () => setTimeout(() => { if (!tradeBox.contains(document.activeElement)) tradeBox.classList.remove('armed'); }, 50));
$('#execBtn').addEventListener('click', executeTrade);

// Terminal keyboard: digits jump into the amount box, B / S switch side.
document.addEventListener('keydown', (e) => {
  if (S.view !== 'trending' || !S.onCoin || !S.selected || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || !$('#authModal').hidden) return;
  if (/^[0-9.]$/.test(e.key)) { activateTrade(); amountInput.value = (S.sellPercent != null ? '' : amountInput.value) + e.key; S.sellPercent = null; updateEstimate(); e.preventDefault(); }
  else if (e.key === 'b' || e.key === 'B') activateTrade({ side: 'buy' });
  else if (e.key === 's' || e.key === 'S') activateTrade({ side: 'sell' });
  else if (e.key === 'Escape') { closeSheet(); closePositions(); }
});

function updateBalances() {
  const el = $('#tbBal');
  renderHolding();
  if (!S.user) { el.innerHTML = `<span>Log in to trade</span><span></span>`; return; }
  el.innerHTML = `<span>Cash ${fmtUsd(S.user.usd)}</span><span>${fmtSol(S.user.sol)}</span>`;
}

// "What I hold and how I'm doing" on this coin, at the top of the buy/sell box. Updates with every price tick.
function renderHolding() {
  const box = $('#tbHold');
  if (!box) return;
  const t = S.tokens.get(S.selected);
  if (!S.user || !t) { box.hidden = true; return; }
  const pos = currentPosition();
  const sym = esc(t.symbol || '');
  box.hidden = false;
  if (!pos) {
    box.className = 'tb-hold none';
    box.innerHTML = `<div class="th-row"><span class="th-k">You hold</span><span class="th-v">0 $${sym}</span></div>
      <div class="th-sub muted">Buy some to start tracking your profit here.</div>`;
    delete box.dataset.pnl;
    return;
  }
  const c = cls(pos.pnlUsd);
  const prev = Number(box.dataset.pnl);
  box.className = `tb-hold ${c}`;
  box.innerHTML = `<div class="th-row"><span class="th-k">You hold</span><span class="th-v">${fmtQty(pos.qty)} $${sym}</span></div>
    <div class="th-grid">
      <span class="k">Worth now</span><span class="v">${fmtUsd(pos.value)}</span>
      <span class="k">You paid</span><span class="v">${fmtUsd(pos.costUsd)}</span>
      <span class="k">Avg entry</span><span class="v">${fmtPrice(pos.avgEntry)}</span>
    </div>
    <div class="th-pnl ${c}"><span>${pos.pnlUsd >= 0 ? 'Profit' : 'Loss'}</span><b>${fmtUsd(pos.pnlUsd, { sign: true })}</b><b>${fmtPct(pos.pnlPct, 1)}</b></div>`;
  if (Number.isFinite(prev) && Math.abs(pos.pnlUsd - prev) > 1e-6) {
    const pnl = box.querySelector('.th-pnl');
    pnl.classList.add(pos.pnlUsd > prev ? 'tick-up' : 'tick-down');
  }
  box.dataset.pnl = pos.pnlUsd;
}

function updateEstimate() {
  const est = $('#tradeEst');
  if (!est) return;
  const t = S.tokens.get(S.selected);
  const execLabel = `${S.side === 'buy' ? 'Buy' : 'Sell'}${t?.symbol ? ' $' + t.symbol : ''}`;
  if ($('#execBtn').textContent !== execLabel) $('#execBtn').textContent = execLabel;
  updateBalances();
  if (!t?.priceUsd) { est.textContent = ''; return; }
  const amt = Number(amountInput.value);
  const sym = esc(t.symbol);
  if (!S.user) { est.innerHTML = `<b>Create a free account</b> to get $1,000 in mock USD.`; return; }
  const usdAmt = S.cur === 'USD' ? amt : amt * S.sol;
  if (S.side === 'buy') {
    if (!(amt > 0)) { est.innerHTML = `Price <b>${fmtPrice(t.priceUsd)}</b> · SOL ${fmtUsd(S.sol)}<br>Type an amount or tap the chart.`; return; }
    const have = S.cur === 'USD' ? S.user.usd : S.user.sol;
    const over = amt > have + 1e-9;
    est.innerHTML = `≈ <b>${fmtQty(usdAmt / t.priceUsd)} ${sym}</b> for <b>${fmtUsd(usdAmt)}</b>${S.cur === 'SOL' ? ` (${fmtSol(amt)})` : ''}<br>`
      + (over ? `<span class="down">Not enough ${S.cur} — you have ${S.cur === 'USD' ? fmtUsd(have) : fmtSol(have)}</span>` : `@ ${fmtPrice(t.priceUsd)} live`);
  } else {
    const pos = currentPosition();
    if (!pos) { est.innerHTML = `You don't hold any ${sym} yet.`; return; }
    if (!(amt > 0)) { est.innerHTML = `Position worth <b>${fmtUsd(pos.value)}</b> · <span class="${cls(pos.pnlUsd)}">${fmtUsd(pos.pnlUsd, { sign: true })} (${fmtPct(pos.pnlPct, 1)})</span>`; return; }
    const sellUsd = S.sellPercent != null ? pos.value * S.sellPercent / 100 : Math.min(usdAmt, pos.value);
    const qty = sellUsd / t.priceUsd;
    const pnl = sellUsd - pos.avgEntry * qty;
    est.innerHTML = `Sell <b>${fmtQty(qty)} ${sym}</b>${S.sellPercent ? ` (${S.sellPercent}%)` : ''} → <b>${S.cur === 'USD' ? fmtUsd(sellUsd) : fmtSol(sellUsd / S.sol)}</b><br>Realized: <span class="${cls(pnl)}">${fmtUsd(pnl, { sign: true })} (${fmtPct(pos.pnlPct, 1)})</span>`
      + (usdAmt > pos.value * 1.0001 && S.sellPercent == null ? ` <span class="muted">· capped at full position</span>` : '');
  }
}

async function executeTrade() {
  if (!S.user) return openAuth('signup');
  if (!S.selected) return;
  const amt = Number(amountInput.value);
  const body = { address: S.selected, side: S.side, currency: S.cur };
  if (S.side === 'sell' && S.sellPercent != null) body.percent = S.sellPercent;
  else if (!(amt > 0)) { amountInput.focus(); return toast('Enter an amount first.', 'err', 2000); }
  else body.amount = amt;
  const btn = $('#execBtn');
  btn.disabled = true;
  try {
    const r = await api('/api/trade', body);
    S.user = r.user;
    const t = r.trade;
    if (t.side === 'buy') toast(`<b>Bought</b> ${fmtQty(t.qty)} ${esc(t.symbol)} for ${fmtUsd(t.usdValue)}<br><span class="muted">@ ${fmtPrice(t.price)}</span>`);
    else toast(`<b>Sold</b> ${fmtQty(t.qty)} ${esc(t.symbol)} for ${fmtUsd(t.usdValue)}<br><span class="${cls(t.pnlUsd)}">${fmtUsd(t.pnlUsd, { sign: true })} (${fmtPct(t.pnlPct, 1)})</span>`, t.pnlUsd < 0 ? 'err' : '');
    noteRealized(t);
    amountInput.value = '';
    S.sellPercent = null;
    closeSheet();
    renderAcct(); renderPositions(); updateChartLines(); renderCoinList(); updateEstimate();
    loadMyTokenTrades();
    if (t.side === 'buy' && isDrawer()) openPositions(true);
  } catch (e) {
    if (e.status === 401) openAuth('login'); else toast(esc(e.message), 'err');
  } finally { btn.disabled = false; }
}

// ================= positions side-tab =================
function renderPositions() {
  const list = $('#posList');
  const handle = $('#posHandle');
  const strip = $('#myPosStrip');
  if (!S.user) {
    list.innerHTML = `<div class="pos-empty">Log in to start paper trading.<br><button class="btn-ghost" data-auth="signup" style="margin-top:10px">Create account</button></div>`;
    $('#posTotal').innerHTML = '';
    $('#posCount').textContent = '0';
    $('#posN').textContent = '';
    strip.hidden = true;
    return;
  }
  const sort = S.posSort || 'value';
  const by = { value: (a, b) => b.value - a.value, pnl: (a, b) => b.pnlUsd - a.pnlUsd, recent: (a, b) => (b.openedAt || 0) - (a.openedAt || 0) }[sort];
  const ps = S.user.positions.slice().sort(by);
  const tv = ps.reduce((s, p) => s + p.value, 0), tp = ps.reduce((s, p) => s + p.pnlUsd, 0), tc = ps.reduce((s, p) => s + p.costUsd, 0);
  $('#posCount').textContent = ps.length;
  $('#posN').textContent = ps.length ? ps.length : '';
  $('#posRailN').textContent = ps.length;
  $('#posRail').classList.toggle('up', ps.length > 0 && tp >= 0);
  $('#posRail').classList.toggle('down', ps.length > 0 && tp < 0);

  // summary: holdings value, unrealized PnL, allocation bar
  const COLORS = ['#86efac', '#7dd3fc', '#c4b5fd', '#fcd34d', '#f9a8d4', '#fdba74', '#5eead4', '#a5b4fc'];
  const alloc = ps.filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  $('#posTotal').innerHTML = ps.length ? `<div class="ps-sum">
      <div><span class="k">Holdings</span><b>${fmtUsd(tv)}</b></div>
      <div class="r"><span class="k">Unrealized PnL</span><b class="${cls(tp)}">${fmtUsd(tp, { sign: true })} <small>${fmtPct(tc ? (tp / tc) * 100 : 0, 2)}</small></b></div>
    </div>
    <div class="alloc" title="How your holdings are split">${alloc.map((p, i) => `<span style="width:${(p.value / (tv || 1)) * 100}%;background:${COLORS[i % COLORS.length]}" title="${esc(p.symbol)} ${((p.value / (tv || 1)) * 100).toFixed(1)}%"></span>`).join('')}</div>` : '';

  const cur = ps.find((p) => p.address === S.selected);
  handle.classList.toggle('has-up', !!cur && cur.pnlUsd >= 0);
  handle.classList.toggle('has-down', !!cur && cur.pnlUsd < 0);
  if (cur) {
    strip.hidden = false;
    strip.innerHTML = `<span class="lbl">Your position</span><span>${fmtQty(cur.qty)} · avg ${fmtPrice(cur.avgEntry)}</span>
      <span class="pnl ${cls(cur.pnlUsd)}">${fmtUsd(cur.pnlUsd, { sign: true })} ${fmtPct(cur.pnlPct, 1)}</span>`;
  } else strip.hidden = true;

  if (!ps.length) {
    list.innerHTML = `<div class="pos-empty">No open positions yet.<br>Open a coin and hit <span class="up">Buy</span>. Your positions show up here, live.</div>`;
    list.dataset.keys = '';
    return;
  }
  // keep DOM nodes stable so the flash animations look right
  const want = ps.map((p) => p.address).join(',');
  if (list.dataset.keys !== want) {
    list.dataset.keys = want;
    list.innerHTML = ps.map((p) => `
      <div class="prow" data-addr="${esc(p.address)}" role="button" tabindex="0" aria-label="Open ${esc(p.symbol)}">
        <div class="prow-main">
          ${coinImg(p, 'coin-img prow-img')}
          <div class="prow-id"><b>${esc(p.symbol)}</b><span class="muted" data-f="sub"></span></div>
          <div class="prow-val"><b data-f="val"></b><span class="prow-pnl" data-f="pnl"></span></div>
        </div>
        <div class="prow-foot">
          <span class="muted" data-f="mc"></span>
          <span class="prow-qs"><button data-qs="25" title="Sell 25%">25%</button><button data-qs="50" title="Sell 50%">50%</button><button data-qs="100" title="Sell all">All</button></span>
        </div>
      </div>`).join('');
  }
  for (const p of ps) {
    const row = list.querySelector(`.prow[data-addr="${CSS.escape(p.address)}"]`);
    if (!row) continue;
    row.classList.toggle('current', p.address === S.selected);
    row.classList.toggle('win', p.pnlUsd >= 0);
    row.classList.toggle('loss', p.pnlUsd < 0);
    row.querySelector('[data-f="sub"]').textContent = `${fmtQty(p.qty)} · ${ago(p.openedAt)}`;
    row.querySelector('[data-f="val"]').textContent = fmtUsd(p.value);
    const supply = supplyOf(S.tokens.get(p.address));
    row.querySelector('[data-f="mc"]').textContent = supply
      ? `MC ${fmtUsd(p.avgEntry * supply, { compact: true })} → ${fmtUsd(p.price * supply, { compact: true })}`
      : `Entry ${fmtPrice(p.avgEntry)} → ${fmtPrice(p.price)}`;
    const pnl = row.querySelector('[data-f="pnl"]');
    const last = S.lastPnl.get(p.address);
    pnl.className = `prow-pnl ${p.pnlUsd >= 0 ? 'up' : 'down'}`;
    if (last != null && Math.abs(p.pnlUsd - last) > 1e-9) { void pnl.offsetWidth; pnl.classList.add(p.pnlUsd > last ? 'tick-up' : 'tick-down'); }
    S.lastPnl.set(p.address, p.pnlUsd);
    pnl.textContent = `${fmtUsd(p.pnlUsd, { sign: true })} (${fmtPct(p.pnlPct, 1)})`;
  }
}
// Collapse the positions column to a thin rail so the chart gets the extra width (remembered per browser).
function setPosCollapsed(on) {
  $('#tradeLayout').classList.toggle('pos-collapsed', on);
  try { localStorage.setItem('memesim.posCollapsed', on ? '1' : '0'); } catch { /* private mode */ }
  chart?.resize();
}
$('#posCollapse').addEventListener('click', () => setPosCollapsed(true));
$('#posRail').addEventListener('click', () => setPosCollapsed(false));
try { if (localStorage.getItem('memesim.posCollapsed') === '1') $('#tradeLayout').classList.add('pos-collapsed'); } catch { /* ignore */ }
$('#posSort').addEventListener('click', (e) => {
  const b = e.target.closest('[data-psort]');
  if (!b) return;
  S.posSort = b.dataset.psort;
  $$('#posSort [data-psort]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  renderPositions();
});
$('#posList').addEventListener('click', async (e) => {
  const qs = e.target.closest('[data-qs]');
  const card = e.target.closest('.prow');
  if (!card) return;
  if (qs) {
    e.stopPropagation();
    qs.disabled = true;
    try {
      const r = await api('/api/trade', { address: card.dataset.addr, side: 'sell', percent: Number(qs.dataset.qs), currency: 'USD' });
      S.user = r.user;
      const t = r.trade;
      toast(`<b>Sold</b> ${fmtQty(t.qty)} ${esc(t.symbol)} for ${fmtUsd(t.usdValue)}<br><span class="${cls(t.pnlUsd)}">${fmtUsd(t.pnlUsd, { sign: true })} (${fmtPct(t.pnlPct, 1)})</span>`, t.pnlUsd < 0 ? 'err' : '');
      noteRealized(t);
      renderAcct(); renderPositions(); updateChartLines(); renderCoinList(); updateEstimate();
    } catch (err) { toast(esc(err.message), 'err'); qs.disabled = false; }
    return;
  }
  if (isMobile()) closePositions();
  location.hash = `coin/${card.dataset.addr}`;
});
function openPositions(auto) {
  if (!isDrawer()) return;
  $('#posTab').classList.add('open');
  $('#posHandle').setAttribute('aria-expanded', 'true');
  if (isMobile()) $('#sheetBackdrop').hidden = false;
  if (auto && isMobile()) { clearTimeout(openPositions.t); openPositions.t = setTimeout(closePositions, 3500); }
}
function closePositions() {
  clearTimeout(openPositions.t);
  $('#posTab').classList.remove('open');
  $('#posHandle').setAttribute('aria-expanded', 'false');
  if (!tradeBox.classList.contains('open')) $('#sheetBackdrop').hidden = true;
}
$('#posHandle').addEventListener('click', () => ($('#posTab').classList.contains('open') ? closePositions() : openPositions()));
$('#posClose').addEventListener('click', closePositions);
$('#myPosStrip').addEventListener('click', () => openPositions());
$('#posTab').addEventListener('pointerdown', () => clearTimeout(openPositions.t));

// ================= player-powered prices =================
// If the server is being rate-limited by the price sites, this browser fetches the same public data
// (from its own internet address) and hands it to the server. The server says when it needs help.
const DEX = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2';
const getJ = async (url) => { const r = await fetch(url, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };
const slimPair = (p) => ({
  chainId: p.chainId, dexId: p.dexId, pairAddress: p.pairAddress,
  baseToken: { address: p.baseToken?.address, name: p.baseToken?.name, symbol: p.baseToken?.symbol },
  priceUsd: p.priceUsd, priceChange: { m5: p.priceChange?.m5, h1: p.priceChange?.h1, h24: p.priceChange?.h24 },
  volume: { h24: p.volume?.h24 }, liquidity: { usd: p.liquidity?.usd }, marketCap: p.marketCap, fdv: p.fdv,
  txns: { m5: p.txns?.m5 }, pairCreatedAt: p.pairCreatedAt, info: { imageUrl: p.info?.imageUrl },
});
let relayBusy = false;
let lastListsFetch = 0;
async function relayTick() {
  if (relayBusy || document.hidden) return;
  relayBusy = true;
  try {
    const plan = await api('/api/relay/plan');
    S.serverBlocked = !!plan.serverBlocked;
    const wantLists = plan.needLists && Date.now() - lastListsFetch > 18_000;
    if (!plan.want && !wantLists) return;
    const body = {};
    let addrs = plan.want ? (plan.addresses || []) : [];
    if (wantLists) {
      lastListsFetch = Date.now();
      // "Trending in the last 5 minutes" from GeckoTerminal; the server keeps the pump.fun coins.
      const [gt, top, latest, prof] = await Promise.allSettled([
        getJ(`${GT}/networks/solana/trending_pools?include=base_token&duration=5m&page=1`),
        getJ(`${DEX}/token-boosts/top/v1`), getJ(`${DEX}/token-boosts/latest/v1`), getJ(`${DEX}/token-profiles/latest/v1`),
      ]);
      const cand = []; const seen = new Set(); const pools = {};
      const add = (a) => { if (a && !seen.has(a)) { seen.add(a); cand.push(a); } };
      if (gt.status === 'fulfilled') {
        const inc = new Map((gt.value.included || []).map((x) => [x.id, x.attributes || {}]));
        for (const pool of gt.value.data || []) {
          const id = pool.relationships?.base_token?.data?.id;
          const a = inc.get(id)?.address || (id || '').replace(/^solana_/, '');
          if (a) { add(a); if (pool.attributes?.address) pools[a] = pool.attributes.address; }
        }
      }
      for (const l of [top, latest, prof]) if (l.status === 'fulfilled' && Array.isArray(l.value)) for (const b of l.value) if (b?.chainId === 'solana') add(b.tokenAddress);
      const ordered = cand.filter((a) => a.endsWith('pump')).concat(cand.filter((a) => !a.endsWith('pump')));
      body.lists = ordered.slice(0, 90);
      body.pools = pools;
      addrs = [...new Set([...addrs, ...body.lists])];
    }
    const pairs = [];
    for (let i = 0; i < addrs.length; i += 30) {
      const r = await getJ(`${DEX}/tokens/v1/solana/${addrs.slice(i, i + 30).join(',')}`).catch(() => null);
      if (Array.isArray(r)) pairs.push(...r.map(slimPair));
    }
    if (pairs.length) { body.pairs = pairs; await api('/api/relay', body); }
  } catch { /* try again next tick */ } finally { relayBusy = false; }
}
setInterval(relayTick, 3000);

// Chart history straight from GeckoTerminal (one request when you open a coin).
async function browserHistory(addr, tf) {
  const t = S.tokens.get(addr);
  if (!t?.pairAddress || String(addr).startsWith('DEMO')) return [];
  const [unit, agg] = tf >= 1440 ? ['day', 1] : tf >= 60 ? ['hour', Math.max(1, Math.round(tf / 60))] : ['minute', tf];
  const j = await getJ(`${GT}/networks/solana/pools/${t.pairAddress}/ohlcv/${unit}?aggregate=${agg}&limit=500&currency=usd&token=base`);
  return (j?.data?.attributes?.ohlcv_list || [])
    .map(([ts, o, h, l, c, v]) => ({ time: Math.floor(ts / (tf * 60)) * tf * 60, open: +o, high: +h, low: +l, close: +c, volume: +v || 0 }))
    .filter((c) => c.open > 0 && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

// ---- live on-chain trades for the open coin (GeckoTerminal, every ~3s) ----
// Every trade goes into one store that drives the 1s/15s candles, the trades list and the top-traders table.
let tapeBusy = false;
let tapePauseUntil = 0;
let tapeFails = 0;
function setFeedHint() {
  const el = $('#chartHint');
  if (!el) return;
  const busy = tapeFails >= 2;
  el.innerHTML = busy ? '<span class="live-pip" aria-hidden="true" style="background:var(--amber)"></span>Trade feed busy · following live price'
    : '<span class="live-pip" aria-hidden="true"></span>Live on-chain trades';
}
// When no new on-chain trade has come in for a few seconds (quiet coin, or the trade feed is rate-limited),
// keep the candles moving with the 1-second price feed so the chart never freezes.
function priceTick(addr, price) {
  if (addr !== S.selected || !(price > 0) || String(addr).startsWith('DEMO')) return;
  if (Date.now() - (S.tradeFeedAt || 0) < 8000) return;
  const last = S.trades[S.trades.length - 1];
  if (last && last.price === price && Date.now() - last.ts < 30_000) return;
  const now = Date.now();
  S.trades.push({ id: `tick${now}`, ts: now, price, usd: 0, tick: true });
  if (S.tf < 60) redrawTradeChart();
}
const tradeKey = { addr: null, newest: 0 };
function addTrades(list, fresh) {
  const add = [];
  for (const x of list || []) {
    const id = x.id || `${x.ts}${x.usd}`;
    if (!(x.price > 0) || S.tradeIds.has(id)) continue;
    S.tradeIds.add(id);
    add.push({ ...x, id });
  }
  if (!add.length) return;
  S.trades.push(...add);
  S.trades.sort((a, b) => a.ts - b.ts);
  if (S.trades.length > 6000) S.trades.splice(0, S.trades.length - 6000);
  S.tradeFeedAt = Date.now();
  addTape(add.slice(-60), fresh);
  priceFromTrade(add);
  if (S.tf < 60) redrawTradeChart();
  else if (chart) {
    for (const x of add) {
      const bucket = Math.floor(x.ts / 1000 / S.tf) * S.tf;
      const last = chart.data[chart.data.length - 1];
      if (last && last.time === bucket) chart.update({ ...last, high: Math.max(last.high, x.price), low: Math.min(last.low, x.price), close: x.price, volume: (last.volume || 0) + (x.usd || 0) });
      else if (!last || bucket > last.time) chart.update({ time: bucket, open: last ? last.close : x.price, high: Math.max(x.price, last ? last.close : x.price), low: Math.min(x.price, last ? last.close : x.price), close: x.price, volume: x.usd || 0 });
    }
  }
  if (S.tape === 'traders') renderTraders();
}
// The newest real trade is the freshest price there is: use it for the price, market cap, your PnL,
// and (so your trades fill there too) hand it to the server.
function priceFromTrade(add) {
  const addr = S.selected;
  const t = S.tokens.get(addr);
  if (!t) return;
  const newest = add.reduce((a, b) => (b.ts > a.ts ? b : a));
  if (newest.ts <= (t.tradeTs || 0) || Date.now() - newest.ts > 180_000) return;
  const supply = supplyOf(t);
  const next = { ...t, priceUsd: newest.price, marketCap: supply ? supply * newest.price : t.marketCap, tradeTs: newest.ts, tradePriceAt: Date.now(), updatedAt: Date.now() };
  const dir = t.priceUsd ? Math.sign(newest.price - t.priceUsd) : 0;
  S.tokens.set(addr, next);
  renderTermHead();
  updateCoinRow(addr, dir);
  repricePosition(addr, newest.price);
  if (Date.now() - lastOpenRelay > 2500 && !String(addr).startsWith('DEMO')) {
    lastOpenRelay = Date.now();
    api('/api/relay', { pairs: [{ chainId: 'solana', dexId: t.dexId || 'pumpswap', pairAddress: t.pairAddress || undefined, baseToken: { address: addr, name: t.name, symbol: t.symbol }, priceUsd: String(newest.price), marketCap: next.marketCap, info: { imageUrl: t.image || undefined } }] }).catch(() => {});
  }
}
async function pollTrades() {
  const addr = S.selected;
  const t = S.tokens.get(addr);
  if (tapeBusy || document.hidden || !S.onCoin || !t?.pairAddress || String(addr).startsWith('DEMO') || Date.now() < tapePauseUntil) return;
  tapeBusy = true;
  try {
    const j = await getJ(`${GT}/networks/solana/pools/${t.pairAddress}/trades`);
    if (addr !== S.selected) return;
    const trades = (j.data || []).map((row) => {
      const a = row.attributes || {};
      const sell = a.kind === 'sell';
      return { id: a.tx_hash || row.id, side: sell ? 'sell' : 'buy', usd: Number(a.volume_in_usd) || 0,
        price: Number(sell ? a.price_from_in_usd : a.price_to_in_usd) || 0,
        qty: Number(sell ? a.from_token_amount : a.to_token_amount) || 0,
        trader: a.tx_from_address || '', ts: a.block_timestamp ? Date.parse(a.block_timestamp) : Date.now() };
    }).map((x) => ({ ...x, wallet: x.trader ? `${x.trader.slice(0, 4)}…${x.trader.slice(-4)}` : '' }));
    const fresh = trades.filter((x) => x.ts > tradeKey.newest);
    if (trades.length) tradeKey.newest = Math.max(tradeKey.newest, ...trades.map((x) => x.ts));
    addTrades(trades, S.lastTapeAt > 0);
    // Coins DexScreener doesn't list yet: the newest trade is the live price.
    if (t.geckoOnly && fresh.length) {
      const last = fresh.sort((x, y) => x.ts - y.ts)[fresh.length - 1];
      applyLivePair(addr, { priceUsd: last.price, pairAddress: t.pairAddress });
      if (Date.now() - lastOpenRelay > 3000) {
        lastOpenRelay = Date.now();
        api('/api/relay', { pairs: [{ chainId: 'solana', dexId: t.dexId || 'pumpfun', pairAddress: t.pairAddress, baseToken: { address: addr, name: t.name, symbol: t.symbol }, priceUsd: String(last.price), marketCap: S.tokens.get(addr)?.marketCap, info: { imageUrl: t.image || undefined } }] }).catch(() => {});
      }
    }
    tapeFails = 0;
    setFeedHint();
  } catch {
    // GeckoTerminal's "too many requests" reply has no CORS headers, so it shows up as a network error: back off
    tapeFails++;
    tapePauseUntil = Date.now() + Math.min(30_000, 3000 * 2 ** Math.min(tapeFails, 4));
    setFeedHint();
  } finally { tapeBusy = false; }
}
setInterval(pollTrades, 3000);

// ---- coin details: holders, stats, pool (GeckoTerminal + DexScreener) ----
const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');
const shortAddr = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
const solscan = (a, kind = 'account') => `https://solscan.io/${kind}/${encodeURIComponent(a)}`;
async function loadCoinInfo(addr) {
  if (String(addr).startsWith('DEMO')) { renderSidePanels(); return; }
  const t = S.tokens.get(addr);
  const jobs = [];
  const cached = S.info.get(addr);
  if (!cached || Date.now() - cached.at > 300_000) {
    jobs.push(getJ(`${GT}/networks/solana/tokens/${addr}/info`).then((j) => {
      const a = j?.data?.attributes;
      if (a) S.info.set(addr, { ...S.info.get(addr), ...a, at: Date.now() });
    }).catch(() => {}));
  }
  if (t?.pairAddress && S.info.get(addr)?.athPrice == null) {
    jobs.push(getJ(`${GT}/networks/solana/pools/${t.pairAddress}/ohlcv/day?aggregate=1&limit=365&currency=usd&token=base`).then((j) => {
      const highs = (j?.data?.attributes?.ohlcv_list || []).map((c) => +c[2]).filter((v) => v > 0);
      S.info.set(addr, { at: 0, ...S.info.get(addr), athPrice: highs.length ? Math.max(...highs) : 0 });
    }).catch(() => {}));
  }
  await Promise.all(jobs);
  await loadPool(addr);
  if (addr === S.selected) { renderTermHead(); renderSidePanels(); if (S.tape === 'holders') renderHoldersPane(); }
  loadHolderList(addr);
}
async function loadPool(addr) {
  const t = S.tokens.get(addr);
  if (!t?.pairAddress || String(addr).startsWith('DEMO')) return;
  try {
    const j = await getJ(`${GT}/networks/solana/pools/${t.pairAddress}`);
    const a = j?.data?.attributes;
    if (a) S.pool.set(addr, { ...a, at: Date.now() });
  } catch { /* keep the last one */ }
}
setInterval(async () => {
  if (document.hidden || !S.onCoin || !S.selected) return;
  if (!S.info.get(S.selected)?.holders) { loadCoinInfo(S.selected); return; }
  await loadPool(S.selected);
  renderSidePanels();
}, 30_000);
function athOf(addr) {
  const t = S.tokens.get(addr);
  const info = S.info.get(addr);
  const supply = supplyOf(t);
  if (!supply) return 0;
  const hiTrades = S.trades.length && addr === S.selected ? Math.max(...S.trades.map((x) => x.price)) : 0;
  return Math.max(info?.athPrice || 0, hiTrades, t.priceUsd || 0) * supply;
}

// Optional full holder list (needs a Solana data key on the server; see README).
const holderLists = new Map();
async function loadHolderList(addr) {
  if (holderLists.has(addr) && Date.now() - holderLists.get(addr).at < 60_000) return;
  try {
    const r = await api(`/api/holders/${addr}`);
    holderLists.set(addr, { ...r, at: Date.now() });
    if (addr === S.selected && S.tape === 'holders') renderHoldersPane();
  } catch { holderLists.set(addr, { off: true, at: Date.now() }); }
}

function bar2(a, b, la, lb) {
  const tot = (a || 0) + (b || 0);
  const pa = tot ? (a / tot) * 100 : 50;
  return `<div class="b2-row"><span class="up">${la}</span><span class="down">${lb}</span></div>
    <div class="b2"><span class="b2-a" style="width:${pa}%"></span><span class="b2-b" style="width:${100 - pa}%"></span></div>`;
}
function renderSidePanels() {
  const addr = S.selected;
  const t = S.tokens.get(addr);
  if (!t) return;
  const info = S.info.get(addr) || {};
  const pool = S.pool.get(addr) || {};
  const pair = S.pairs.get(addr) || {};
  const demo = String(addr).startsWith('DEMO');

  // Holders
  const h = info.holders;
  const dist = h?.distribution_percentage || {};
  const seg = [['Top 10', dist.top_10, '#86efac'], ['11–20', dist['11_20'] ?? dist['11_30'], '#7dd3fc'], ['21–40', dist['21_40'] ?? dist['31_50'], '#c4b5fd'], ['Rest', dist.rest, '#3f3f46']].filter((x) => x[1] != null);
  $('#holdersTabN').textContent = h?.count ? fmtInt(h.count) : '';
  $('#holdersCard').innerHTML = `<div class="sec-h"><span>Holders</span><b>${h?.count ? fmtInt(h.count) : '—'}</b></div>
    ${seg.length ? `<div class="dist">${seg.map(([, v, c]) => `<span style="width:${Number(v)}%;background:${c}"></span>`).join('')}</div>
    <div class="dist-legend">${seg.map(([k, v, c]) => `<span><i style="background:${c}"></i>${k} <b>${Number(v).toFixed(1)}%</b></span>`).join('')}</div>` : `<div class="muted small">${demo ? 'Demo coin.' : 'Loading holder data…'}</div>`}
    ${info.developer_holding_percentage != null ? `<div class="kv"><span>Dev holds</span><b>${Number(info.developer_holding_percentage).toFixed(2)}%</b></div>` : ''}
    <button class="link-btn" data-goto-tab="holders">View holders</button>`;

  // Stats
  const tf = S.statsTf;
  const tfKey = { m5: 'm5', h1: 'h1', h6: 'h6', h24: 'h24' }[tf];
  const chg = pool.price_change_percentage?.[tfKey] != null ? Number(pool.price_change_percentage[tfKey]) : pair.priceChange?.[tfKey] ?? t[{ m5: 'change5m', h1: 'change1h', h24: 'change24h' }[tf]];
  const vol = pair.volume?.[tfKey] ?? (pool.volume_usd?.[tfKey] != null ? Number(pool.volume_usd[tfKey]) : null);
  const tx = pair.txns?.[tfKey] || pool.transactions?.[tfKey] || {};
  const ptx = pool.transactions?.[tfKey] || {};
  $('#statsCard').innerHTML = `<div class="sec-h"><span>Stats</span>
      <div class="mini-seg">${['m5', 'h1', 'h6', 'h24'].map((k) => `<button data-stats-tf="${k}" aria-pressed="${k === tf}">${{ m5: '5m', h1: '1h', h6: '6h', h24: '24h' }[k]}</button>`).join('')}</div></div>
    <div class="kv"><span>Price change</span><b class="chg-pill ${cls(chg)}">${chg != null ? fmtPct(chg, 2) : '—'}</b></div>
    <div class="kv"><span>Volume</span><b>${vol != null ? fmtUsd(vol, { compact: true }) : '—'}</b></div>
    ${bar2(tx.buys, tx.sells, `${tx.buys != null ? fmtInt(tx.buys) : '—'} buys`, `${tx.sells != null ? fmtInt(tx.sells) : '—'} sells`)}
    ${ptx.buyers != null ? bar2(ptx.buyers, ptx.sellers, `${fmtInt(ptx.buyers)} buyers`, `${fmtInt(ptx.sellers)} sellers`) : ''}`;

  // Pool information
  const liq = pair.liquidity || {};
  const quote = pair.quoteToken?.symbol || 'SOL';
  const dexName = { pumpfun: 'Pump.fun curve', pumpswap: 'PumpSwap', raydium: 'Raydium', meteora: 'Meteora', orca: 'Orca' }[String(t.dexId || pair.dexId || '').toLowerCase()] || (t.dexId || pair.dexId || '—');
  const lp = info.launchpad_details;
  const ath = athOf(addr);
  const mc = t.marketCap || 0;
  const socials = [
    ...(info.websites || []).slice(0, 2).map((u) => [u.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 28), u]),
    info.twitter_handle ? ['X / Twitter', `https://x.com/${info.twitter_handle}`] : null,
    info.telegram_handle ? ['Telegram', `https://t.me/${info.telegram_handle}`] : null,
  ].filter(Boolean).filter(([, u]) => /^https:\/\//.test(u));
  $('#poolCard').innerHTML = `<div class="sec-h"><span>Pool information</span><span class="tag">Paired with ${esc(quote)}</span></div>
    <div class="kv"><span>Total liquidity</span><b>${liq.usd ? fmtUsd(liq.usd, { compact: true }) : '—'}${liq.quote ? ` <small class="muted">(${fmtInt(Math.round(liq.quote))} ${esc(quote)})</small>` : ''}</b></div>
    <div class="kv"><span>Exchange</span><b>${esc(dexName)}</b></div>
    ${t.pairAddress ? `<div class="kv"><span>Pool</span><a href="${solscan(t.pairAddress)}" target="_blank" rel="noopener" class="mono">${esc(shortAddr(t.pairAddress))} ↗</a></div>` : ''}
    ${info.developer_address ? `<div class="kv"><span>Creator</span><a href="${solscan(info.developer_address)}" target="_blank" rel="noopener" class="mono">${esc(shortAddr(info.developer_address))} ↗</a></div>` : ''}
    ${t.createdAt ? `<div class="kv"><span>Created</span><b>${ago(t.createdAt)} ago</b></div>` : ''}
    ${lp && !lp.completed ? `<div class="kv"><span>Bonding curve</span><b>${Number(lp.graduation_percentage || 0).toFixed(1)}%</b></div><div class="prog"><span style="width:${Math.min(100, Number(lp.graduation_percentage || 0))}%"></span></div>` : ''}
    ${ath ? `<div class="kv"><span>MC ${fmtUsd(mc, { compact: true })}</span><span class="muted">ATH ${fmtUsd(ath, { compact: true })}</span></div><div class="prog"><span style="width:${Math.min(100, (mc / ath) * 100)}%"></span></div>` : ''}
    ${info.description ? `<div class="desc">${esc(String(info.description).slice(0, 400))}</div>` : ''}
    ${socials.length ? `<div class="socials">${socials.map(([k, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener nofollow">${esc(k)} ↗</a>`).join('')}</div>` : ''}
    ${info.mint_authority ? `<div class="kv small"><span>Mint authority</span><b class="${info.mint_authority === 'no' ? 'up' : 'down'}">${info.mint_authority === 'no' ? 'Revoked' : 'Active'}</b></div>` : ''}`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-stats-tf]');
  if (b) { S.statsTf = b.dataset.statsTf; renderSidePanels(); return; }
  const g = e.target.closest('[data-goto-tab]');
  if (g) { $(`.ctab[data-tape="${g.dataset.gotoTab}"]`)?.click(); $('.tape')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
});

function renderHoldersPane() {
  const addr = S.selected;
  const info = S.info.get(addr) || {};
  const h = info.holders;
  const list = holderLists.get(addr);
  const t = S.tokens.get(addr) || {};
  const supply = supplyOf(t);
  let rows = '';
  if (list?.holders?.length) {
    rows = `<div class="tbl-head h5"><span>#</span><span>Holder</span><span class="r">Amount</span><span class="r">% supply</span><span class="r">Value</span></div>` +
      list.holders.map((x, i) => {
        const label = x.owner === t.pairAddress ? '<span class="tag">Liquidity pool</span>' : x.owner === info.developer_address ? '<span class="tag dev">Dev</span>' : '';
        return `<div class="tbl-row h5"><span class="muted">${i + 1}</span><span><a class="mono" href="${solscan(x.owner)}" target="_blank" rel="noopener">${esc(shortAddr(x.owner))}</a> ${label}</span>
          <span class="r mono">${fmtQty(x.amount)}</span><span class="r mono">${x.pct.toFixed(2)}%</span><span class="r mono">${fmtUsd(x.amount * (t.priceUsd || 0), { compact: true })}</span></div>`;
      }).join('');
  } else {
    rows = `<div class="tape-empty">The full list of holder wallets needs a Solana data key on the server, so it isn't shown here yet.<br>
      The count and split above are live. <b>Top traders</b> shows who's buying and selling right now.</div>`;
  }
  const dist = h?.distribution_percentage || {};
  $('#holdersPane').innerHTML = `<div class="pane-sum">
      <div><span class="k">Holders</span><b>${h?.count ? fmtInt(h.count) : '—'}</b></div>
      <div><span class="k">Top 10 hold</span><b>${dist.top_10 != null ? Number(dist.top_10).toFixed(1) + '%' : '—'}</b></div>
      <div><span class="k">Dev holds</span><b>${info.developer_holding_percentage != null ? Number(info.developer_holding_percentage).toFixed(2) + '%' : '—'}</b></div>
      <div><span class="k">Supply</span><b>${supply ? fmtQty(supply) : '—'}</b></div>
    </div>${rows}`;
}

// Wallets trading this coin right now, from the on-chain trades this page has seen.
function renderTraders() {
  const t = S.tokens.get(S.selected) || {};
  const by = new Map();
  for (const x of S.trades) {
    if (!x.trader) continue;
    const w = by.get(x.trader) || { trader: x.trader, bought: 0, sold: 0, qty: 0, n: 0, last: 0 };
    if (x.side === 'buy') { w.bought += x.usd; w.qty += x.qty || 0; } else { w.sold += x.usd; w.qty -= x.qty || 0; }
    w.n++; w.last = Math.max(w.last, x.ts);
    by.set(x.trader, w);
  }
  const list = [...by.values()].map((w) => ({ ...w, pnl: w.sold - w.bought + Math.max(0, w.qty) * (t.priceUsd || 0) }))
    .sort((a, b) => (b.bought + b.sold) - (a.bought + a.sold)).slice(0, 50);
  const real = S.trades.filter((x) => !x.tick);
  const span = real.length ? ago(real[0].ts) : '';
  $('#tradersPane').innerHTML = list.length ? `<div class="pane-note muted small">From the last ${fmtInt(real.length)} on-chain trades (${span}). PnL = sold + still held − bought, within that window.</div>
    <div class="tbl-head h6"><span>Trader</span><span class="r">Bought</span><span class="r">Sold</span><span class="r">PnL</span><span class="r">Trades</span><span class="r">Last</span></div>` +
    list.map((w) => `<div class="tbl-row h6"><a class="mono" href="${solscan(w.trader)}" target="_blank" rel="noopener">${esc(shortAddr(w.trader))}</a>
      <span class="r mono up">${fmtUsd(w.bought, { compact: true })}</span><span class="r mono down">${fmtUsd(w.sold, { compact: true })}</span>
      <span class="r mono ${cls(w.pnl)}">${fmtUsd(w.pnl, { sign: true, compact: true })}</span><span class="r mono">${w.n}</span><span class="r muted">${ago(w.last)}</span></div>`).join('')
    : `<div class="tape-empty">Waiting for on-chain trades…</div>`;
}

// ================= ticker =================
function renderTicker(fresh) {
  const items = [];
  for (const t of S.trending.map((a) => S.tokens.get(a)).filter(Boolean).slice(0, 20)) {
    items.push(`<a class="tk" href="#coin/${esc(t.address)}">${coinImg(t, 'coin-img xs')}<b>${esc(t.symbol)}</b> ${fmtUsd(t.marketCap, { compact: true })} <span class="${cls(t.change5m)}">${fmtPct(t.change5m, 1)}</span></a>`);
  }
  if (!items.length) return;
  const inner = $('#ticker');
  inner.innerHTML = items.join('') + items.join('');
}

// ================= leaderboard =================
let lbTimer = null;
async function loadLeaderboard() {
  try {
    const d = await api(`/api/leaderboard?range=${S.lbRange}`);
    const rows = $('#lbRows');
    const row = (r, extra = '') => `<div class="lb-row ${r.rank <= 3 ? 'top' + r.rank : ''} ${r.isMe ? 'me' : ''}" role="row">
        <span class="lb-rank" role="cell">#${r.rank}</span>
        <span class="lb-name" role="cell"><button class="lb-player" data-player="${esc(r.username)}" title="View profile">${avatarHtml(r)}<span class="nm">${esc(r.username)}${esc(extra)}</span></button>${r.isMe ? '<span class="you-tag">YOU</span>' : ''}${badgeIcons(r.badges)}</span>
        <span class="lb-pnl r ${cls(r.profit)}" role="cell">${fmtUsd(r.profit, { sign: true })}</span>
        <span class="r hide-sm ${cls(r.profitPct)}" role="cell">${fmtPct(r.profitPct, 1)}</span>
        <span class="r hide-sm muted" role="cell">${fmtUsd(r.value, { compact: true })}</span>
      </div>`;
    rows.innerHTML = d.top.length ? d.top.map(row).join('') : `<div class="lb-empty">No players yet — be the first.</div>`;
    $('#lbMe').innerHTML = d.me ? row(d.me, `  · rank ${d.me.rank} of ${d.total}`) : (S.user ? '' : `<div class="lb-row me"><span></span><span class="lb-name">Make an account to get ranked</span><span class="r"><button class="btn-ghost small" data-auth="signup">Join</button></span></div>`);
  } catch (e) { toast(esc(e.message), 'err'); }
}
$$('.range-chips .chip').forEach((b) => b.addEventListener('click', () => {
  S.lbRange = b.dataset.range;
  $$('.range-chips .chip').forEach((x) => x.setAttribute('aria-pressed', x === b));
  loadLeaderboard();
}));

// ================= badges + tooltips =================
function badgeIcons(list) {
  if (!list?.length) return '';
  return `<span class="badges">${list.map((b) => {
    const d = S.badgeDefs[b.id];
    if (!d) return '';
    return `<button class="badge-ico" style="--bc:${d.color}" data-badge="${esc(b.id)}" data-detail="${esc(b.detail || '')}" data-earned="${b.earnedAt}" aria-label="${esc(d.name)} badge">${d.icon}</button>`;
  }).join('')}</span>`;
}
const tip = $('#tooltip');
function showTip(el) {
  const d = S.badgeDefs[el.dataset.badge];
  if (!d) return;
  tip.style.setProperty('--tc', d.color);
  tip.innerHTML = `<b>${d.icon} ${esc(d.name)}</b>${esc(d.how)}${el.dataset.detail ? `<div class="tt-detail">${esc(el.dataset.detail)}</div>` : ''}${el.dataset.earned ? `<div class="tt-detail">Unlocked ${new Date(+el.dataset.earned).toLocaleString()}</div>` : ''}`;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2;
  x = Math.max(8, Math.min(innerWidth - tw - 8, x));
  let y = r.top - th - 8;
  if (y < 8) y = r.bottom + 8;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
  tip.dataset.for = el.dataset.badge + el.dataset.earned;
}
document.addEventListener('mouseover', (e) => { const b = e.target.closest('.badge-ico'); if (b) showTip(b); });
document.addEventListener('mouseout', (e) => { if (e.target.closest('.badge-ico') && !e.relatedTarget?.closest?.('.badge-ico')) tip.hidden = true; });
document.addEventListener('click', (e) => {
  const b = e.target.closest('.badge-ico');
  if (b) { e.stopPropagation(); if (!tip.hidden && tip.dataset.for === b.dataset.badge + b.dataset.earned && e.pointerType !== 'mouse') tip.hidden = true; else showTip(b); return; }
  tip.hidden = true;
}, true);
addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });

async function onBadge({ badge, detail }) {
  const d = S.badgeDefs[badge];
  if (!d) return;
  const t = toast(`<span class="bi">${d.icon}</span><b>Badge unlocked: ${esc(d.name)}</b><br><span class="muted">${esc(detail || d.how)}</span>`, 'badge-toast', 6000);
  t.style.setProperty('--bc', d.color);
  await refreshMe();
  const card = $(`.ach[data-badge="${badge}"]`);
  if (card) card.classList.add('unlocking');
}

// ================= profile =================
async function renderProfile() {
  const root = $('#profile');
  if (!S.user) {
    root.innerHTML = `<div class="guest card"><h2>Paper trading on live Solana markets</h2>
      <p class="muted">Start with $1,000 in mock USD. Real live prices. Zero real money.</p>
      <button class="exec buy" style="max-width:280px;width:100%" data-auth="signup">Create free account</button>
      <p><button class="link-btn" data-auth="login">I already have one</button></p></div>`;
    return;
  }
  const u = S.user;
  if (!root.dataset.built || root.dataset.uid !== String(u.id)) {
    root.dataset.built = '1';
    root.dataset.uid = u.id;
    root.innerHTML = `
      <div class="pf-hero card pf-card">
        <div id="pfAvatar"></div>
        <div class="pf-who">
          <div class="pf-name"><span>${esc(u.username)}</span><span id="pfBadges"></span></div>
          <div class="pf-bio" id="pfBio"></div>
          <div class="pf-meta">${esc(u.email)} · trading since ${new Date(u.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</div>
        </div>
        <div class="pf-actions">
          <button class="btn-ghost" id="editProfileBtn">✎ Edit profile</button>
          <button class="btn-ghost" data-player="${esc(u.username)}">👁 Public view</button>
          <button class="btn-ghost" id="resetBtn">↺ Restart account</button>
          <button class="btn-ghost" id="logoutBtn">Log out</button>
        </div>
      </div>
      <div class="pf-stats card" id="pfStats"></div>
      <div class="pf-cal card pf-card">
        <div class="sec-title"><h3>Daily PnL</h3>
          <div class="cal-nav"><button class="btn-ghost small" id="calPrev" aria-label="Previous month">‹</button><span class="m" id="calMonth"></span><button class="btn-ghost small" id="calNext" aria-label="Next month">›</button></div>
        </div>
        <div class="cal-grid" id="calGrid"></div>
        <div class="cal-foot" id="calFoot"></div>
      </div>
      <div class="pf-faucet card pf-card">
        <div class="sec-title"><h3>Wallet</h3></div>
        <div id="walletLines"></div>
        <button class="exec buy" id="pfAddFunds" type="button">＋ Add funds</button>
        <button class="faucet-big" id="pfFaucet"></button>
        <p class="note">Add any amount of mock USD or SOL, as often as you like. Money you add is never counted as profit on the leaderboard. Only your trading is.</p>
        <div class="dep-list" id="depositList"></div>
      </div>
      <div class="pf-mycoins card pf-card">
        <div class="sec-title"><h3>My coins</h3><span class="muted" id="myCoinsCount"></span></div>
        <div style="overflow-x:auto"><table class="trades-table mycoins" id="myCoins"></table></div>
      </div>
      <div class="pf-ach card pf-card">
        <div class="sec-title"><h3>Achievements</h3><span class="muted" id="achCount"></span></div>
        <div class="ach-grid" id="achGrid"></div>
      </div>
      <div class="pf-trades card pf-card">
        <div class="sec-title"><h3>Recent trades</h3></div>
        <div style="overflow-x:auto"><table class="trades-table" id="tradesTable"></table></div>
      </div>`;
    $('#logoutBtn').addEventListener('click', logout);
    $('#resetBtn').addEventListener('click', () => { $('#resetErr').textContent = ''; openModal('#resetModal'); });
    $('#pfFaucet').addEventListener('click', claimFaucet);
    $('#pfAddFunds').addEventListener('click', () => openFunds());
    $('#editProfileBtn').addEventListener('click', openProfileEdit);
    $('#myCoins').addEventListener('click', (e) => {
      const rm = e.target.closest('[data-unwatch]');
      if (rm) { e.stopPropagation(); toggleWatch(rm.dataset.unwatch); return; }
      const row = e.target.closest('[data-open]');
      if (row) location.hash = `coin/${row.dataset.open}`;
    });
    $('#calPrev').addEventListener('click', () => { S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() - 1, 1); renderCalendar(); });
    $('#calNext').addEventListener('click', () => { S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() + 1, 1); renderCalendar(); });
    loadProfileData();
  }
  renderProfileLive();
}
async function loadProfileData() {
  try {
    const [snaps, trades, realized] = await Promise.all([api('/api/me/snapshots?days=400'), api('/api/me/trades?limit=40'), api('/api/me/realized?days=400')]);
    S.snapshots = snaps;
    S.realized = realized;
    renderCalendar();
    $('#tradesTable').innerHTML = trades.length ? `<thead><tr><th>Time</th><th>Side</th><th>Token</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Value</th><th class="r">PnL</th></tr></thead><tbody>${trades.map((t) => `
      <tr><td class="muted">${new Date(t.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
      <td class="${t.side === 'buy' ? 'up' : 'down'}" style="font-weight:800">${t.side.toUpperCase()}</td>
      <td><a href="#coin/${esc(t.token)}" style="color:inherit">${esc(t.symbol)}</a> <span class="muted">${t.currency}</span></td>
      <td class="r">${fmtQty(t.qty)}</td><td class="r">${fmtPrice(t.price)}</td><td class="r">${fmtUsd(t.usd_value)}</td>
      <td class="r ${cls(t.pnl_usd)}">${t.side === 'sell' ? `${fmtUsd(t.pnl_usd, { sign: true })} (${fmtPct(t.pnl_pct, 0)})` : ''}</td></tr>`).join('')}</tbody>`
      : `<tr><td class="muted" style="padding:20px 8px">No trades yet. Head to Trending Coins and make your first move.</td></tr>`;
  } catch (e) { toast(esc(e.message), 'err'); }
}
function renderProfileLive() {
  const u = S.user;
  if (!u || !$('#pfStats')) return;
  $('#pfBadges').innerHTML = badgeIcons(u.badges);
  $('#pfAvatar').innerHTML = avatarHtml(u, 'xl');
  $('#pfBio').textContent = u.bio || 'No bio yet. Tap Edit profile to add one.';
  $('#pfBio').classList.toggle('muted', !u.bio);
  renderMyCoins();
  $('#depositList').innerHTML = (u.deposits || []).length ? `<div class="k">Recent top-ups</div>${u.deposits.slice(0, 6).map((d) =>
    `<div class="wallet-line"><span class="muted">${new Date(d.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${d.currency === 'SOL' ? fmtSol(d.amount) : fmtUsd(d.amount)}</span><b>+${fmtUsd(d.usdValue)}</b></div>`).join('')}` : '';
  const allTimePct = u.netDeposits > 0 ? (u.profit / u.netDeposits) * 100 : 0;
  $('#pfStats').innerHTML = [
    ['Portfolio value', fmtUsd(u.value), ''],
    ['All-time PnL', `<span class="${cls(u.profit)}">${fmtUsd(u.profit, { sign: true })}</span>`, fmtPct(allTimePct)],
    ['Mock USD', fmtUsd(u.usd), 'cash'],
    ['Mock SOL', fmtSol(u.sol), `≈ ${fmtUsd(u.sol * (S.sol || u.solPrice))}`],
    ['In positions', fmtUsd(u.holdings), `${u.positions.length} open`],
  ].map(([k, v, s]) => `<div class="pf-stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
  $('#walletLines').innerHTML = `
    <div class="wallet-line"><span class="muted">Mock USD</span><b>${fmtUsd(u.usd)}</b></div>
    <div class="wallet-line"><span class="muted">Mock SOL</span><b>${fmtSol(u.sol)}</b></div>
    <div class="wallet-line"><span class="muted">SOL price (live)</span><b>${fmtUsd(S.sol || u.solPrice)}</b></div>
    <div class="wallet-line"><span class="muted">Total deposited</span><b>${fmtUsd(u.netDeposits)}</b></div>`;
  const earned = new Map(u.badges.map((b) => [b.id, b]));
  $('#achCount').textContent = `${earned.size} / ${Object.keys(S.badgeDefs).length} unlocked`;
  const grid = $('#achGrid');
  const sig = [...earned.keys()].join();
  if (grid.dataset.sig !== sig) {
    grid.dataset.sig = sig;
    grid.innerHTML = Object.entries(S.badgeDefs).map(([id, d]) => {
      const e = earned.get(id);
      return `<div class="ach ${e ? 'on' : ''}" data-badge="${id}" style="--bc:${d.color}">
        ${e ? '' : '<span class="lock">🔒 Locked</span>'}
        <div class="ico">${d.icon}</div><div class="nm">${esc(d.name)}</div><div class="how">${esc(d.how)}</div>
        <div class="when">${e ? `Unlocked ${new Date(e.earnedAt).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}${e.detail ? `<br><span class="muted">${esc(e.detail)}</span>` : ''}` : 'Not earned yet'}</div>
      </div>`;
    }).join('');
  }
  updateFaucetButtons();
  renderCalendar(true);
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
// Daily PnL = realized profit/loss: the sum of what each sell made or lost that day (your local time).
// Coins you still hold don't change past days; they show as "unrealized" under the calendar.
function dailyPnl() {
  const out = new Map();
  for (const r of S.realized || []) {
    const k = dayKey(new Date(r.ts));
    out.set(k, (out.get(k) || 0) + r.pnl);
  }
  return out;
}
function noteRealized(t) {
  if (t?.side !== 'sell' || t.pnlUsd == null) return;
  (S.realized ||= []).push({ ts: Date.now(), pnl: t.pnlUsd });
  if (S.view === 'profile') renderCalendar();
}
function renderCalendar(liveOnly) {
  const grid = $('#calGrid');
  if (!grid || !S.user) return;
  const m = S.calMonth;
  $('#calMonth').textContent = m.toLocaleDateString([], { month: 'long', year: 'numeric' }).toUpperCase();
  const pnl = dailyPnl();
  const today = new Date();
  const created = new Date(S.user.createdAt); created.setHours(0, 0, 0, 0);
  const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  if (liveOnly && grid.dataset.m === String(m.getTime())) {
    const k = dayKey(today);
    const cell = grid.querySelector(`[data-k="${k}"]`);
    if (cell) paintDay(cell, pnl.get(k));
    renderCalFoot(pnl, m, days);
    return;
  }
  grid.dataset.m = m.getTime();
  let html = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map((d) => `<div class="cal-dow">${d}</div>`).join('');
  for (let i = 0; i < m.getDay(); i++) html += `<div class="cal-day empty"></div>`;
  for (let d = 1; d <= days; d++) {
    const date = new Date(m.getFullYear(), m.getMonth(), d);
    const k = dayKey(date);
    const future = date > today;
    const before = date < created;
    html += `<div class="cal-day ${future ? 'future' : ''} ${dayKey(today) === k ? 'today' : ''}" data-k="${k}" ${before || future ? 'data-none="1"' : ''}><span class="d">${d}</span><span class="a"></span></div>`;
  }
  grid.innerHTML = html;
  for (const cell of grid.querySelectorAll('.cal-day[data-k]')) paintDay(cell, cell.dataset.none ? null : pnl.get(cell.dataset.k));
  renderCalFoot(pnl, m, days);
}
function paintDay(cell, v) {
  cell.classList.remove('pos', 'neg', 'flat');
  const a = cell.querySelector('.a');
  if (v == null) { a.textContent = ''; return; }
  if (Math.abs(v) < 0.005) { cell.classList.add('flat'); a.textContent = '$0'; cell.title = 'No change'; return; }
  cell.classList.add(v > 0 ? 'pos' : 'neg');
  const s = Math.abs(v) >= 1000 ? fmtUsd(v, { sign: true, compact: true }) : `${v > 0 ? '+' : '−'}$${Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 2)}`;
  a.textContent = s;
  cell.title = `${fmtUsd(v, { sign: true })} realized from sells that day`;
}
function renderCalFoot(pnl, m, days) {
  let total = 0, green = 0, red = 0;
  for (let d = 1; d <= days; d++) {
    const v = pnl.get(dayKey(new Date(m.getFullYear(), m.getMonth(), d)));
    if (v == null) continue;
    total += v;
    if (v > 0.005) green++; else if (v < -0.005) red++;
  }
  const open = (S.user?.positions || []).reduce((s, p) => s + (p.pnlUsd || 0), 0);
  $('#calFoot').innerHTML = `<span><span class="up">${green} green</span> · <span class="down">${red} red</span> days</span>
    <span>Month realized <b class="${cls(total)}">${fmtUsd(total, { sign: true })}</b>${S.user?.positions?.length ? ` · open positions <b class="${cls(open)}">${fmtUsd(open, { sign: true })}</b> unrealized` : ''}</span>`;
}
setInterval(() => { if (S.view === 'profile') renderProfileLive(); }, 2000);
setInterval(() => { if (S.view === 'profile' && S.user) loadProfileData(); }, 120_000);

// ================= avatars =================
function avatarHtml(u, size = '') {
  if (u?.photoUrl) return `<img class="av photo ${size}" src="${esc(u.photoUrl)}" alt="" loading="lazy">`;
  const color = u?.color || `hsl(${hue(u?.username)} 90% 60%)`;
  const inner = u?.avatar ? esc(u.avatar) : esc(String(u?.username || '?')[0].toUpperCase());
  return `<span class="av ${size} ${u?.avatar ? 'emoji' : ''}" style="--avc:${esc(color)}">${inner}</span>`;
}

// ================= my coins (profile) =================
function renderMyCoins() {
  const box = $('#myCoins');
  if (!box || !S.user) return;
  const pos = S.user.positions || [];
  const watch = (S.user.watchlist || []).map((w) => ({ ...w, ...(S.tokens.get(w.address) || {}) }));
  $('#myCoinsCount').textContent = `${pos.length} holding · ${watch.length} watching`;
  const head = `<thead><tr><th>Coin</th><th class="r">Price</th><th class="r">24h</th><th class="r hide-sm">Value</th><th class="r">PnL</th><th></th></tr></thead>`;
  const holdRows = pos.map((p) => `<tr class="click" data-open="${esc(p.address)}">
      <td><span class="mc-coin">${coinImg(p)}<b>${esc(p.symbol)}</b><span class="held-dot">HELD</span></span></td>
      <td class="r">${fmtPrice(p.price)}</td><td class="r ${cls(S.tokens.get(p.address)?.change24h)}">${fmtPct(S.tokens.get(p.address)?.change24h, 1)}</td>
      <td class="r hide-sm">${fmtUsd(p.value)}</td><td class="r ${cls(p.pnlUsd)}">${fmtUsd(p.pnlUsd, { sign: true })}<br><small>${fmtPct(p.pnlPct, 1)}</small></td><td></td></tr>`).join('');
  const watchRows = watch.map((w) => `<tr class="click" data-open="${esc(w.address)}">
      <td><span class="mc-coin">${coinImg(w)}<b>${esc(w.symbol)}</b><span class="star-on">★</span></span></td>
      <td class="r">${fmtPrice(w.priceUsd)}</td><td class="r ${cls(w.change24h)}">${fmtPct(w.change24h, 1)}</td>
      <td class="r hide-sm muted">MC ${fmtUsd(w.marketCap, { compact: true })}</td><td class="r muted">watching</td>
      <td class="r"><button class="btn-ghost small" data-unwatch="${esc(w.address)}" aria-label="Stop watching ${esc(w.symbol)}">✕</button></td></tr>`).join('');
  box.innerHTML = pos.length || watch.length ? head + `<tbody>${holdRows}${watchRows}</tbody>`
    : `<tr><td class="muted" style="padding:20px 8px">No coins yet. Buy a coin, or open any coin and tap <b>☆ Watch</b> to track it here.</td></tr>`;
}

// ================= dialogs =================
function openModal(id) { const m = $(id); m.hidden = false; return m; }
function closeModal(m) { m.hidden = true; }
document.addEventListener('click', (e) => {
  const x = e.target.closest('[data-close]');
  if (x) closeModal(x.closest('.modal'));
  else if (e.target.matches?.('.modal[data-modal]')) closeModal(e.target);
  const pl = e.target.closest('[data-player]');
  if (pl) { e.preventDefault(); openPlayer(pl.dataset.player); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal[data-modal]').forEach((m) => { m.hidden = true; }); });

// ---- add funds ----
let fundsCur = 'USD';
$('#resetConfirm').addEventListener('click', async () => {
  const b = $('#resetConfirm');
  b.disabled = true;
  try {
    const r = await api('/api/reset', { confirm: 'RESET' });
    S.user = r.user;
    S.myTokenTrades = [];
    S.snapshots = [];
    S.realized = [];
    closeModal($('#resetModal'));
    renderAcct(); renderPositions(); renderHomeSide(); updateChartLines(); updateEstimate(); renderMyTrades();
    if (S.view === 'profile') renderProfile();
    toast('<b>Account restarted</b> · you have $1,000 in paper USD.', 'info', 4000);
  } catch (e) { $('#resetErr').textContent = e.message; } finally { b.disabled = false; }
});

function openFunds() {
  if (!S.user) return openAuth('signup');
  openModal('#fundsModal');
  $('#fundsErr').textContent = '';
  setFundsCur(fundsCur);
  setTimeout(() => $('#fundsAmount').focus(), 30);
}
function setFundsCur(cur) {
  fundsCur = cur;
  $$('[data-fcur]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.fcur === cur));
  $('#fundsPrefix').textContent = cur === 'USD' ? '$' : '◎';
  $('#fundsAmount').placeholder = cur === 'USD' ? '10,000' : '50';
  $('#fundsQuick').innerHTML = (cur === 'USD' ? [1000, 10000, 100000, 1000000] : [10, 100, 1000, 5000])
    .map((v) => `<button type="button" data-famt="${v}">${cur === 'USD' ? '$' + (v >= 1e6 ? v / 1e6 + 'M' : v >= 1e3 ? v / 1e3 + 'K' : v) : '◎' + v.toLocaleString()}</button>`).join('');
  updateFundsEst();
}
function updateFundsEst() {
  const amt = Number(String($('#fundsAmount').value).replace(/,/g, ''));
  const sol = S.sol || S.user?.solPrice || 0;
  const usd = fundsCur === 'USD' ? amt : amt * sol;
  const max = S.user?.maxDepositUsd || 1e6;
  $('#fundsEst').innerHTML = !(amt > 0) ? `Up to ${fmtUsd(max, { compact: true })} per top-up. Top up as many times as you like.`
    : `${fundsCur === 'SOL' ? `${fmtSol(amt)} ≈ <b>${fmtUsd(usd)}</b> at live SOL ${fmtUsd(sol)}` : `Adds <b>${fmtUsd(usd)}</b> mock USD`}`
      + (usd > max ? `<br><span class="down">Too much for one top-up. Max is ${fmtUsd(max)}.</span>` : '');
}
$$('[data-fcur]').forEach((b) => b.addEventListener('click', () => setFundsCur(b.dataset.fcur)));
$('#fundsQuick').addEventListener('click', (e) => { const b = e.target.closest('[data-famt]'); if (b) { $('#fundsAmount').value = b.dataset.famt; updateFundsEst(); } });
$('#fundsAmount').addEventListener('input', () => { const el = $('#fundsAmount'); el.value = el.value.replace(/[^0-9.,]/g, ''); updateFundsEst(); });
$('#fundsDrop').addEventListener('click', async () => { closeModal($('#fundsModal')); await claimFaucet(); });
$('#fundsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = Number(String($('#fundsAmount').value).replace(/,/g, ''));
  if (!(amount > 0)) { $('#fundsErr').textContent = 'Enter an amount to add.'; return; }
  const btn = $('#fundsSubmit');
  btn.disabled = true;
  try {
    const r = await api('/api/deposit', { amount, currency: fundsCur });
    S.user = r.user;
    mergeWatchlist();
    recomputeAccount();
    renderAcct(); updateBalances(); updateEstimate();
    if (S.view === 'profile') renderProfileLive();
    closeModal($('#fundsModal'));
    $('#fundsAmount').value = '';
    toast(`💰 <b>+${fundsCur === 'USD' ? fmtUsd(r.deposit.amount) : fmtSol(r.deposit.amount)}</b> added to your wallet${fundsCur === 'SOL' ? `<br><span class="muted">≈ ${fmtUsd(r.deposit.usdValue)}</span>` : ''}`, 'info');
  } catch (err) { $('#fundsErr').textContent = err.message; }
  finally { btn.disabled = false; }
});

// ---- edit profile ----
let peAvatar = null, peColor = null;
let pePhoto; // undefined = keep current, null = remove, string = new picture (data URL)
async function openProfileEdit() {
  if (!S.options) { try { S.options = await api('/api/options'); } catch (e) { return toast(esc(e.message), 'err'); } }
  peAvatar = S.user.avatar; peColor = S.user.color; pePhoto = undefined;
  $('#pePhotoInput').value = '';
  $('#peBio').value = S.user.bio || '';
  $('#peErr').textContent = '';
  renderProfileEditor();
  openModal('#profileModal');
}
function renderProfileEditor() {
  const o = S.options;
  $('#peAvatars').innerHTML = `<button type="button" role="radio" aria-checked="${!peAvatar}" data-av="" title="Use my initial">${esc(S.user.username[0].toUpperCase())}</button>`
    + o.avatars.map((a) => `<button type="button" role="radio" aria-checked="${peAvatar === a}" data-av="${a}">${a}</button>`).join('');
  $('#peColors').innerHTML = o.colors.map((c) => `<button type="button" role="radio" aria-checked="${peColor === c}" aria-label="Color ${c}" data-col="${c}" style="--sw:${c}"></button>`).join('');
  $('#peCount').textContent = `${$('#peBio').value.length}/140`;
  const photoUrl = pePhoto === undefined ? S.user.photoUrl : pePhoto;
  $('#pePhotoRemove').hidden = !photoUrl;
  $('#pePreview').innerHTML = `${avatarHtml({ ...S.user, avatar: peAvatar, color: peColor, photoUrl }, 'xl')}<div><b>${esc(S.user.username)}</b><div class="muted">${esc($('#peBio').value) || 'Your bio shows here'}</div></div>`;
}
$('#peAvatars').addEventListener('click', (e) => { const b = e.target.closest('[data-av]'); if (b) { peAvatar = b.dataset.av || null; pePhoto = null; renderProfileEditor(); } });
$('#pePhotoRemove').addEventListener('click', () => { pePhoto = null; renderProfileEditor(); });
$('#pePhotoInput').addEventListener('change', async () => {
  const file = $('#pePhotoInput').files[0];
  if (!file) return;
  $('#peErr').textContent = '';
  if (!/^image\//.test(file.type)) { $('#peErr').textContent = 'Pick an image file (JPG, PNG or WebP).'; return; }
  if (file.size > 15e6) { $('#peErr').textContent = 'That image is over 15 MB. Pick a smaller one.'; return; }
  try { pePhoto = await squarePhoto(file, 192); renderProfileEditor(); }
  catch { $('#peErr').textContent = /heic|heif/i.test(file.type + file.name) ? "iPhone HEIC photos can't be read here. Take a screenshot of it, or save it as JPG, and upload that." : "Couldn't read that image. Try a different one."; }
});
// Crop to the centre square and shrink to size×size, so uploads stay tiny.
async function squarePhoto(file, size) {
  // Read the file as a data: URL (blob: URLs can be blocked by the page's security rules).
  const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
  {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    let out = cv.toDataURL('image/webp', 0.86);
    if (!out.startsWith('data:image/webp')) out = cv.toDataURL('image/jpeg', 0.86);
    return out;
  }
}
$('#peColors').addEventListener('click', (e) => { const b = e.target.closest('[data-col]'); if (b) { peColor = b.dataset.col; renderProfileEditor(); } });
$('#peBio').addEventListener('input', renderProfileEditor);
$('#profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#peSave');
  btn.disabled = true;
  try {
    const body = { avatar: peAvatar, color: peColor, bio: $('#peBio').value };
    if (pePhoto !== undefined) body.photo = pePhoto;
    const r = await api('/api/profile', body);
    S.user = r.user;
    closeModal($('#profileModal'));
    renderProfileLive();
    renderAcct(); renderHomeSide();
    toast('<b>Profile saved</b>', 'info', 2000);
  } catch (err) { $('#peErr').textContent = err.message; }
  finally { btn.disabled = false; }
});

// ---- view a player's public profile ----
async function openPlayer(username) {
  const card = $('#playerCard');
  card.innerHTML = `<button type="button" class="modal-x" data-close aria-label="Close">✕</button><div class="tape-empty">Loading ${esc(username)}…</div>`;
  openModal('#playerModal');
  try {
    const p = await api(`/api/players/${encodeURIComponent(username)}`);
    card.innerHTML = `<button type="button" class="modal-x" data-close aria-label="Close">✕</button>
      <div class="pp-hero">${avatarHtml(p, 'xl')}<div>
        <div class="pf-name"><span>${esc(p.username)}</span>${p.isMe ? '<span class="you-tag">YOU</span>' : ''}${badgeIcons(p.badges)}</div>
        <div class="${p.bio ? '' : 'muted'}">${esc(p.bio || 'No bio yet.')}</div>
        <div class="pf-meta">trading since ${new Date(p.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</div>
      </div></div>
      <div class="pp-stats">
        <div><div class="k">All-time PnL</div><div class="v ${cls(p.profit)}">${fmtUsd(p.profit, { sign: true })}</div></div>
        <div><div class="k">Portfolio</div><div class="v">${fmtUsd(p.value, { compact: true })}</div></div>
        <div><div class="k">Trades</div><div class="v">${p.trades}</div></div>
        <div><div class="k">Win rate</div><div class="v">${p.winRate == null ? '—' : Math.round(p.winRate) + '%'}</div></div>
        <div><div class="k">Best trade</div><div class="v ${cls(p.bestTradePct)}">${p.bestTradePct == null ? '—' : fmtPct(p.bestTradePct, 0)}</div></div>
      </div>
      <div class="k pp-sub">Open positions</div>
      ${p.positions.length ? p.positions.map((x) => `<a class="pp-pos" href="#coin/${esc(x.address)}" data-close>${coinImg(x)}<b>${esc(x.symbol)}</b><span>${fmtUsd(x.value)}</span><span class="${cls(x.pnlPct)}">${fmtPct(x.pnlPct, 1)}</span></a>`).join('') : '<div class="muted">None right now.</div>'}
      <div class="k pp-sub">Recent trades</div>
      ${p.recentTrades.length ? p.recentTrades.map((t) => `<div class="pp-trade"><span class="${t.side === 'buy' ? 'up' : 'down'}">${t.side.toUpperCase()}</span><span>${esc(t.symbol)}</span><span>${fmtUsd(t.usdValue, { compact: true })}</span><span class="${cls(t.pnlPct)}">${t.side === 'sell' && t.pnlPct != null ? fmtPct(t.pnlPct, 0) : ''}</span><span class="muted">${ago(t.ts)} ago</span></div>`).join('') : '<div class="muted">No trades yet.</div>'}`;
  } catch (e) { card.innerHTML = `<button type="button" class="modal-x" data-close aria-label="Close">✕</button><div class="tape-empty">${esc(e.message)}</div>`; }
}

// ================= auth =================
let authMode = 'signup';
function openAuth(mode = 'signup') {
  authMode = mode;
  const signup = mode === 'signup';
  $('#authTitle').textContent = signup ? 'Create account' : 'Welcome back';
  $('#authSub').innerHTML = signup ? 'Get <b class="up">$1,000 mock USD</b> to trade real trending memecoins. No real money, ever.' : 'Log in to keep trading.';
  $('#userField').hidden = !signup;
  $('#authForm').password.autocomplete = signup ? 'new-password' : 'current-password';
  $('#authSubmit').textContent = signup ? 'Start trading' : 'Log in';
  $('#authSwitch').textContent = signup ? 'Already have an account? Log in' : 'New here? Create an account';
  $('#authErr').textContent = '';
  $('#authModal').hidden = false;
  setTimeout(() => (signup ? $('#authForm').username : $('#authForm').email).focus(), 30);
}
function closeAuth() { $('#authModal').hidden = true; }
$('#authSwitch').addEventListener('click', () => openAuth(authMode === 'signup' ? 'login' : 'signup'));
$('#authClose').addEventListener('click', closeAuth);
$('#authModal').addEventListener('click', (e) => { if (e.target.id === 'authModal') closeAuth(); });
$('#authModal').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAuth(); });
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = $('#authSubmit');
  btn.disabled = true;
  $('#authErr').textContent = '';
  try {
    if (authMode === 'signup') await api('/api/auth/register', { username: f.username.value, email: f.email.value, password: f.password.value });
    else await api('/api/auth/login', { email: f.email.value, password: f.password.value });
    f.reset();
    closeAuth();
    await refreshMe();
    toast(authMode === 'signup' ? `<b>Account created</b> · $1,000 in paper USD is in your wallet.` : `<b>Logged in</b> · welcome back, ${esc(S.user.username)}`);
    if (S.selected) loadMyTokenTrades();
  } catch (err) { $('#authErr').textContent = err.message; }
  finally { btn.disabled = false; }
});
async function logout() {
  await api('/api/auth/logout', {}).catch(() => {});
  S.user = null;
  $('#profile').dataset.built = '';
  await refreshMe();
  location.hash = 'trending';
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-auth]');
  if (a) { e.preventDefault(); openAuth(a.dataset.auth); }
});

// ================= routing =================
function route() {
  const h = location.hash.replace(/^#/, '') || 'trending';
  let view = h;
  if (h.startsWith('coin/')) { view = 'trending'; selectToken(h.slice(5)); }
  else {
    S.onCoin = false;
    $('#homeView').hidden = false;
    $('#coinView').hidden = true;
    closeSheet();
    renderCoinList();
    renderHomeSide();
  }
  if (!['trending', 'leaderboard', 'profile'].includes(view)) view = 'trending';
  S.view = view;
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', t.dataset.view === view));
  $$('.view').forEach((v) => { v.dataset.active = v.id === `view-${view}`; });
  clearInterval(lbTimer);
  if (view === 'leaderboard') { loadLeaderboard(); lbTimer = setInterval(loadLeaderboard, 15_000); }
  if (view === 'profile') renderProfile();
  if (view !== 'trending') closePositions();
  if (view === 'trending' && !h.startsWith('coin/')) document.title = 'MemeSim — Memecoin Paper Trading';
}
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  const v = t.dataset.view;
  location.hash = v === 'trending' && S.selected && !isMobile() ? `coin/${S.selected}` : v;
}));
addEventListener('hashchange', route);

// ================= boot =================
(async function boot() {
  setSide('buy');
  setCur('USD');
  try { S.badgeDefs = await api('/api/badges'); } catch { /* ignore */ }
  try { S.feed = await api('/api/feed'); } catch { /* ignore */ }
  try { await refreshMe(); } catch { /* offline */ }
  connectStream();
  route();
  setInterval(() => { if (S.user) refreshMe().catch(() => {}); }, 30_000);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
