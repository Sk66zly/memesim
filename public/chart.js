// Interactive canvas candlestick chart: drag to pan, wheel/pinch to zoom, crosshair, tap to trade.
export class CandleChart {
  constructor(container, { onActivate, formatPrice } = {}) {
    this.el = container;
    this.onActivate = onActivate || (() => {});
    this.fmt = formatPrice || ((p) => p.toPrecision(4));
    this.data = [];
    this.barW = 9;          // px per candle (zoom)
    this.offset = 0;        // candles scrolled back from the right edge
    this.hover = null;      // {x, y}
    this.lines = [];        // [{price, label, color}]
    this.flash = 0;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Price chart. Drag to pan, scroll to zoom, tap to open trading.');
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
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.offsetX);
    }, { passive: false });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    this.resize();
  }

  // ---------- data ----------
  setData(candles, { keepView = false } = {}) {
    this.data = candles.slice();
    if (!keepView) { this.offset = 0; }
    this.draw();
  }
  update(candle) {
    const last = this.data[this.data.length - 1];
    if (last && last.time === candle.time) Object.assign(last, candle);
    else if (!last || candle.time > last.time) {
      this.data.push(candle);
      if (this.offset > 0) this.offset += 1; // keep the user's view still while they browse history
    }
    this.flash = performance.now();
    this.draw();
  }
  setLines(lines) { this.lines = lines || []; this.draw(); }

  // ---------- interaction ----------
  onDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 1) this.dragStart = { x: e.offsetX, y: e.offsetY, offset: this.offset, moved: false };
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.pinchBar = this.barW;
      if (this.dragStart) this.dragStart.moved = true;
    }
  }
  onMove(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 2 && this.pinchDist) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.barW = clamp(this.pinchBar * (d / this.pinchDist), 2, 40);
      this.clampOffset();
      this.draw();
      return;
    }
    if (this.dragStart && this.pointers.size === 1) {
      const dx = e.offsetX - this.dragStart.x;
      if (Math.abs(dx) > 4 || Math.abs(e.offsetY - this.dragStart.y) > 4) this.dragStart.moved = true;
      this.offset = this.dragStart.offset + dx / this.barW;
      this.clampOffset();
    }
    this.hover = { x: e.offsetX, y: e.offsetY };
    this.draw();
  }
  onUp(e, cancelled) {
    const wasTap = this.dragStart && !this.dragStart.moved && this.pointers.size === 1 && !cancelled;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = null;
    if (this.pointers.size === 0) {
      if (wasTap) {
        const price = this.priceAt(e.offsetY);
        this.onActivate({ price });
      }
      this.dragStart = null;
      if (e.pointerType !== 'mouse') { setTimeout(() => { this.hover = null; this.draw(); }, 1200); }
    }
  }
  zoom(factor, anchorX) {
    // keep the candle under the cursor in the same spot while zooming
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
  resetView() { this.offset = 0; this.draw(); }

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
  get axisW() { return 74; }
  get timeH() { return 22; }
  get plotW() { return (this.w || 300) - this.axisW; }
  get plotH() { return (this.h || 200) - this.timeH; }

  visibleRange() {
    const n = this.data.length;
    const visible = Math.ceil(this.plotW / this.barW) + 1;
    const end = Math.min(n, Math.ceil(n - this.offset));
    const start = Math.max(0, end - visible);
    return { start, end };
  }
  xOf(i) { // centre x of candle index i
    const n = this.data.length;
    return this.plotW - (n - this.offset - i - 0.5) * this.barW - 6;
  }
  priceAt(y) {
    if (!this.scale) return null;
    const { min, max, top, bottom } = this.scale;
    return max - ((y - top) / (bottom - top)) * (max - min);
  }

  // ---------- drawing ----------
  draw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.paint(); });
  }
  paint() {
    const ctx = this.ctx, W = this.w, H = this.h, PW = this.plotW, PH = this.plotH;
    const css = getComputedStyle(document.documentElement);
    const up = css.getPropertyValue('--up').trim() || '#a6ff00';
    const down = css.getPropertyValue('--down').trim() || '#ff2e88';
    const grid = css.getPropertyValue('--grid').trim() || '#11181a';
    const muted = css.getPropertyValue('--muted').trim() || '#5d6f66';
    const text = css.getPropertyValue('--text').trim() || '#e6f2ea';
    ctx.clearRect(0, 0, W, H);

    if (!this.data.length) {
      ctx.fillStyle = muted;
      ctx.font = '12px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('waiting for price data…', PW / 2, PH / 2);
      return;
    }
    const { start, end } = this.visibleRange();
    const vis = this.data.slice(start, end);
    let min = Infinity, max = -Infinity, vmax = 0;
    for (const c of vis) { min = Math.min(min, c.low); max = Math.max(max, c.high); vmax = Math.max(vmax, c.volume || 0); }
    for (const l of this.lines) if (l.price > 0 && l.price < max * 3 && l.price > min / 3) { min = Math.min(min, l.price); max = Math.max(max, l.price); }
    if (min === max) { min *= 0.98; max *= 1.02; }
    const pad = (max - min) * 0.08;
    min -= pad; max += pad;
    const top = 10, bottom = PH - 4;
    this.scale = { min, max, top, bottom };
    const y = (p) => top + ((max - p) / (max - min)) * (bottom - top);

    // grid + price axis
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const ticks = niceTicks(min, max, Math.max(3, Math.floor(PH / 46)));
    for (const t of ticks) {
      const yy = Math.round(y(t)) + 0.5;
      ctx.strokeStyle = grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(PW, yy); ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(this.fmt(t), PW + 6, yy);
    }
    // axis divider
    ctx.strokeStyle = grid;
    ctx.beginPath(); ctx.moveTo(PW + 0.5, 0); ctx.lineTo(PW + 0.5, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, PH + 0.5); ctx.lineTo(W, PH + 0.5); ctx.stroke();

    // time axis labels
    ctx.textAlign = 'center';
    const every = Math.max(1, Math.round(90 / this.barW));
    for (let i = start; i < end; i++) {
      if (i % every) continue;
      const x = this.xOf(i);
      if (x < 20 || x > PW - 20) continue;
      ctx.fillStyle = muted;
      ctx.fillText(timeLabel(this.data[i].time, this.data), x, PH + 12);
      ctx.strokeStyle = grid;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, PH); ctx.stroke();
    }

    // volume
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, PW, PH); ctx.clip();
    if (vmax > 0) {
      for (let i = start; i < end; i++) {
        const c = this.data[i];
        const vh = ((c.volume || 0) / vmax) * PH * 0.18;
        ctx.fillStyle = (c.close >= c.open ? up : down) + '22';
        const bw = Math.max(1, this.barW * 0.7);
        ctx.fillRect(this.xOf(i) - bw / 2, PH - vh, bw, vh);
      }
    }
    // candles
    const bw = Math.max(1, this.barW * 0.68);
    for (let i = start; i < end; i++) {
      const c = this.data[i];
      const x = this.xOf(i);
      const col = c.close >= c.open ? up : down;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y(c.high)); ctx.lineTo(Math.round(x) + 0.5, y(c.low)); ctx.stroke();
      const yo = y(c.open), yc = y(c.close);
      const h = Math.max(1, Math.abs(yc - yo));
      if (c.close >= c.open) ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, h);
      else ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, h);
    }
    ctx.restore();

    // reference lines (avg entry etc.)
    for (const l of this.lines) {
      if (!(l.price > min && l.price < max)) continue;
      const yy = Math.round(y(l.price)) + 0.5;
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = l.color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(PW, yy); ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, `${l.label} ${this.fmt(l.price)}`, 6, yy, l.color, '#000', 'left');
    }

    // last price line
    const last = this.data[this.data.length - 1];
    const lastCol = last.close >= last.open ? up : down;
    const ly = Math.round(y(last.close)) + 0.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = lastCol + 'aa';
    ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(PW, ly); ctx.stroke();
    ctx.setLineDash([]);
    const flashing = performance.now() - this.flash < 400;
    label(ctx, this.fmt(last.close), PW + 2, ly, flashing ? '#ffffff' : lastCol, '#000', 'axis', this.axisW - 4);
    if (flashing) setTimeout(() => this.draw(), 420);

    // crosshair
    if (this.hover && this.hover.x < PW && this.hover.y < PH) {
      const { x: hx, y: hy } = this.hover;
      const n = this.data.length;
      const i = Math.round(n - this.offset - 0.5 - (this.plotW - 6 - hx) / this.barW);
      ctx.strokeStyle = text + '55'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, Math.round(hy) + 0.5); ctx.lineTo(PW, Math.round(hy) + 0.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(Math.round(hx) + 0.5, 0); ctx.lineTo(Math.round(hx) + 0.5, PH); ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, this.fmt(this.priceAt(hy)), PW + 2, hy, '#1d2a24', text, 'axis', this.axisW - 4);
      const c = this.data[i];
      if (c) {
        const col = c.close >= c.open ? up : down;
        const chg = ((c.close / c.open - 1) * 100).toFixed(2);
        const s = `O ${this.fmt(c.open)}  H ${this.fmt(c.high)}  L ${this.fmt(c.low)}  C ${this.fmt(c.close)}  ${chg > 0 ? '+' : ''}${chg}%`;
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#000000cc';
        ctx.fillRect(4, 2, Math.min(PW - 8, ctx.measureText(s).width + 10), 18);
        ctx.fillStyle = col;
        ctx.fillText(s, 9, 11);
        label(ctx, new Date(c.time * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), hx, PH + 11, '#1d2a24', text, 'center');
      }
    }
  }
  destroy() { this.ro.disconnect(); this.canvas.remove(); }
}

function label(ctx, s, x, y, bg, fg, align, width) {
  ctx.font = 'bold 11px "JetBrains Mono", monospace';
  const w = width || ctx.measureText(s).width + 10;
  let lx = x;
  if (align === 'center') lx = x - w / 2;
  ctx.fillStyle = bg;
  ctx.fillRect(lx, y - 9, w, 18);
  ctx.fillStyle = fg;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(s, lx + 5, y + 0.5);
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
function timeLabel(sec, data) {
  const d = new Date(sec * 1000);
  const spanDays = data.length > 1 ? (data[data.length - 1].time - data[0].time) / 86400 : 0;
  if (d.getHours() === 0 && d.getMinutes() === 0 && spanDays > 1) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
