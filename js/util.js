// Small DOM, date and UI helpers shared by every screen.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- dates (local calendar days as 'YYYY-MM-DD') ----------
const pad = (n) => String(n).padStart(2, '0');
export function dstr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const today = () => dstr(new Date());
export function parseD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s, n) {
  const d = parseD(s);
  d.setDate(d.getDate() + n);
  return dstr(d);
}
export function daysBetween(a, b) {
  return Math.round((parseD(b) - parseD(a)) / 86400000);
}
export function weekStart(s = today()) {
  const d = parseD(s);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return d;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function niceDate(s) {
  const d = parseD(s);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}
export function fmtHM(sec) {
  const m = Math.round(sec / 60);
  const hh = Math.floor(m / 60), mm = m % 60;
  return hh ? `${hh}h ${pad(mm)}m` : `${mm} min`;
}
export const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
export const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function vibrate(ms = 15) {
  try { navigator.vibrate && navigator.vibrate(ms); } catch { /* not supported */ }
}

// ---------- toast ----------
let toastTimer;
export function toast(msg, action, ms = 3200) {
  const box = document.getElementById('toast');
  box.replaceChildren(h('span', null, msg));
  if (action) {
    box.append(h('button', {
      class: 'toast-btn',
      onclick: () => { box.classList.remove('show'); action.fn(); },
    }, action.label));
  }
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), ms);
}

// Keep toasts just above a screen's bottom controls.
let dockRO;
export function dockToasts(el) {
  if (dockRO) dockRO.disconnect();
  const root = document.documentElement;
  if (!el) { root.style.removeProperty('--dock'); return; }
  dockRO = new ResizeObserver(() => root.style.setProperty('--dock', el.getBoundingClientRect().height + 'px'));
  dockRO.observe(el);
}

// ---------- history helpers (Android back button) ----------
// Each open sheet adds a history entry, so the phone's Back gesture closes
// the sheet instead of leaving the screen. Navigation waits until any
// sheet's own history entry has been removed.
let pendingPops = 0;
const afterPops = [];
export function whenHistorySettled(fn) {
  if (pendingPops) afterPops.push(fn); else fn();
}
window.addEventListener('popstate', () => {
  if (pendingPops) {
    pendingPops--;
    if (!pendingPops) afterPops.splice(0).forEach((f) => f());
    return;
  }
  const top = sheetStack[sheetStack.length - 1];
  if (top) top(true);
});

// ---------- bottom sheet ----------
let sheetStack = [];
export function sheet(title, body, { onClose } = {}) {
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-label': title || 'Options' },
    h('div', { class: 'sheet-grip' }),
    title ? h('h2', { class: 'sheet-title' }, title) : null,
    h('div', { class: 'sheet-body' }, body));
  const back = h('div', { class: 'sheet-back' }, panel);
  let pushed = false;
  const close = (fromHistory) => {
    if (!back.isConnected) return;
    back.classList.remove('show');
    setTimeout(() => back.remove(), 180);
    sheetStack = sheetStack.filter((c) => c !== close);
    if (pushed && fromHistory !== true) { pendingPops++; history.back(); }
    onClose && onClose();
  };
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  requestAnimationFrame(() => back.classList.add('show'));
  sheetStack.push(close);
  whenHistorySettled(() => {
    if (!back.isConnected) return;
    history.pushState({ ...(history.state || {}), sheet: true }, '');
    pushed = true;
  });
  return close;
}
// Close every sheet without touching history (used when the screen changes).
export function closeSheets() {
  [...sheetStack].forEach((c) => c(true));
}

export function confirmSheet(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const close = sheet(title, [
      text ? h('p', { class: 'muted' }, text) : null,
      h('button', { class: 'btn big ' + (danger ? 'danger' : 'primary'), onclick: () => { done = true; close(); resolve(true); } }, okLabel),
      h('button', { class: 'btn big ghost', onclick: () => close() }, 'Cancel'),
    ], { onClose: () => { if (!done) resolve(false); } });
  });
}

// ---------- icons (simple 24px stroke icons) ----------
const P = {
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  library: '<path d="M4 19V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2zM4 19a2 2 0 0 1 2-2h12"/>',
  cards: '<rect x="3" y="7" width="14" height="13" rx="2"/><path d="M7 4h12a2 2 0 0 1 2 2v11"/>',
  progress: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  flip: '<path d="M4 8h13l-4-4M20 16H7l4 4"/>',
  cover: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 12h16"/><path d="M4 12h16v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="currentColor"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 9v6M9 12h6"/>',
  done: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  tick: '<path d="M4 12.5l5 5L20 6.5"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  q: '<path d="M9 9a3 3 0 1 1 4.5 2.6c-1 .6-1.5 1.2-1.5 2.4"/><circle cx="12" cy="18" r="1" fill="currentColor"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  start: '<path d="M7 4l12 8-12 8z" fill="currentColor"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
  audio: '<path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  pause: '<rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/>',
  next: '<path d="M5 5l10 7-10 7z" fill="currentColor"/><path d="M19 5v14"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  section: '<path d="M4 4h16M4 9h10M4 14h16M4 19h10"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};
export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ic ' + cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = P[name] || '';
  return s;
}

// Pick files with a hidden input (must be called from a tap handler).
export function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.multiple = multiple;
    inp.addEventListener('change', () => { resolve([...inp.files]); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
}

// ---------- screen wake lock ----------
let wakeLock = null, wakeWanted = false;
export async function keepAwake(on) {
  wakeWanted = on;
  if (!('wakeLock' in navigator)) return false;
  try {
    if (on && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
    return true;
  } catch {
    return false;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeWanted) keepAwake(true);
});
