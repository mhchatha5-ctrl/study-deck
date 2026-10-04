// Continuous page-by-page PDF viewer drawn with PDF.js onto canvases.
// One-finger scrolling is native; two-finger pinch and double-tap zoom are
// handled here so the rest of the app never zooms.
import { h, clamp } from './util.js';
import { getDoc, holdDoc } from './pdf.js';
import { S, putPdf } from './store.js';

const GAP = 8;
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
// Cap canvas size: phones (iPhone especially) refuse very large canvases.
const MAX_PIXELS = 8e6;

export class PdfViewer {
  constructor(host, { onChange } = {}) {
    this.onChange = onChange || (() => {});
    this.el = h('div', { class: 'pv' });
    this.inner = h('div', { class: 'pv-inner' });
    this.el.append(this.inner);
    host.append(this.el);
    this.zoom = 1;
    this.pdfId = null;
    this.doc = null;
    this.pages = [];
    this.live = new Set();
    this.active = true;
    this.cur = 1;
    this.token = 0;
    this.busy = false;
    this.pendingPos = null;
    this.el.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(this.el);
    this.bindTouch();
  }

  async open(pdfId, pos = {}) {
    const token = ++this.token;
    if (this.pdfId !== pdfId || !this.doc) {
      if (this.pdfId) holdDoc(this.pdfId, false);
      holdDoc(pdfId, true);
      this.clear();
      this.pdfId = pdfId;
      this.meta = S.pdfs.get(pdfId);
      this.inner.replaceChildren(h('div', { class: 'pv-loading' }, 'Opening…'));
      let doc;
      try {
        doc = await getDoc(pdfId);
      } catch (err) {
        if (token === this.token) this.inner.replaceChildren(h('div', { class: 'pv-loading' }, err.message || 'Could not open this PDF.'));
        throw err;
      }
      if (token !== this.token) return;
      this.doc = doc;
      this.n = doc.numPages;
      this.zoom = clamp(pos.zoom || 1, MIN_ZOOM, MAX_ZOOM);
      this.buildPages();
      this.layout();
      this.scrollToPos(pos);
      this.measureAll(token);
    } else {
      this.scrollToPos(pos);
    }
    this.schedule();
    this.emit(true);
  }

  clear() {
    for (const p of this.pages) {
      if (p.task) p.task.cancel();
      this.dropCanvas(p);
    }
    this.pages = [];
    this.live.clear();
    this.doc = null;
    this.inner.replaceChildren();
  }

  destroy() {
    this.token++;
    this.ro.disconnect();
    this.clear();
    if (this.pdfId) holdDoc(this.pdfId, false);
    this.pdfId = null;
    this.el.remove();
  }

  setActive(on) {
    this.active = on;
    if (on) { this.onResize(); this.schedule(); }
  }

  buildPages() {
    const sizes = this.meta && this.meta.sizes;
    const def = (this.meta && this.meta.size) || [612, 792];
    const frag = document.createDocumentFragment();
    this.pages = [];
    for (let i = 0; i < this.n; i++) {
      const [w, ht] = (sizes && sizes[i]) || def;
      const div = h('div', { class: 'pv-page' }, h('span', { class: 'pv-num' }, String(i + 1)));
      frag.append(div);
      this.pages.push({ div, aspect: ht / w, canvas: null, rz: 0, task: null, top: 0, h: 0 });
    }
    this.inner.replaceChildren(frag);
  }

  layout() {
    const W = this.el.clientWidth;
    if (!W || !this.pages.length) return false;
    this.width = W;
    const pw = Math.round(W * this.zoom);
    let y = 0;
    for (const p of this.pages) {
      p.top = y;
      p.h = Math.round(pw * p.aspect);
      p.div.style.cssText = `top:${y}px;width:${pw}px;height:${p.h}px`;
      y += p.h + GAP;
    }
    this.pw = pw;
    this.inner.style.width = pw + 'px';
    this.inner.style.height = Math.round(y + this.el.clientHeight * 0.55) + 'px';
    this.el.style.overflowX = this.zoom > 1.001 ? 'auto' : 'hidden';
    return true;
  }

