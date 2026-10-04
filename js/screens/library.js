// Library: add many PDFs at once, give each a type with one tap.
import { h, icon, toast, sheet, confirmSheet, pickFiles, uid, plural } from '../util.js';
import { dbPut } from '../db.js';
import { pdfList, putPdf, deletePdf, sectionsOf, KIND_LABEL } from '../store.js';
import { inspectPdf, dropDoc } from '../pdf.js';
import { nav, openRead, requestPersist } from '../app.js';

const KINDS = ['question', 'paper', 'reading'];

export async function addPdfs(onProgress) {
  const files = (await pickFiles('application/pdf,.pdf', true))
    .filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length) return 0;
  requestPersist();
  let added = 0, skipped = 0;
  const base = Date.now();
  for (const [i, f] of files.entries()) {
    const name = f.name.replace(/\.pdf$/i, '');
    if (pdfList().some((p) => p.name === name && p.bytes === f.size)) { skipped++; continue; }
    toast(`Adding ${i + 1} of ${files.length}: ${name}`, null, 60000);
    try {
      // Copy the bytes so the PDF lives inside the app, not as a link to the file.
      const buf = await f.arrayBuffer();
      const id = uid();
      await dbPut('files', { id, blob: new Blob([buf], { type: 'application/pdf' }) });
      putPdf({ id, name, kind: null, added: base + i, bytes: f.size, pages: null, pos: null });
      added++;
      await inspectPdf(id, new Uint8Array(buf));
      onProgress && onProgress();
    } catch (err) {
      const full = err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message));
      toast(full ? 'Your phone is out of space for more PDFs.' : `Could not add ${name}.`, null, 5000);
      if (full) break;
    }
  }
  toast(`${plural(added, 'PDF')} added` + (skipped ? `, ${skipped} already here` : '') + (added ? '. Tap a type for each.' : ''), null, 4000);
  return added;
}

export function renderLibrary(root) {
  const draw = () => {
    const list = pdfList();
    const groups = [
      ['Choose a type', list.filter((p) => !p.kind)],
      ['Question books', list.filter((p) => p.kind === 'question')],
      ['Past papers', list.filter((p) => p.kind === 'paper')],
      ['Reading', list.filter((p) => p.kind === 'reading')],
    ];
    root.replaceChildren(
      h('header', { class: 'top' }, h('h1', null, 'Library'),
        h('button', { class: 'btn primary', onclick: () => addPdfs(draw).then(draw) }, icon('add'), 'Add PDFs')),
      h('div', { class: 'pad' },
        list.length ? null : h('div', { class: 'empty' },
          h('p', null, 'Add your books, past papers and reading as PDFs from the Files app. You can pick many at once.'),
          h('button', { class: 'btn big primary', onclick: () => addPdfs(draw).then(draw) }, icon('add'), 'Add PDFs')),
        groups.filter(([, g]) => g.length).map(([title, g]) => [
          h('h2', { class: 'group' }, title),
          g.map((p) => pdfRow(p, draw)),
        ])));
  };
  draw();
}

function pdfRow(p, redraw) {
  const secs = sectionsOf(p.id);
  const done = secs.filter((s) => s.done).length;
  const meta = [
    p.error ? p.error : p.pages ? plural(p.pages, 'page') : 'Reading…',
    secs.length ? `${done}/${secs.length} sections done` : null,
    p.pos && p.pos.page > 1 ? `at p.${p.pos.page}` : null,
  ].filter(Boolean).join(' · ');
  return h('div', { class: 'pdfrow' + (p.kind ? '' : ' untyped') },
    h('button', { class: 'pdf-open', onclick: () => openRead(p.id) },
      h('b', null, p.name), h('small', null, meta)),
    h('div', { class: 'seg' },
      KINDS.map((k) => h('button', {
        class: 'seg-btn' + (p.kind === k ? ' on' : ''),
        'aria-pressed': p.kind === k ? 'true' : 'false',
        onclick: () => { p.kind = k; putPdf(p); redraw(); },
      }, KIND_LABEL[k])),
      h('button', { class: 'seg-more', 'aria-label': 'More', onclick: () => rowMenu(p, redraw) }, icon('more'))));
}

function rowMenu(p, redraw) {
  const close = sheet(p.name, [
    h('button', { class: 'listbtn', onclick: () => { close(); openRead(p.id); } }, 'Open'),
    h('button', { class: 'listbtn', onclick: () => { close(); openRead(p.id, { page: 1 }); } }, 'Open at page 1'),
    h('button', { class: 'listbtn danger-text', onclick: async () => {
      close();
      if (await confirmSheet('Remove this PDF?', 'Its sections, scores and redo items are removed too. Cards stay.', 'Remove', true)) {
        dropDoc(p.id);
        deletePdf(p.id);
        toast('Removed');
        redraw();
      }
    } }, 'Remove from library'),
  ]);
}

export { nav };
