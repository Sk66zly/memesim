// MemeSim front-end — vanilla JS, no build step.
import { CandleChart } from './chart.js';

// ================= helpers =================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isMobile = () => matchMedia('(max-width: 860px)').matches;
const isDrawer = () => matchMedia('(max-width: 1240px)').matches;

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
  tf: 1,
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
    for (const t of d.tokens) S.tokens.set(t.address, { ...S.tokens.get(t.address), ...t });
    renderCoinList();
    renderTicker();
  });
  es.addEventListener('prices', (e) => onPrices(JSON.parse(e.data)));
  es.addEventListener('tape', (e) => {
    const d = JSON.parse(e.data);
    if (d.address !== S.selected) return;
    addTape(d.trades, !d.initial);
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

function onPrices({ sol, tokens }) {
  if (sol) S.sol = sol;
  for (const t of tokens) {
    const prev = S.tokens.get(t.address);
    const dir = prev?.priceUsd ? Math.sign(t.priceUsd - prev.priceUsd) : 0;
    S.tokens.set(t.address, { ...prev, ...t });
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
      <button class="faucet-btn" id="hdrFaucet" title="Add free mock SOL"></button>
      <a class="bal-chip" href="#profile" style="text-decoration:none;color:inherit">
        <span class="v" id="hdrVal"></span><span class="p" id="hdrPnl"></span>
      </a>`;
    $('#hdrFaucet').addEventListener('click', claimFaucet);
  }
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
  const hdr = $('#hdrFaucet');
  if (hdr) {
    hdr.disabled = left > 0;
    hdr.innerHTML = left > 0 ? `💧 ${fmtCountdown(left)}` : `💧 +${amt} SOL<span class="lbl hide-xs"> FAUCET</span>`;
  }
  const big = $('#pfFaucet');
  if (big) {
    big.disabled = left > 0;
    big.textContent = left > 0 ? `RECHARGING · ${fmtCountdown(left)}` : `💧 CLAIM +${amt} MOCK SOL (≈ ${fmtUsd(usd)})`;
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
  renderAcct();
  renderPositions();
  updateBalances();
  updateEstimate();
  if (S.selected) { updateChartLines(); renderCoinList(); }
  if (S.view === 'profile') renderProfile();
  if (!had !== !S.user) connectStream(); // reconnect so badge pushes reach us
}

// ================= coin list =================
function sortedTrending() {
  const list = S.trending.map((a) => S.tokens.get(a)).filter(Boolean);
  const by = { gainers: 'change24h', m5: 'change5m', volume: 'volume24h' }[S.sort];
  if (by) list.sort((a, b) => (b[by] ?? -Infinity) - (a[by] ?? -Infinity));
  return list;
}
function renderCoinList() {
  const rows = $('#coinRows');
  const list = sortedTrending();
  $('#coinCount').textContent = `${list.length} coins`;
  const held = new Set((S.user?.positions || []).map((p) => p.address));
  rows.innerHTML = list.map((t, i) => `
    <button class="coin-row" role="listitem" data-addr="${esc(t.address)}" aria-current="${t.address === S.selected}">
      <span class="rank">${i + 1}</span>
      ${coinImg(t)}
      <span class="coin-main">
        <span class="coin-sym">${esc(t.symbol)}${held.has(t.address) ? '<span class="held-dot">HELD</span>' : ''}</span>
        <span class="coin-sub">MC ${fmtUsd(t.marketCap, { compact: true })} · V ${fmtUsd(t.volume24h, { compact: true })}</span>
      </span>
      <span class="coin-right">
        <span class="coin-price" data-f="price">${fmtPrice(t.priceUsd)}</span><br>
        <span class="coin-chg ${cls(t.change24h)}" data-f="chg">${fmtPct(t.change24h, 1)}</span>
      </span>
    </button>`).join('') || `<div class="tape-empty">Loading trending coins…</div>`;
}
function updateCoinRow(addr, dir) {
  const row = $(`.coin-row[data-addr="${CSS.escape(addr)}"]`);
  if (!row) return;
  const t = S.tokens.get(addr);
  const price = row.querySelector('[data-f="price"]');
  price.textContent = fmtPrice(t.priceUsd);
  const chg = row.querySelector('[data-f="chg"]');
  chg.textContent = fmtPct(t.change24h, 1);
  chg.className = `coin-chg ${cls(t.change24h)}`;
  flashEl(row, dir);
}

$('#coinRows').addEventListener('click', (e) => {
  const row = e.target.closest('.coin-row');
  if (row) location.hash = `coin/${row.dataset.addr}`;
});
$$('.sort-chips .chip').forEach((b) => b.addEventListener('click', () => {
  S.sort = b.dataset.sort;
  $$('.sort-chips .chip').forEach((x) => x.setAttribute('aria-pressed', x === b));
  renderCoinList();
}));
$('#caSearch').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#caInput').value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return toast('That doesn\'t look like a Solana token address.', 'err');
  $('#caInput').value = '';
  location.hash = `coin/${v}`;
});

// ================= terminal =================
async function selectToken(addr) {
  const changed = S.selected !== addr;
  S.selected = addr;
  S.sellPercent = null;
  $('#termEmpty').hidden = true;
  $('#termBody').hidden = false;
  $('#tradeLayout').classList.add('show-term');
  $$('.coin-row').forEach((r) => r.setAttribute('aria-current', r.dataset.addr === addr));

  if (!S.tokens.get(addr)?.priceUsd) {
    try { const d = await api(`/api/token/${addr}`); S.tokens.set(addr, { ...S.tokens.get(addr), ...d.token }); }
    catch (e) { toast(esc(e.message), 'err'); location.hash = 'trending'; return; }
  }
  renderTermHead();
  if (!chart) {
    chart = new CandleChart($('#chartWrap'), { formatPrice: (p) => fmtPrice(p).replace('$', ''), onActivate: activateTrade });
  }
  if (changed) {
    chart.setData([]);
    $('#tapeRows').innerHTML = `<div class="tape-empty">Listening for on-chain trades…</div>`;
    connectStream();
    loadCandles();
    loadMyTokenTrades();
  }
  updateChartLines();
  renderPositions();
  updateBalances();
  updateEstimate();
  if (S.user?.positions.some((p) => p.address === addr) && isDrawer() && !isMobile()) openPositions(true);
  window.scrollTo({ top: 0 });
}

async function loadCandles() {
  const addr = S.selected;
  try {
    const candles = await api(`/api/candles/${addr}?tf=${S.tf}`);
    if (addr !== S.selected) return;
    chart.setData(candles);
  } catch { /* stays empty until ticks arrive */ }
}
async function loadMyTokenTrades() {
  if (!S.user) { S.myTokenTrades = []; return; }
  try { S.myTokenTrades = (await api('/api/me/trades?limit=200')).filter((t) => t.token === S.selected); } catch { S.myTokenTrades = []; }
}

function renderTermHead() {
  const t = S.tokens.get(S.selected);
  if (!t) return;
  const img = $('#tokImg');
  if (t.image) { img.src = t.image; img.style.display = ''; img.referrerPolicy = 'no-referrer'; img.onerror = () => { img.style.display = 'none'; }; }
  else img.style.display = 'none';
  $('#tokSym').textContent = '$' + (t.symbol || '?');
  $('#tokName').textContent = t.name || '';
  $('#tokPrice').textContent = fmtPrice(t.priceUsd);
  $('#tokChg').innerHTML = [['5m', t.change5m], ['1h', t.change1h], ['24h', t.change24h]]
    .map(([k, v]) => `<span class="${cls(v)}">${k} ${fmtPct(v, 1)}</span>`).join('');
  const age = t.createdAt ? ago(t.createdAt) : '—';
  $('#statStrip').innerHTML = [
    ['Mkt Cap', fmtUsd(t.marketCap, { compact: true })], ['Liquidity', fmtUsd(t.liquidity, { compact: true })],
    ['24h Vol', fmtUsd(t.volume24h, { compact: true })],
    ['5m Txns', t.buys5m != null ? `<span class="up">${t.buys5m}B</span> / <span class="down">${t.sells5m}S</span>` : '—'],
    ['Age', age],
  ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  document.title = `${t.symbol} ${fmtPrice(t.priceUsd)} · MemeSim`;
}

function onSelectedTick(t, dir) {
  const el = $('#tokPrice');
  el.textContent = fmtPrice(t.priceUsd);
  el.className = `tok-price ${dir > 0 ? 'up' : dir < 0 ? 'down' : ''}`;
  flashText(el, dir);
  renderTermHead();
  // roll the live candle forward
  if (chart && t.priceUsd) {
    const step = S.tf * 60;
    const bucket = Math.floor(Date.now() / 1000 / step) * step;
    const last = chart.data[chart.data.length - 1];
    if (last && last.time === bucket) chart.update({ ...last, high: Math.max(last.high, t.priceUsd), low: Math.min(last.low, t.priceUsd), close: t.priceUsd });
    else if (!last || bucket > last.time) chart.update({ time: bucket, open: last ? last.close : t.priceUsd, high: t.priceUsd, low: t.priceUsd, close: t.priceUsd, volume: 0 });
  }
}

function updateChartLines() {
  if (!chart) return;
  const p = S.user?.positions.find((x) => x.address === S.selected);
  chart.setLines(p ? [{ price: p.avgEntry, label: 'AVG ENTRY', color: '#00e5ff' }] : []);
}

$$('.tf').forEach((b) => b.addEventListener('click', () => {
  S.tf = Number(b.dataset.tf);
  $$('.tf').forEach((x) => x.setAttribute('aria-pressed', x === b));
  loadCandles();
}));
$('#resetView').addEventListener('click', () => chart?.resetView());
$('#backBtn').addEventListener('click', () => { location.hash = 'trending'; });

// ---------- tape ----------
function addTape(trades, fresh) {
  const box = $('#tapeRows');
  if (box.querySelector('.tape-empty')) box.innerHTML = '';
  const html = trades.slice().reverse().map((t) => {
    const big = t.usd >= 1000;
    return `<div class="tape-row ${big ? 'big' : ''} ${fresh ? 'fresh-' + t.side : ''}">
      <span class="side-tag ${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? 'BUY' : 'SELL'}</span>
      <span class="muted">${esc(t.wallet || '')}</span>
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
  exec.textContent = side === 'buy' ? 'BUY' : 'SELL';
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
  if (S.view !== 'trending' || !S.selected || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || !$('#authModal').hidden) return;
  if (/^[0-9.]$/.test(e.key)) { activateTrade(); amountInput.value = (S.sellPercent != null ? '' : amountInput.value) + e.key; S.sellPercent = null; updateEstimate(); e.preventDefault(); }
  else if (e.key === 'b' || e.key === 'B') activateTrade({ side: 'buy' });
  else if (e.key === 's' || e.key === 'S') activateTrade({ side: 'sell' });
  else if (e.key === 'Escape') { closeSheet(); closePositions(); }
});

function updateBalances() {
  const el = $('#tbBal');
  if (!S.user) { el.innerHTML = `<span>Log in to trade</span><span></span>`; return; }
  const pos = currentPosition();
  el.innerHTML = `<span>Cash ${fmtUsd(S.user.usd)} · ${fmtSol(S.user.sol)}</span><span>${pos ? `Hold ${fmtQty(pos.qty)}` : ''}</span>`;
}

function updateEstimate() {
  const est = $('#tradeEst');
  if (!est) return;
  const t = S.tokens.get(S.selected);
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
    if (t.side === 'buy') toast(`<b>BOUGHT</b> ${fmtQty(t.qty)} ${esc(t.symbol)} for ${fmtUsd(t.usdValue)}<br><span class="muted">@ ${fmtPrice(t.price)}</span>`);
    else toast(`<b>SOLD</b> ${fmtQty(t.qty)} ${esc(t.symbol)} for ${fmtUsd(t.usdValue)}<br><span class="${cls(t.pnlUsd)}">${fmtUsd(t.pnlUsd, { sign: true })} (${fmtPct(t.pnlPct, 1)})</span>`, t.pnlUsd < 0 ? 'err' : '');
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
    strip.hidden = true;
    return;
  }
  const ps = S.user.positions.slice().sort((a, b) => (b.address === S.selected) - (a.address === S.selected) || b.value - a.value);
  const tv = ps.reduce((s, p) => s + p.value, 0), tp = ps.reduce((s, p) => s + p.pnlUsd, 0), tc = ps.reduce((s, p) => s + p.costUsd, 0);
  $('#posCount').textContent = ps.length;
  $('#posTotal').innerHTML = `<div class="k">TOTAL POSITION VALUE</div><div class="v">${fmtUsd(tv)}</div>
    <div class="${cls(tp)}" style="font-weight:800">${fmtUsd(tp, { sign: true })} (${fmtPct(tc ? (tp / tc) * 100 : 0)}) unrealized</div>`;

  const cur = ps.find((p) => p.address === S.selected);
  handle.classList.toggle('has-up', !!cur && cur.pnlUsd >= 0);
  handle.classList.toggle('has-down', !!cur && cur.pnlUsd < 0);
  if (cur) {
    strip.hidden = false;
    strip.innerHTML = `<span class="lbl">YOUR POSITION</span><span>${fmtQty(cur.qty)} · avg ${fmtPrice(cur.avgEntry)}</span>
      <span class="pnl ${cls(cur.pnlUsd)}">${fmtUsd(cur.pnlUsd, { sign: true })} ${fmtPct(cur.pnlPct, 1)}</span>`;
  } else strip.hidden = true;

  if (!ps.length) {
    list.innerHTML = `<div class="pos-empty">No open positions.<br>Pick a coin and hit <span class="up">BUY</span> — your trades show up here live.</div>`;
    return;
  }
  // keep DOM nodes stable so the flash animations look right
  const want = ps.map((p) => p.address).join(',');
  if (list.dataset.keys !== want) {
    list.dataset.keys = want;
    list.innerHTML = ps.map((p) => `
      <div class="pos-card" data-addr="${esc(p.address)}" role="button" tabindex="0">
        <div class="pos-top">${coinImg(p)}<b>${esc(p.symbol)}</b><span class="muted" style="margin-left:auto;font-size:10px" data-f="age"></span></div>
        <div class="pos-grid">
          <span class="k">Quantity</span><span class="v" data-f="qty"></span>
          <span class="k">Avg entry</span><span class="v" data-f="avg"></span>
          <span class="k">Price now</span><span class="v" data-f="px"></span>
          <span class="k">Value</span><span class="v" data-f="val"></span>
        </div>
        <div class="pnl-big" data-f="pnl"><span data-f="pnlUsd"></span><span data-f="pnlPct"></span></div>
        <div class="quick-sell"><button data-qs="50">SELL 50%</button><button data-qs="100">SELL ALL</button></div>
      </div>`).join('');
  }
  for (const p of ps) {
    const card = list.querySelector(`.pos-card[data-addr="${CSS.escape(p.address)}"]`);
    if (!card) continue;
    card.classList.toggle('current', p.address === S.selected);
    card.classList.toggle('win', p.pnlUsd >= 0);
    card.classList.toggle('loss', p.pnlUsd < 0);
    card.querySelector('[data-f="age"]').textContent = `held ${ago(p.openedAt)}`;
    card.querySelector('[data-f="qty"]').textContent = fmtQty(p.qty);
    card.querySelector('[data-f="avg"]').textContent = fmtPrice(p.avgEntry);
    card.querySelector('[data-f="px"]').textContent = fmtPrice(p.price);
    card.querySelector('[data-f="val"]').textContent = fmtUsd(p.value);
    const pnl = card.querySelector('[data-f="pnl"]');
    const last = S.lastPnl.get(p.address);
    pnl.className = `pnl-big ${p.pnlUsd >= 0 ? 'up' : 'down'}`;
    if (last != null && Math.abs(p.pnlUsd - last) > 1e-9) { void pnl.offsetWidth; pnl.classList.add(p.pnlUsd > last ? 'tick-up' : 'tick-down'); }
    S.lastPnl.set(p.address, p.pnlUsd);
    pnl.querySelector('[data-f="pnlUsd"]').textContent = fmtUsd(p.pnlUsd, { sign: true });
    pnl.querySelector('[data-f="pnlPct"]').textContent = fmtPct(p.pnlPct);
  }
}
$('#posList').addEventListener('click', async (e) => {
  const qs = e.target.closest('[data-qs]');
  const card = e.target.closest('.pos-card');
  if (!card) return;
  if (qs) {
    e.stopPropagation();
    qs.disabled = true;
    try {
      const r = await api('/api/trade', { address: card.dataset.addr, side: 'sell', percent: Number(qs.dataset.qs), currency: 'USD' });
      S.user = r.user;
      const t = r.trade;
      toast(`<b>SOLD</b> ${fmtQty(t.qty)} ${esc(t.symbol)} for ${fmtUsd(t.usdValue)}<br><span class="${cls(t.pnlUsd)}">${fmtUsd(t.pnlUsd, { sign: true })} (${fmtPct(t.pnlPct, 1)})</span>`, t.pnlUsd < 0 ? 'err' : '');
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

// ================= ticker =================
function renderTicker(fresh) {
  const items = [];
  for (const f of S.feed.slice(0, 14)) {
    const buy = f.side === 'buy';
    items.push(`<span class="tk"><span class="who">${esc(f.username)}</span><b class="${buy ? 'up' : 'down'}">${buy ? 'BOUGHT' : 'SOLD'}</b>${fmtUsd(f.usd_value, { compact: true })} <b>${esc(f.symbol)}</b>${!buy && f.pnl_pct != null ? `<span class="${cls(f.pnl_pct)}">${fmtPct(f.pnl_pct, 0)}</span>` : ''}</span>`);
  }
  for (const t of sortedTrending().slice(0, 12)) {
    items.push(`<span class="tk"><b>${esc(t.symbol)}</b>${fmtPrice(t.priceUsd)}<span class="${cls(t.change5m)}">${fmtPct(t.change5m, 1)} 5m</span></span>`);
  }
  if (!items.length) return;
  const inner = $('#ticker');
  inner.innerHTML = items.join('') + items.join('');
  if (fresh) inner.firstElementChild?.classList.add('new');
}

// ================= leaderboard =================
let lbTimer = null;
async function loadLeaderboard() {
  try {
    const d = await api(`/api/leaderboard?range=${S.lbRange}`);
    const rows = $('#lbRows');
    const row = (r) => `<div class="lb-row ${r.rank <= 3 ? 'top' + r.rank : ''} ${r.isMe ? 'me' : ''}" role="row">
        <span class="lb-rank" role="cell">${r.rank === 1 ? '👑' : '#' + r.rank}</span>
        <span class="lb-name" role="cell"><span class="nm">${esc(r.username)}</span>${r.isMe ? '<span class="you-tag">YOU</span>' : ''}${badgeIcons(r.badges)}</span>
        <span class="lb-pnl r ${cls(r.profit)}" role="cell">${fmtUsd(r.profit, { sign: true })}</span>
        <span class="r hide-sm ${cls(r.profitPct)}" role="cell">${fmtPct(r.profitPct, 1)}</span>
        <span class="r hide-sm muted" role="cell">${fmtUsd(r.value, { compact: true })}</span>
      </div>`;
    rows.innerHTML = d.top.length ? d.top.map(row).join('') : `<div class="lb-empty">No players yet — be the first.</div>`;
    $('#lbMe').innerHTML = d.me ? row({ ...d.me, username: `${d.me.username}  · rank ${d.me.rank} of ${d.total}` }) : (S.user ? '' : `<div class="lb-row me"><span></span><span class="lb-name">Make an account to get ranked</span><span class="r"><button class="btn-ghost small" data-auth="signup">Join</button></span></div>`);
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
  const t = toast(`<span class="bi">${d.icon}</span><b>BADGE UNLOCKED · ${esc(d.name.toUpperCase())}</b><br><span class="muted">${esc(detail || d.how)}</span>`, 'badge-toast', 6000);
  t.style.setProperty('--bc', d.color);
  await refreshMe();
  const card = $(`.ach[data-badge="${badge}"]`);
  if (card) card.classList.add('unlocking');
}

// ================= profile =================
async function renderProfile() {
  const root = $('#profile');
  if (!S.user) {
    root.innerHTML = `<div class="guest panel"><div class="big-glyph">◉</div><h2>PAPER TRADE REAL MEMECOINS</h2>
      <p class="muted">Start with $1,000 in mock USD. Real live prices. Zero real money.</p>
      <button class="exec buy" style="max-width:280px;width:100%" data-auth="signup">CREATE FREE ACCOUNT</button>
      <p><button class="link-btn" data-auth="login">I already have one</button></p></div>`;
    return;
  }
  const u = S.user;
  if (!root.dataset.built || root.dataset.uid !== String(u.id)) {
    root.dataset.built = '1';
    root.dataset.uid = u.id;
    root.innerHTML = `
      <div class="pf-hero panel pf-card">
        <div class="avatar">${esc(u.username[0].toUpperCase())}</div>
        <div>
          <div class="pf-name"><span>${esc(u.username)}</span><span id="pfBadges"></span></div>
          <div class="pf-meta">${esc(u.email)} · trading since ${new Date(u.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</div>
        </div>
        <div class="pf-actions"><button class="btn-ghost" id="logoutBtn">Log out</button></div>
      </div>
      <div class="pf-stats panel" id="pfStats"></div>
      <div class="pf-cal panel pf-card">
        <div class="sec-title"><h3>// DAILY PnL CALENDAR</h3>
          <div class="cal-nav"><button class="btn-ghost small" id="calPrev" aria-label="Previous month">‹</button><span class="m" id="calMonth"></span><button class="btn-ghost small" id="calNext" aria-label="Next month">›</button></div>
        </div>
        <div class="cal-grid" id="calGrid"></div>
        <div class="cal-foot" id="calFoot"></div>
      </div>
      <div class="pf-faucet panel pf-card">
        <div class="sec-title"><h3>// VIRTUAL WALLET</h3></div>
        <div id="walletLines"></div>
        <button class="faucet-big" id="pfFaucet"></button>
        <p class="note">The faucet drops free mock SOL into your wallet, valued at the live SOL price. Faucet funds never count as profit on the leaderboard — only your trading does.</p>
      </div>
      <div class="pf-ach panel pf-card">
        <div class="sec-title"><h3>// ACHIEVEMENT SHOWCASE</h3><span class="muted" id="achCount"></span></div>
        <div class="ach-grid" id="achGrid"></div>
      </div>
      <div class="pf-trades panel pf-card">
        <div class="sec-title"><h3>// RECENT TRADES</h3></div>
        <div style="overflow-x:auto"><table class="trades-table" id="tradesTable"></table></div>
      </div>`;
    $('#logoutBtn').addEventListener('click', logout);
    $('#pfFaucet').addEventListener('click', claimFaucet);
    $('#calPrev').addEventListener('click', () => { S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() - 1, 1); renderCalendar(); });
    $('#calNext').addEventListener('click', () => { S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() + 1, 1); renderCalendar(); });
    loadProfileData();
  }
  renderProfileLive();
}
async function loadProfileData() {
  try {
    const [snaps, trades] = await Promise.all([api('/api/me/snapshots?days=400'), api('/api/me/trades?limit=40')]);
    S.snapshots = snaps;
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
        ${e ? '' : '<span class="lock">🔒 LOCKED</span>'}
        <div class="ico">${d.icon}</div><div class="nm">${esc(d.name)}</div><div class="how">${esc(d.how)}</div>
        <div class="when">${e ? `UNLOCKED ${new Date(e.earnedAt).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}${e.detail ? `<br><span class="muted">${esc(e.detail)}</span>` : ''}` : 'NOT YET EARNED'}</div>
      </div>`;
    }).join('');
  }
  updateFaucetButtons();
  renderCalendar(true);
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
function dailyPnl() {
  // close of each local day = last snapshot that day; daily PnL = close − previous close.
  const closes = new Map();
  for (const s of S.snapshots) closes.set(dayKey(new Date(s.ts)), s.profit);
  if (S.user) closes.set(dayKey(new Date()), S.user.profit); // today is live
  const created = S.user ? new Date(S.user.createdAt) : new Date();
  const start = new Date(created.getFullYear(), created.getMonth(), created.getDate());
  const out = new Map();
  let prev = 0;
  for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 1)) {
    const k = dayKey(d);
    const close = closes.has(k) ? closes.get(k) : prev;
    out.set(k, close - prev);
    prev = close;
  }
  return out;
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
  cell.title = `${fmtUsd(v, { sign: true })} trading PnL`;
}
function renderCalFoot(pnl, m, days) {
  let total = 0, green = 0, red = 0;
  for (let d = 1; d <= days; d++) {
    const v = pnl.get(dayKey(new Date(m.getFullYear(), m.getMonth(), d)));
    if (v == null) continue;
    total += v;
    if (v > 0.005) green++; else if (v < -0.005) red++;
  }
  $('#calFoot').innerHTML = `<span><span class="up">${green} green</span> · <span class="down">${red} red</span> days</span><span>Month PnL <b class="${cls(total)}">${fmtUsd(total, { sign: true })}</b></span>`;
}
setInterval(() => { if (S.view === 'profile') renderProfileLive(); }, 2000);
setInterval(() => { if (S.view === 'profile' && S.user) loadProfileData(); }, 120_000);

// ================= auth =================
let authMode = 'signup';
function openAuth(mode = 'signup') {
  authMode = mode;
  const signup = mode === 'signup';
  $('#authTitle').textContent = signup ? 'CREATE ACCOUNT' : 'WELCOME BACK';
  $('#authSub').innerHTML = signup ? 'Get <b class="up">$1,000 mock USD</b> to trade real trending memecoins. No real money, ever.' : 'Log in to keep trading.';
  $('#userField').hidden = !signup;
  $('#authForm').password.autocomplete = signup ? 'new-password' : 'current-password';
  $('#authSubmit').textContent = signup ? 'START TRADING' : 'LOG IN';
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
    toast(authMode === 'signup' ? `<b>WALLET FUNDED</b> · $1,000 mock USD is ready. Go get that bag 🚀` : `<b>LOGGED IN</b> · welcome back, ${esc(S.user.username)}`);
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
  else if (view === 'trending') {
    $('#tradeLayout').classList.remove('show-term');
    closeSheet();
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
  // Desktop: open the hottest coin straight away so the terminal isn't empty.
  if (!location.hash.startsWith('#coin/') && !isMobile() && S.view === 'trending') {
    const wait = setInterval(() => {
      if (S.trending.length && !S.selected && S.view === 'trending') { clearInterval(wait); location.replace(`#coin/${S.trending[0]}`); }
      if (S.selected) clearInterval(wait);
    }, 300);
  }
  setInterval(() => { if (S.user) refreshMe().catch(() => {}); }, 30_000);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
