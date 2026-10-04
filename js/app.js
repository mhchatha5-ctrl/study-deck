// App shell: start-up, navigation, theme, offline worker, storage permission.
import { h, icon, toast, closeSheets, today, daysBetween, dockToasts, whenHistorySettled } from './util.js';
import { openDB } from './db.js';
import { S, loadAll, kv, setKv, settings, dueRedo, flushPos } from './store.js';
import { refreshRota } from './rota.js';

const TABS = [
  ['today', 'Today'],
  ['library', 'Library'],
  ['cards', 'Cards'],
  ['progress', 'Progress'],
  ['settings', 'Settings'],
];

let navState = null;   // extra options for the next route (e.g. page to open)
let depth = 0;         // in-app history depth, so Back never leaves the app
let cleanup = null;    // teardown for the current screen
let screens;

export function nav(hash, replace) {
  whenHistorySettled(() => {
    if (location.hash === hash) { route(); return; }
    if (replace) { location.replace(hash); }
    else { depth++; location.hash = hash; }
  });
}
export function goBack() {
  whenHistorySettled(() => {
    if (depth > 0) history.back();
    else nav('#/today', true);
  });
}
export function openRead(pdfId, opts = {}) {
  navState = { pdfId, ...opts };
  nav('#/read/' + pdfId);
}
export function startQuick5() {
  try { sessionStorage.setItem('q5start', String(Date.now())); } catch { /* private mode */ }
  if (dueRedo().length) nav('#/quick5');
  else if (S.cards.size) nav('#/quick5/cards');
  else toast('Nothing for Quick 5 yet: no redo items due and no cards.');
}

async function route() {
  // Remember how deep we are in this entry, so Back never leaves the app.
  const hs = history.state;
  if (hs && typeof hs.d === 'number') depth = hs.d;
  else history.replaceState({ ...(hs || {}), d: depth }, '');
  closeSheets();
  dockToasts(null);
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const root = document.getElementById('screen');
  const [, name = 'today', arg, arg2] = (location.hash || '#/today').split('/');
  const study = name === 'read' || name === 'redo' || name === 'quick5';
  const full = study || (name === 'cards' && (arg === 'review' || arg === 'audio'));
  document.body.classList.toggle('fullscreen', full);
  if (!study) screens.study.leaveStudy();
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  root.scrollTop = 0;

  switch (name) {
    case 'read': {
      const st = navState && navState.pdfId === arg ? navState : { pdfId: arg };
      navState = null;
      const pdf = S.pdfs.get(arg);
      if (!pdf) { nav('#/library', true); return; }
      const pos = st.page ? { page: st.page, frac: st.frac || 0, zoom: pdf.pos && pdf.pos.zoom } : (pdf.pos || { page: 1 });
      screens.study.openStudy(root, { pdfId: arg, ...pos, timed: st.timed });
      break;
    }
    case 'redo':
      screens.study.openStudy(root, { mode: 'redo' });
      break;
    case 'quick5':
      if (arg === 'cards') { screens.study.leaveStudy(); document.body.classList.add('fullscreen'); screens.cards.renderReview(root, { quick5: true }); }
      else screens.study.openStudy(root, { mode: 'redo', quick5: true });
      break;
    case 'library': screens.library.renderLibrary(root); break;
    case 'cards':
      if (arg === 'review') screens.cards.renderReview(root);
      else if (arg === 'audio') cleanup = screens.cards.renderAudio(root);
      else screens.cards.renderCards(root);
      break;
    case 'progress': screens.progress.renderProgress(root); break;
    case 'settings': screens.settings.renderSettings(root, arg2); break;
    default: screens.today.renderToday(root);
  }
}

// ---------- theme ----------
export function applyTheme() {
  const t = settings().theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#121417' : '#f6f4ef');
}

// ---------- persistent storage ----------
export async function requestPersist() {
  if (!navigator.storage || !navigator.storage.persist) { setKv('persist', 'unsupported'); return 'unsupported'; }
  try {
    if (await navigator.storage.persisted()) { setKv('persist', 'granted'); return 'granted'; }
    const ok = await navigator.storage.persist();
    setKv('persist', ok ? 'granted' : 'denied');
    if (!ok) toast('Your browser refused permanent storage. See Settings › Data.', null, 6000);
    return ok ? 'granted' : 'denied';
  } catch {
    setKv('persist', 'denied');
    return 'denied';
  }
}

