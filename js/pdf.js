// Loads PDFs with PDF.js. Pages are only ever drawn as images on a canvas:
// no text is extracted, converted or retyped. Scanned pages work the same way.
import { dbGet } from './db.js';
import { S, putPdf } from './store.js';

const BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
let libP, worker;

export function pdfjs() {
  if (!libP) {
    libP = import('../vendor/pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';
      worker = new lib.PDFWorker({ name: 'study-deck' });
      return lib;
    });
  }
  return libP;
}

async function openData(data) {
  const lib = await pdfjs();
  return lib.getDocument({
    data,
    worker,
    wasmUrl: BASE + 'wasm/',
    cMapUrl: BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
    iccUrl: BASE + 'iccs/',
    isEvalSupported: false,
    enableXfa: false,
    verbosity: 0,
  }).promise;
}

// Small cache of open documents so flipping between question and answer PDFs is instant.
const cache = new Map(); // id -> { p: Promise<doc>, used }
const MAX_DOCS = 3;
const held = new Map(); // id -> count of viewers showing it

export function holdDoc(id, on) {
  held.set(id, (held.get(id) || 0) + (on ? 1 : -1));
  if (held.get(id) <= 0) held.delete(id);
}

export function getDoc(id) {
  let e = cache.get(id);
  if (!e) {
    e = {
      p: dbGet('files', id).then(async (row) => {
        if (!row) throw new Error('This PDF file is missing from storage.');
        const buf = await row.blob.arrayBuffer();
        return openData(new Uint8Array(buf));
      }),
    };
    e.p.catch(() => cache.delete(id));
    cache.set(id, e);
    trim();
  }
  e.used = Date.now();
  return e.p;
}

function trim() {
  if (cache.size <= MAX_DOCS) return;
  const old = [...cache.entries()]
    .filter(([id]) => !held.has(id))
    .sort((a, b) => a[1].used - b[1].used);
  while (cache.size > MAX_DOCS && old.length) {
    const [id, e] = old.shift();
    cache.delete(id);
    e.p.then((d) => d.destroy()).catch(() => {});
  }
}

export function dropDoc(id) {
  const e = cache.get(id);
  if (e) { cache.delete(id); e.p.then((d) => d.destroy()).catch(() => {}); }
}

// Built-in bookmarks -> [{title, page}] at the first level that has 2+ entries.
async function readOutline(doc) {
  let items;
  try { items = await doc.getOutline(); } catch { return []; }
  if (!items || !items.length) return [];
  let level = items;
  while (level.length === 1 && level[0].items && level[0].items.length) level = level[0].items;
  const out = [];
  for (const it of level.slice(0, 300)) {
    try {
      let dest = it.dest;
      if (typeof dest === 'string') dest = await doc.getDestination(dest);
      if (!Array.isArray(dest)) continue;
      const ref = dest[0];
      const idx = typeof ref === 'object' && ref ? await doc.getPageIndex(ref) : Number.isInteger(ref) ? ref : null;
      if (idx == null) continue;
      out.push({ title: (it.title || '').trim().slice(0, 120) || `Page ${idx + 1}`, page: idx + 1 });
    } catch { /* skip broken bookmark */ }
  }
  out.sort((a, b) => a.page - b.page);
  return out.filter((o, i) => i === 0 || o.page !== out[i - 1].page);
}

// Fill in page count, first page size and bookmarks after import. When the
// bytes are already in memory (just imported) they are used directly.
export async function inspectPdf(id, data) {
  const p = S.pdfs.get(id);
  if (!p) return;
  let own = null;
  try {
    const doc = data ? (own = await openData(data)) : await getDoc(id);
    const page1 = await doc.getPage(1);
    const vp = page1.getViewport({ scale: 1 });
    p.pages = doc.numPages;
    p.size = [Math.round(vp.width), Math.round(vp.height)];
    p.outline = await readOutline(doc);
    p.ready = true;
    p.error = null;
  } catch (err) {
    p.error = err && err.name === 'PasswordException'
      ? 'This PDF is password protected.'
      : 'Could not open this PDF.';
  }
  if (own) own.destroy().catch(() => {});
  putPdf(p);
}
