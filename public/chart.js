// Interactive canvas chart with two modes:
//   'line'    — live feed: a streaming price line that scrolls in real time (default)
//   'candles' — classic OHLC candlesticks (1m / 5m / 15m / 1h)
// Drag to pan, wheel or pinch to zoom, tap to open trading.
export class CandleChart {
  constructor(container, { onActivate, formatPrice } = {}) {
    this.el = container;
    this.onActivate = onActivate || (() => {});
    this.fmt = formatPrice || ((p) => p.toPrecision(4));
    this.mode = 'line';
    this.mult = 1;            // display value = price * mult (1 = price, supply = market cap)
    // candles
    this.data = [];
    this.barW = 7;
    this.legend = '';         // e.g. "BONK/SOL Market Cap (USD) · 1s"
    this.emptyMsg = 'loading candles…';
    this.tfSec = 60;          // candle size, for time labels
    this.offset = 0;
    // live line
    this.points = [];         // [{t: ms, p: price}] ascending
    this.windowMs = 3 * 60_000;
    this.offsetMs = 0;        // how far back from "now" the right edge is (0 = live)
    this.shownLast = null;    // eased last value, so the line glides instead of jumping
    this.range = null;        // eased y-range
    this.markers = [];        // [{t, side}]
    this.lines = [];          // [{price, label, color}]
    this.hover = null;
    this.flash = 0;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Price chart. Drag to look back, scroll or pinch to zoom, tap to trade.');
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.pointers = new Map();
    this.dragStart = null;
    this.pinchDist = null;
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e, true));
    c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { this.hover = null; this.draw(); } });
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.offsetX); }, { passive: false });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    this.resize();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // ---------- public API ----------
  setMode(mode) { this.mode = mode === 'candles' ? 'candles' : 'line'; this.hover = null; this.range = null; this.draw(); }
  setValueScale(mult) { this.mult = mult > 0 ? mult : 1; this.range = null; this.draw(); }
  setData(candles, { keepView = false } = {}) { this.data = candles.slice(); if (!keepView) this.offset = 0; this.range = null; this.draw(); }
  update(candle) {
    const last = this.data[this.data.length - 1];
    if (last && last.time === candle.time) Object.assign(last, candle);
    else if (!last || candle.time > last.time) { this.data.push(candle); if (this.offset > 0) this.offset += 1; }
    this.flash = performance.now();
    this.draw();
  }
  setPoints(points) {
    this.points = points.filter((p) => p.p > 0).sort((a, b) => a.t - b.t);
    this.shownLast = null; this.range = null;
    this.draw();
  }
  pushPoint(t, p) {
    if (!(p > 0)) return;
    const pts = this.points;
    const last = pts[pts.length - 1];
    if (last && Math.floor(last.t / 1000) === Math.floor(t / 1000)) { last.p = p; last.t = t; }
    else if (!last || t > last.t) pts.push({ t, p });
    else {
      // an on-chain trade that landed a moment before the newest point: slot it in by time
      let i = pts.length - 1;
      while (i > 0 && pts[i - 1].t > t) i--;
      if (Math.abs(pts[i].t - t) < 300) pts[i].p = p; else pts.splice(i, 0, { t, p });
    }
    if (pts.length > 8000) pts.splice(0, pts.length - 8000);
    this.flash = performance.now();
  }
  setLines(lines) { this.lines = lines || []; this.draw(); }
  setLegend(text, tfSec) { this.legend = text || ''; if (tfSec) this.tfSec = tfSec; this.draw(); }
  setEmpty(msg) { this.emptyMsg = msg; this.draw(); }
  setMarkers(markers) { this.markers = markers || []; this.draw(); }
  resetView() { this.offset = 0; this.offsetMs = 0; this.range = null; this.draw(); }
  get isLive() { return this.mode === 'line' && this.offsetMs < 1000; }
  windowLabel() {
    const s = Math.round(this.windowMs / 1000);
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(s % 3600 ? 1 : 0)}h`;
  }

  // ---------- interaction ----------
  onDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 1) this.dragStart = { x: e.offsetX, y: e.offsetY, offset: this.offset, offsetMs: this.offsetMs, moved: false };
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.pinchStart = { barW: this.barW, windowMs: this.windowMs };
      if (this.dragStart) this.dragStart.moved = true;
    }
  }
  onMove(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 2 && this.pinchDist) {
      const [a, b] = [...this.pointers.values()];
      const f = Math.hypot(a.x - b.x, a.y - b.y) / this.pinchDist;
      if (this.mode === 'candles') { this.barW = clamp(this.pinchStart.barW * f, 2, 40); this.clampOffset(); }
      else this.windowMs = clamp(this.pinchStart.windowMs / f, 20_000, 6 * 3600_000);
      this.draw();
      return;
    }
    if (this.dragStart && this.pointers.size === 1) {
      const dx = e.offsetX - this.dragStart.x;
      if (Math.abs(dx) > 4 || Math.abs(e.offsetY - this.dragStart.y) > 4) this.dragStart.moved = true;
      if (this.mode === 'candles') { this.offset = this.dragStart.offset + dx / this.barW; this.clampOffset(); }
      else {
        const msPerPx = this.windowMs / Math.max(1, this.plotW - 10);
        const oldest = this.points.length ? Date.now() - this.points[0].t : 0;
        this.offsetMs = clamp(this.dragStart.offsetMs + dx * msPerPx, 0, Math.max(0, oldest - this.windowMs * 0.3));
      }
    }
    this.hover = { x: e.offsetX, y: e.offsetY };
    this.draw();
  }
  onUp(e, cancelled) {
    const wasTap = this.dragStart && !this.dragStart.moved && this.pointers.size === 1 && !cancelled;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = null;
    if (this.pointers.size === 0) {
      if (wasTap) this.onActivate({ value: this.valueAt(e.offsetY) });
      this.dragStart = null;
      if (e.pointerType !== 'mouse') setTimeout(() => { this.hover = null; this.draw(); }, 1200);
    }
  }
  zoom(factor, anchorX) {
    if (this.mode === 'line') {
      this.windowMs = clamp(this.windowMs / factor, 20_000, 6 * 3600_000);
      this.range = null;
      this.draw();
      return;
    }
    const n = this.data.length;
    const ax = this.plotW - 6 - (anchorX ?? this.plotW);
    const idx = n - this.offset - 0.5 - ax / this.barW;
    this.barW = clamp(this.barW * factor, 2, 40);
    this.offset = n - 0.5 - ax / this.barW - idx;
    this.clampOffset();
    this.draw();
  }
  clampOffset() {
    const visible = this.plotW / this.barW;
    this.offset = clamp(this.offset, -visible * 0.4, Math.max(0, this.data.length - visible * 0.3));
  }

  // ---------- layout ----------
  resize() {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(200, r.width);
    this.h = Math.max(160, r.height);
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }
  get axisW() { return this.mult > 1 ? 70 : 78; }
  get timeH() { return 24; }
  get plotW() { return (this.w || 300) - this.axisW; }
  get plotH() { return (this.h || 200) - this.timeH; }
  valueAt(y) {
    if (!this.scale) return null;
    const { min, max, top, bottom } = this.scale;
    return max - ((y - top) / (bottom - top)) * (max - min);
  }

  // ---------- drawing ----------
  draw() { this.dirty = true; }
  loop() {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    // the live line scrolls continuously; everything else redraws only when something changed
    const live = this.mode === 'line' && !document.hidden;
    if (!this.dirty && !(live && now - (this.lastPaint || 0) > 33)) return;
    this.dirty = false;
    this.lastPaint = now;
    this.colors = this.colors && now - this.colorsAt < 2000 ? this.colors : this.readColors(now);
    if (this.mode === 'line') this.paintLine(); else this.paintCandles();
  }
  readColors(now) {
    this.colorsAt = now;
    const css = getComputedStyle(document.documentElement);
    const g = (n, d) => css.getPropertyValue(n).trim() || d;
    return { up: g('--up', '#4ade80'), down: g('--down', '#f87171'), grid: g('--grid', '#1c1c21'), muted: g('--muted', '#a1a1aa'), text: g('--text', '#e4e4e7'), panel: g('--surface', '#141418') };
  }
  font(px, weight = 500) { return `${weight} ${px}px "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace`; }

  axisAndGrid(min, max, top, bottom, toY) {
    const { ctx } = this; const { grid, muted } = this.colors;
    const PW = this.plotW, PH = this.plotH;
    ctx.font = this.font(11);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const t of niceTicks(min, max, Math.max(3, Math.floor(PH / 52)))) {
      const yy = Math.round(toY(t)) + 0.5;
      ctx.strokeStyle = grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(PW, yy); ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(this.fmt(t), PW + 8, yy);
    }
  }

  paintLine() {
    const { ctx } = this; const { up, down, grid, muted, text } = this.colors;
    const W = this.w, H = this.h, PW = this.plotW, PH = this.plotH;
    ctx.clearRect(0, 0, W, H);
    const pts = this.points;
    if (!pts.length) { this.emptyText('waiting for live price…'); return; }
    const now = Date.now();
    const tRight = now - this.offsetMs;
    const tLeft = tRight - this.windowMs;
    const innerW = PW - 14;
    const x = (t) => ((t - tLeft) / this.windowMs) * innerW;

    // visible slice (+1 point on the left so the line enters from the edge)
    let i0 = 0;
    while (i0 < pts.length - 1 && pts[i0 + 1].t < tLeft) i0++;
    let i1 = pts.length - 1;
    while (i1 > i0 && pts[i1].t > tRight) i1--;
    const vis = pts.slice(i0, i1 + 1);
    const lastReal = pts[pts.length - 1].p * this.mult;
    if (this.shownLast == null) this.shownLast = lastReal;
    this.shownLast += (lastReal - this.shownLast) * 0.22; // glide to the new price
    const endVal = this.isLive ? this.shownLast : vis[vis.length - 1].p * this.mult;

    let lo = Infinity, hi = -Infinity;
    for (const p of vis) { const v = p.p * this.mult; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    lo = Math.min(lo, endVal); hi = Math.max(hi, endVal);
    for (const l of this.lines) { const v = l.price * this.mult; if (v > lo / 1.6 && v < hi * 1.6) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    if (!(hi > lo)) { const m = (hi || 1) * 0.004; lo -= m; hi += m; }
    const pad = (hi - lo) * 0.16;
    const target = { min: lo - pad, max: hi + pad };
    if (!this.range) this.range = { ...target };
    this.range.min += (target.min - this.range.min) * 0.18;
    this.range.max += (target.max - this.range.max) * 0.18;
    const { min, max } = this.range;
    const top = 14, bottom = PH - 8;
    this.scale = { min, max, top, bottom };
    const y = (v) => top + ((max - v) / (max - min)) * (bottom - top);

    this.axisAndGrid(min, max, top, bottom, y);
    // time axis
    const stepS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].find((s) => (s * 1000 / this.windowMs) * innerW >= 84) || 7200;
    ctx.textAlign = 'center';
    ctx.font = this.font(11);
    for (let t = Math.ceil(tLeft / (stepS * 1000)) * stepS * 1000; t <= tRight; t += stepS * 1000) {
      const xx = Math.round(x(t)) + 0.5;
      ctx.strokeStyle = grid;
      ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, PH); ctx.stroke();
      ctx.fillStyle = muted;
      const d = new Date(t);
      ctx.fillText(stepS < 60 ? d.toLocaleTimeString([], { hour12: false }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), xx, PH + 13);
    }

    const firstVal = vis[0].p * this.mult;
    const col = endVal >= firstVal ? up : down;
    // path: a smooth line through every trade/tick; the final segment extends to "now"
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, PW, PH); ctx.clip();
    const path = new Path2D();
    vis.forEach((p, i) => {
      const xx = Math.max(-2, x(p.t)), yy = y(i === vis.length - 1 && this.isLive ? endVal : p.p * this.mult);
      if (i === 0) path.moveTo(xx, yy); else path.lineTo(xx, yy);
    });
    const endX = this.isLive ? x(now) : x(vis[vis.length - 1].t);
    path.lineTo(endX, y(endVal));
    // area
    const area = new Path2D(path);
    area.lineTo(endX, PH);
    area.lineTo(Math.max(-2, x(vis[0].t)), PH);
    area.closePath();
    const grad = ctx.createLinearGradient(0, top, 0, PH);
    grad.addColorStop(0, hexA(col, 0.28));
    grad.addColorStop(1, hexA(col, 0));
    ctx.fillStyle = grad;
    ctx.fill(area);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke(path);

    // trade markers
    for (const m of this.markers) {
      if (m.t < tLeft || m.t > tRight) continue;
      const v = valueAtTime(pts, m.t) * this.mult;
      const mx = x(m.t), my = y(v);
      const c2 = m.side === 'buy' ? up : down;
      ctx.fillStyle = c2;
      ctx.beginPath(); ctx.arc(mx, my, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0b0b0e';
      ctx.font = this.font(10, 800);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(m.side === 'buy' ? 'B' : 'S', mx, my + 0.5);
    }
    // live dot with a pulse
    const ey = y(endVal);
    if (this.isLive) {
      const ph = (performance.now() % 1600) / 1600;
      ctx.fillStyle = hexA(col, 0.35 * (1 - ph));
      ctx.beginPath(); ctx.arc(endX, ey, 4 + ph * 12, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(endX, ey, 4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    this.refLines(y, min, max);
    // current value line + label
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = hexA(col, 0.55);
    ctx.beginPath(); ctx.moveTo(0, Math.round(ey) + 0.5); ctx.lineTo(PW, Math.round(ey) + 0.5); ctx.stroke();
    ctx.setLineDash([]);
    const flashing = performance.now() - this.flash < 350;
    pill(ctx, this.fmt(endVal), PW + 3, ey, flashing ? '#ffffff' : col, '#0b0b0e', this.axisW - 6, this.font(11, 700));
    if (!this.isLive) {
      ctx.font = this.font(11, 600);
      ctx.textAlign = 'right'; ctx.fillStyle = muted;
      ctx.fillText('viewing history · tap Latest to go live', PW - 8, 12);
    }
    // crosshair
    if (this.hover && this.hover.x < PW && this.hover.y < PH) {
      const t = tLeft + (this.hover.x / innerW) * this.windowMs;
      const v = valueAtTime(pts, Math.min(t, pts[pts.length - 1].t)) * this.mult;
      this.crosshair(this.hover.x, y(v), this.fmt(v), new Date(t).toLocaleTimeString([], { hour12: false }), text);
    }
  }

  paintCandles() {
    const { ctx } = this; const { up, down, grid, muted, text } = this.colors;
    const W = this.w, H = this.h, PW = this.plotW, PH = this.plotH;
    ctx.clearRect(0, 0, W, H);
    if (!this.data.length) { this.emptyText(this.emptyMsg); return; }
    const m = this.mult;
    const { start, end } = this.visibleRange();
    const vis = this.data.slice(start, end);
    let min = Infinity, max = -Infinity, vmax = 0;
    for (const c of vis) { min = Math.min(min, c.low * m); max = Math.max(max, c.high * m); vmax = Math.max(vmax, c.volume || 0); }
    if (min === max) { min *= 0.98; max *= 1.02; }
    const pad = (max - min) * 0.08;
    min -= pad; max += pad;
    const top = 46, bottom = PH - 8;
    this.scale = { min, max, top, bottom };
    const y = (v) => top + ((max - v) / (max - min)) * (bottom - top);
    this.axisAndGrid(min, max, top, bottom, y);
    ctx.textAlign = 'center';
    const every = Math.max(1, Math.round(90 / this.barW));
    for (let i = start; i < end; i++) {
      if (i % every) continue;
      const xx = this.xOf(i);
      if (xx < 20 || xx > PW - 20) continue;
      ctx.fillStyle = muted;
      ctx.fillText(timeLabel(this.data[i].time, this.data, this.tfSec), xx, PH + 13);
      ctx.strokeStyle = grid;
      ctx.beginPath(); ctx.moveTo(Math.round(xx) + 0.5, 0); ctx.lineTo(Math.round(xx) + 0.5, PH); ctx.stroke();
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, PW, PH); ctx.clip();
    if (vmax > 0) {
      for (let i = start; i < end; i++) {
        const c = this.data[i];
        const vh = ((c.volume || 0) / vmax) * PH * 0.2;
        ctx.fillStyle = hexA(c.close >= c.open ? up : down, 0.42);
        const bw = Math.max(1, this.barW * 0.7);
        ctx.fillRect(this.xOf(i) - bw / 2, PH - vh, bw, vh);
      }
    }
    const bw = Math.max(1, this.barW * 0.7);
    for (let i = start; i < end; i++) {
      const c = this.data[i];
      const xx = this.xOf(i);
      const col = c.close >= c.open ? up : down;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(xx) + 0.5, y(c.high * m)); ctx.lineTo(Math.round(xx) + 0.5, y(c.low * m)); ctx.stroke();
      const yo = y(c.open * m), yc = y(c.close * m);
      ctx.fillRect(xx - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
    }
    ctx.restore();
    this.refLines(y, min, max);
    const last = this.data[this.data.length - 1];
    const lastCol = last.close >= last.open ? up : down;
    const ly = Math.round(y(last.close * m)) + 0.5;
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = hexA(lastCol, 0.6);
    ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(PW, ly); ctx.stroke();
    ctx.setLineDash([]);
    const flashing = performance.now() - this.flash < 350;
    pill(ctx, this.fmt(last.close * m), PW + 3, ly, flashing ? '#ffffff' : lastCol, '#0b0b0e', this.axisW - 6, this.font(11, 700));
    let hc = null;
    if (this.hover && this.hover.x < PW && this.hover.y < PH) {
      const n = this.data.length;
      const i = Math.round(n - this.offset - 0.5 - (this.plotW - 6 - this.hover.x) / this.barW);
      hc = this.data[i] || null;
      const opts = this.tfSec < 60 ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
        : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
      this.crosshair(this.hover.x, this.hover.y, this.fmt(this.valueAt(this.hover.y)),
        hc ? new Date(hc.time * 1000).toLocaleString([], opts) : '', text);
    }
    // legend (top-left, like a TradingView chart): pair · timeframe · O H L C change, then volume
    const c = hc || last;
    const prev = this.data[this.data.indexOf(c) - 1];
    const base = prev ? prev.close : c.open;
    const d = c.close * m - base * m;
    const col = c.close >= c.open ? up : down;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let x = 10;
    const put = (s, color, font) => { ctx.font = font || this.font(11.5, 500); ctx.fillStyle = color; ctx.fillText(s, x, 15); x += ctx.measureText(s).width + 6; };
    if (this.legend) put(this.legend, text, `500 12px "Geist", ui-sans-serif, system-ui, sans-serif`);
    for (const [k, v] of [['O', c.open], ['H', c.high], ['L', c.low], ['C', c.close]]) { if (x > PW - 60) break; put(k, muted); x -= 3; put(this.fmt(v * m), col); }
    if (x < PW - 80) put(`${d >= 0 ? '+' : ''}${this.fmt(d)} (${base ? ((c.close / base - 1) * 100).toFixed(2) : '0.00'}%)`, col);
    x = 10;
    ctx.font = this.font(11.5, 500); ctx.fillStyle = muted; ctx.fillText('Volume', x, 34);
    x += ctx.measureText('Volume').width + 8;
    ctx.fillStyle = col; ctx.fillText(fmtVol(c.volume || 0), x, 34);
  }
  visibleRange() {
    const n = this.data.length;
    const visible = Math.ceil(this.plotW / this.barW) + 1;
    const end = Math.min(n, Math.ceil(n - this.offset));
    return { start: Math.max(0, end - visible), end };
  }
  xOf(i) { return this.plotW - (this.data.length - this.offset - i - 0.5) * this.barW - 6; }

  refLines(y, min, max) {
    const { ctx } = this;
    for (const l of this.lines) {
      const v = l.price * this.mult;
      ctx.font = this.font(10, 700);
      if (!(v > min && v < max)) {
        // off-screen: pin a small label to the top or bottom edge instead of squashing the candles
        const above = v >= max;
        const s = `${above ? '↑' : '↓'} ${l.label} ${this.fmt(v)}`;
        const w = ctx.measureText(s).width + 14;
        pill(ctx, s, this.plotW - w - 8, above ? this.scale.top - 4 : this.scale.bottom - 12, l.color, '#0b0b0e', w, this.font(10, 700));
        continue;
      }
      const yy = Math.round(y(v)) + 0.5;
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = l.color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(this.plotW, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = this.font(10, 700);
      const s = `${l.label} ${this.fmt(v)}`;
      pill(ctx, s, 8, yy, l.color, '#0b0b0e', ctx.measureText(s).width + 14, this.font(10, 700));
    }
  }
  crosshair(x, y, valueText, timeText, color) {
    const { ctx } = this;
    ctx.strokeStyle = hexA(color, 0.35); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(this.plotW, Math.round(y) + 0.5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, this.plotH); ctx.stroke();
    ctx.setLineDash([]);
    pill(ctx, valueText, this.plotW + 3, y, '#2f2f36', color, this.axisW - 6, this.font(11, 600));
    if (timeText) {
      ctx.font = this.font(11, 600);
      const w = ctx.measureText(timeText).width + 14;
      pill(ctx, timeText, clamp(x - w / 2, 0, this.plotW - w), this.plotH + 12, '#2f2f36', color, w, this.font(11, 600));
    }
  }
  emptyText(s) {
    const { ctx } = this;
    ctx.fillStyle = this.colors.muted;
    ctx.font = this.font(12);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, this.plotW / 2, this.plotH / 2);
  }
  destroy() { this.ro.disconnect(); this.canvas.remove(); }
}

// ---------- helpers ----------
function pill(ctx, s, x, y, bg, fg, width, font) {
  ctx.font = font;
  const w = width || ctx.measureText(s).width + 12;
  const h = 20;
  ctx.fillStyle = bg;
  roundRect(ctx, x, y - h / 2, w, h, 5);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(s, x + 6, y + 0.5);
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function hexA(col, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(col.trim());
  if (!m) return col;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
function valueAtTime(pts, t) {
  if (!pts.length) return 0;
  if (t <= pts[0].t) return pts[0].p;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].t <= t) lo = mid; else hi = mid; }
  return pts[hi].t <= t ? pts[hi].p : pts[lo].p;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function niceTicks(min, max, count) {
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
}
function fmtVol(v) {
  return v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(2)}K` : `$${v.toFixed(2)}`;
}
function timeLabel(sec, data, tfSec = 60) {
  const d = new Date(sec * 1000);
  if (tfSec < 60) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const spanDays = data.length > 1 ? (data[data.length - 1].time - data[0].time) / 86400 : 0;
  if (d.getHours() === 0 && d.getMinutes() === 0 && spanDays > 1) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