// ---------- install (Android Chrome shows its own install prompt) ----------
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  if (/^#\/(today|settings)?/.test(location.hash || '#/')) route();
});
window.addEventListener('appinstalled', () => { installEvt = null; });
export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const canInstall = () => !!installEvt && !isStandalone();
export async function promptInstall() {
  if (!installEvt) return false;
  installEvt.prompt();
  const r = await installEvt.userChoice.catch(() => ({}));
  installEvt = null;
  route();
  return r.outcome === 'accepted';
}

// ---------- notices shown on Today ----------
let waitingWorker = null;
export function banners() {
  const out = [];
  if (waitingWorker) {
    out.push(h('div', { class: 'banner' }, h('span', null, 'An app update is ready. Your data and PDFs stay.'),
      h('button', { class: 'btn', onclick: () => { waitingWorker.postMessage('skipWaiting'); } }, 'Update')));
  }
  if (canInstall() && !kv('installDismissed')) {
    out.push(h('div', { class: 'banner' }, h('span', null, 'Install Study Deck on your phone. It opens like an app, works offline and keeps your data safer.'),
      h('button', { class: 'btn', onclick: promptInstall }, 'Install'),
      h('button', { class: 'iconbtn', 'aria-label': 'Not now', onclick: (e) => { setKv('installDismissed', true); e.currentTarget.parentElement.remove(); } }, icon('close'))));
  }
  if (kv('persist') === 'denied') {
    out.push(h('div', { class: 'banner warn' }, h('span', null, 'Your browser has not promised to keep this app’s data. Install it to your Home Screen and export a backup now and then.'),
      h('button', { class: 'btn', onclick: () => nav('#/settings') }, 'Details')));
  }
  const last = kv('lastExport');
  const hasData = S.pdfs.size || S.cards.size;
  const first = kv('firstUse');
  const age = last ? daysBetween(last, today()) : first ? daysBetween(first, today()) : 0;
  if (hasData && age >= 7) {
    out.push(h('div', { class: 'banner' }, h('span', null, last ? `Last backup ${age} days ago.` : 'You have not made a backup yet.'),
      h('button', { class: 'btn', onclick: () => screens.settings.exportBackup().then(() => route()) }, 'Back up')));
  }
  return out;
}

// ---------- start ----------
async function start() {
  // Stop iOS Safari zooming the whole app with a pinch outside the PDF.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  try {
    await openDB();
    await loadAll();
  } catch (err) {
    document.getElementById('screen').replaceChildren(h('div', { class: 'pad' },
      h('h1', null, 'Storage unavailable'),
      h('p', null, 'This browser is not letting the app store data (private browsing can do this). ' + (err && err.message ? err.message : ''))));
    return;
  }
  if (!kv('firstUse')) setKv('firstUse', today());
  screens = {
    study: await import('./screens/study.js'),
    library: await import('./screens/library.js'),
    today: await import('./screens/today.js'),
    cards: await import('./screens/cards.js'),
    progress: await import('./screens/progress.js'),
    settings: await import('./screens/settings.js'),
  };
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  const tabs = document.getElementById('tabs');
  tabs.replaceChildren(...TABS.map(([k, label]) =>
    h('button', { 'data-tab': k, onclick: () => nav('#/' + k, true) }, icon(k), h('span', null, label))));

  window.addEventListener('hashchange', route);
  window.addEventListener('pagehide', flushPos);
  route();

  // Read the rota feed each time the app opens (directly from the phone).
  refreshRota().then((changed) => { if (changed && /^#\/(today)?$/.test(location.hash || '#/')) route(); }).catch(() => {});
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then((p) => { if (p) setKv('persist', 'granted'); }).catch(() => {});
  }
  registerWorker();
}

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const watch = (w) => {
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          waitingWorker = w;
          if (/^#\/(today)?$/.test(location.hash || '#/')) route();
        }
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) waitingWorker = reg.waiting;
    reg.addEventListener('updatefound', () => watch(reg.installing));
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (waitingWorker && !reloaded) { reloaded = true; location.reload(); }
  });
}

start();