  pageAtY(y) {
    let lo = 0, hi = this.pages.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.pages[mid].top <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  anchorAt(vx, vy) {
    const cy = this.el.scrollTop + vy;
    const i = this.pageAtY(cy);
    const p = this.pages[i];
    return { i, fy: p && p.h ? (cy - p.top) / p.h : 0, fx: this.pw ? (this.el.scrollLeft + vx) / this.pw : 0 };
  }

  applyAnchor(a, vx, vy) {
    const p = this.pages[a.i];
    if (!p) return;
    this.el.scrollLeft = a.fx * this.pw - vx;
    this.el.scrollTop = p.top + a.fy * p.h - vy;
  }

  relayoutKeep() {
    if (!this.pages.length) return;
    const a = this.anchorAt(0, 0);
    if (this.layout()) this.applyAnchor(a, 0, 0);
  }

  // Position of the top edge of the screen: page number + fraction down that page.
  getPos() {
    if (!this.pages.length) return this.pendingPos || { page: 1, frac: 0, zoom: this.zoom };
    const st = this.el.scrollTop;
    const i = this.pageAtY(st);
    const p = this.pages[i];
    return { page: i + 1, frac: p.h ? clamp((st - p.top) / p.h, 0, 1) : 0, zoom: this.zoom };
  }

  scrollToPos(pos) {
    const page = clamp(pos.page || 1, 1, this.pages.length || 1);
    if (!this.width) { this.pendingPos = { page, frac: pos.frac || 0 }; return; }
    const p = this.pages[page - 1];
    if (!p) return;
    this.el.scrollTop = p.top + (pos.frac || 0) * p.h;
    if (pos.frac == null || pos.frac === 0) this.el.scrollLeft = 0;
    this.pendingPos = null;
  }

  goTo(page) {
    this.scrollToPos({ page, frac: 0 });
    this.schedule();
    this.emit(true);
  }

  currentPage() {
    if (!this.pages.length) return this.pendingPos ? this.pendingPos.page : 1;
    return this.pageAtY(this.el.scrollTop + this.el.clientHeight * 0.4) + 1;
  }

  emit(force) {
    const cur = this.currentPage();
    if (force || cur !== this.cur) { this.cur = cur; this.onChange({ cur, changed: true }); }
    else this.onChange({ cur, changed: false });
  }

  onScroll() {
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      this.emit(false);
      this.schedule();
    });
  }

  onResize() {
    const W = this.el.clientWidth;
    if (!W || !this.pages.length) return;
    if (W !== this.width) {
      const pending = this.pendingPos;
      const a = this.width ? this.anchorAt(0, 0) : null;
      this.layout();
      if (pending) this.scrollToPos(pending);
      else if (a) this.applyAnchor(a, 0, 0);
      this.schedule();
    }
  }

  setZoom(z, anchor, vx, vy) {
    this.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
    this.layout();
    this.applyAnchor(anchor, vx, vy);
    this.schedule();
    this.emit(false);
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.renderVisible(); });
  }

  renderVisible() {
    if (!this.doc || !this.active || !this.pages.length || this.busy) return;
    const top = this.el.scrollTop, bottom = top + this.el.clientHeight;
    const first = this.pageAtY(top), last = this.pageAtY(bottom);
    const keepFrom = first - 1, keepTo = last + 1;
    for (const i of [...this.live]) if (i < keepFrom - 1 || i > keepTo + 1) this.release(i);
    const cur = this.currentPage() - 1;
    const order = [];
    for (let i = first; i <= last; i++) order.push(i);
    order.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
    if (last + 1 < this.n) order.push(last + 1);
    if (first - 1 >= 0) order.push(first - 1);
    for (const i of order) {
      const p = this.pages[i];
      if (!p.failed && (!p.canvas || p.rz !== this.zoom || p.rw !== this.pw)) {
        this.renderPage(i);
        return;
      }
    }
  }

  async renderPage(i) {
    const p = this.pages[i];
    const token = this.token, zoom = this.zoom, pw = this.pw;
    this.busy = true;
    try {
      const page = await this.doc.getPage(i + 1);
      if (token !== this.token) return;
      const vp1 = page.getViewport({ scale: 1 });
      const aspect = vp1.height / vp1.width;
      if (Math.abs(aspect - p.aspect) > 0.002) {
        p.aspect = aspect;
        this.relayoutKeep();
      }
      if (zoom !== this.zoom || pw !== this.pw) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      let cw = this.pw * dpr, ch = cw * aspect;
      const area = cw * ch;
      if (area > MAX_PIXELS) { const k = Math.sqrt(MAX_PIXELS / area); cw *= k; ch *= k; }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(cw));
      canvas.height = Math.max(1, Math.floor(ch));
      canvas.className = 'pv-canvas';
      const ctx = canvas.getContext('2d', { alpha: false });
      const viewport = page.getViewport({ scale: canvas.width / vp1.width });
      const task = page.render({ canvasContext: ctx, canvas, viewport, background: 'rgb(255,255,255)' });
      p.task = task;
      await task.promise;
      p.task = null;
      if (token !== this.token) { canvas.width = canvas.height = 0; return; }
      this.dropCanvas(p);
      p.canvas = canvas;
      p.rz = zoom;
      p.rw = pw;
      p.div.append(canvas);
      this.live.add(i);
    } catch (err) {
      p.task = null;
      if (!err || err.name !== 'RenderingCancelledException') {
        p.failed = true;
        p.div.classList.add('pv-err');
      }
    } finally {
      if (token === this.token) { this.busy = false; this.schedule(); }
    }
  }

  dropCanvas(p) {
    if (p.canvas) {
      p.canvas.remove();
      p.canvas.width = p.canvas.height = 0;
      p.canvas = null;
      p.rz = 0;
    }
  }

  release(i) {
    const p = this.pages[i];
    if (!p) return;
    if (p.task) { p.task.cancel(); p.task = null; }
    this.dropCanvas(p);
    this.live.delete(i);
    if (this.doc) this.doc.getPage(i + 1).then((pg) => pg.cleanup()).catch(() => {});
  }

  // Learn the true size of every page in the background so long scrolls stay
  // accurate; remember it so the next open lays out exactly at once.
  async measureAll(token) {
    if (!this.meta || this.meta.measured || (this.meta.sizes && this.meta.sizes.length === this.n)) return;
    const sizes = [];
    let differs = false;
    const base = this.meta.size;
    for (let i = 0; i < this.n; i++) {
      if (token !== this.token) return;
      try {
        const pg = await this.doc.getPage(i + 1);
        const vp = pg.getViewport({ scale: 1 });
        const s = [Math.round(vp.width), Math.round(vp.height)];
        sizes.push(s);
        if (!base || Math.abs(s[1] / s[0] - base[1] / base[0]) > 0.002) differs = true;
      } catch {
        sizes.push(base || [612, 792]);
      }
      if (i % 25 === 24) await new Promise((r) => setTimeout(r, 0));
    }
    if (token !== this.token) return;
    if (differs) {
      this.meta.sizes = sizes;
      let changed = false;
      sizes.forEach(([w, ht], i) => {
        const a = ht / w;
        if (Math.abs(a - this.pages[i].aspect) > 0.002) { this.pages[i].aspect = a; changed = true; }
      });
      if (changed) this.relayoutKeep();
    } else {
      this.meta.sizes = null;
    }
    this.meta.measured = true;
    putPdf(this.meta);
  }

  bindTouch() {
    const el = this.el;
    let pinch = null, tap = null, lastTap = null;
    const rel = (t) => {
      const r = el.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        const a = rel(e.touches[0]), b = rel(e.touches[1]);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        pinch = {
          d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid0: mid, z0: this.zoom, s: 1, tx: 0, ty: 0,
          anchor: this.anchorAt(mid.x, mid.y),
        };
        this.inner.style.transformOrigin = `${el.scrollLeft + mid.x}px ${el.scrollTop + mid.y}px`;
        tap = null;
        e.preventDefault();
      } else if (e.touches.length === 1) {
        const p = rel(e.touches[0]);
        tap = { x: p.x, y: p.y, t: Date.now() };
      } else tap = null;
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length === 2) {
        const a = rel(e.touches[0]), b = rel(e.touches[1]);
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const z = clamp((pinch.z0 * d) / pinch.d0, MIN_ZOOM * 0.85, MAX_ZOOM * 1.1);
        pinch.s = z / pinch.z0;
        pinch.tx = (a.x + b.x) / 2 - pinch.mid0.x;
        pinch.ty = (a.y + b.y) / 2 - pinch.mid0.y;
        this.inner.style.transform = `translate(${pinch.tx}px,${pinch.ty}px) scale(${pinch.s})`;
        if (e.cancelable) e.preventDefault();
      } else if (tap && e.touches.length === 1) {
        const p = rel(e.touches[0]);
        if (Math.hypot(p.x - tap.x, p.y - tap.y) > 10) tap = null;
      }
    }, { passive: false });

    const end = (e) => {
      if (pinch) {
        if (e.touches.length >= 2) return;
        const p = pinch;
        pinch = null;
        this.inner.style.transform = '';
        this.setZoom(p.z0 * p.s, p.anchor, p.mid0.x + p.tx, p.mid0.y + p.ty);
        tap = lastTap = null;
        return;
      }
      if (tap && e.touches.length === 0 && Date.now() - tap.t < 300) {
        const now = Date.now();
        if (lastTap && now - lastTap.t < 330 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 35) {
          this.setZoom(this.zoom > 1.2 ? 1 : 2.5, this.anchorAt(tap.x, tap.y), tap.x, tap.y);
          lastTap = null;
          if (e.cancelable) e.preventDefault();
        } else {
          lastTap = { x: tap.x, y: tap.y, t: now };
        }
      }
      tap = null;
    };
    el.addEventListener('touchend', end, { passive: false });
    el.addEventListener('touchcancel', end);
    el.addEventListener('gesturestart', (e) => e.preventDefault());
    el.addEventListener('gesturechange', (e) => e.preventDefault());
    // Desktop: ctrl + wheel / trackpad pinch.
    el.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      this.setZoom(this.zoom * Math.exp(-e.deltaY / 200), this.anchorAt(x, y), x, y);
    }, { passive: false });
    el.addEventListener('dblclick', (e) => {
      if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      this.setZoom(this.zoom > 1.2 ? 1 : 2.5, this.anchorAt(x, y), x, y);
    });
  }
}
