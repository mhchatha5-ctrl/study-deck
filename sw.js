// Offline support. Caches the app's own files only. It never touches your
// data or PDFs (those live in IndexedDB) and never handles other websites.
const VERSION = '2b8d54605bee';
const APP_CACHE = 'sd-app-' + VERSION;
const RUNTIME = 'sd-runtime';
// PRECACHE-START
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/backup.js',
  './js/db.js',
  './js/pdf.js',
  './js/plan.js',
  './js/rota.js',
  './js/screens/cards.js',
  './js/screens/library.js',
  './js/screens/progress.js',
  './js/screens/settings.js',
  './js/screens/study.js',
  './js/screens/today.js',
  './js/store.js',
  './js/util.js',
  './js/viewer.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './vendor/pdfjs/wasm/jbig2.wasm',
  './vendor/pdfjs/wasm/jbig2_nowasm_fallback.js',
  './vendor/pdfjs/wasm/openjpeg.wasm',
  './vendor/pdfjs/wasm/openjpeg_nowasm_fallback.js',
  './vendor/pdfjs/wasm/qcms_bg.wasm',
  './vendor/pdfjs/standard_fonts/FoxitDingbats.pfb',
  './vendor/pdfjs/standard_fonts/FoxitFixed.pfb',
  './vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb',
  './vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb',
  './vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb',
  './vendor/pdfjs/standard_fonts/FoxitSerif.pfb',
  './vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb',
  './vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb',
  './vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb',
  './vendor/pdfjs/standard_fonts/FoxitSymbol.pfb',
  './vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf',
  './vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf',
  './vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf',
  './vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
  './vendor/pdfjs/iccs/CGATS001Compat-v2-micro.icc',
];
// PRECACHE-END

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('sd-app-') && k !== APP_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match(new URL('./index.html', self.location).href).then((r) => r || fetch(req)));
    return;
  }
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && url.pathname.includes('/vendor/pdfjs/')) {
      const c = await caches.open(RUNTIME);
      c.put(req, res.clone());
    }
    return res;
  })());
});
