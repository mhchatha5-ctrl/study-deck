// One-file backup of everything (PDFs included) and restore.
// File layout: a text line "STUDYDECK-BACKUP 1", a line with the header size,
// the JSON header, then the PDF bytes one after another. Built from Blob parts,
// so even large libraries never need to sit in memory as one string.
import { h, toast, today, niceDate, pickFiles, download, isIOS, confirmSheet, plural } from './util.js';
import { dbGetAll, dbClear, dbPutMany, dbPut, STORE_NAMES } from './db.js';
import { S, kv, setKv } from './store.js';
import { requestPersist } from './app.js';

const MAGIC = 'STUDYDECK-BACKUP 1';

export async function buildBackup(withPdfs = true) {
  const stores = {};
  for (const name of STORE_NAMES) if (name !== 'files') stores[name] = await dbGetAll(name);
  const files = [];
  const parts = [];
  let offset = 0;
  if (withPdfs) {
    for (const row of await dbGetAll('files')) {
      files.push({ id: row.id, size: row.blob.size, offset });
      parts.push(row.blob);
      offset += row.blob.size;
    }
  }
  const header = JSON.stringify({ app: 'study-deck', format: 1, created: new Date().toISOString(), stores, files });
  const headBytes = new TextEncoder().encode(header);
  return new Blob([`${MAGIC}\n${headBytes.length}\n`, headBytes, ...parts], { type: 'application/octet-stream' });
}

export async function exportBackup(withPdfs = true) {
  toast('Preparing backup…', null, 20000);
  try {
    const blob = await buildBackup(withPdfs);
    const name = `study-deck-backup-${today()}.studydeck`;
    const file = new File([blob], name, { type: 'application/octet-stream' });
    if (isIOS() && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
    } else {
      download(blob, name);
    }
    setKv('lastExport', today());
    toast(`Backup saved (${(blob.size / 1048576).toFixed(1)} MB). Keep it somewhere safe, e.g. Google Drive.`, null, 6000);
    return true;
  } catch (err) {
    if (err && err.name === 'AbortError') { toast('Backup cancelled'); return false; }
    toast('Backup failed: ' + (err && err.message ? err.message : err), null, 6000);
    return false;
  }
}

async function readHeader(file) {
  const head = await file.slice(0, 64).text();
  const m = head.match(/^STUDYDECK-BACKUP 1\n(\d+)\n/);
  if (!m) throw new Error('This is not a Study Deck backup file.');
  const start = m[0].length;
  const len = +m[1];
  const header = JSON.parse(await file.slice(start, start + len).text());
  if (header.app !== 'study-deck' || header.format !== 1) throw new Error('This backup is from an unknown version.');
  return { header, dataStart: start + len };
}

export async function importBackup(file) {
  const { header, dataStart } = await readHeader(file);
  const st = header.stores || {};
  const ok = await confirmSheet('Restore this backup?',
    `From ${niceDate(header.created.slice(0, 10))}: ${plural((st.pdfs || []).length, 'PDF')}, ${plural((st.cards || []).length, 'card')}. ` +
    'It replaces everything currently in the app.', 'Replace and restore', true);
  if (!ok) return false;
  toast('Restoring…', null, 60000);
  // Write PDFs first, so a failure part-way leaves the old data in place.
  const fileRows = [];
  for (const f of header.files || []) {
    const slice = file.slice(dataStart + f.offset, dataStart + f.offset + f.size);
    fileRows.push({ id: f.id, blob: new Blob([await slice.arrayBuffer()], { type: 'application/pdf' }) });
  }
  if (fileRows.length) await dbClear('files');
  for (const row of fileRows) await dbPut('files', row);
  for (const name of STORE_NAMES) {
    if (name === 'files') continue;
    await dbClear(name);
    if (st[name] && st[name].length) await dbPutMany(name, st[name]);
  }
  toast('Restored. Reloading…');
  setTimeout(() => location.reload(), 600);
  return true;
}

export function dataSettings(redraw) {
  const persist = kv('persist');
  const usage = h('div', { class: 'muted small' });
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((e) => {
      usage.textContent = `Using ${(e.usage / 1048576).toFixed(1)} MB of about ${(e.quota / 1073741824).toFixed(1)} GB available to this app.`;
    }).catch(() => {});
  }
  const withPdfs = h('input', { type: 'checkbox', checked: true });
  const last = kv('lastExport');
  return h('section', { class: 'card' },
    h('h2', null, 'Data and backup'),
    persist === 'granted' ? h('div', { class: 'status ok' }, 'Storage is permanent: the browser has promised not to clear your data.')
      : persist === 'denied' ? h('div', { class: 'status bad' }, 'The browser refused permanent storage. It may clear the app’s data if the phone runs low on space. Installing the app usually fixes this; keep weekly backups.')
        : h('div', { class: 'status warn' }, 'Permanent storage has not been granted yet.'),
    persist !== 'granted' ? h('button', { class: 'btn', onclick: () => requestPersist().then(redraw) }, 'Ask for permanent storage') : null,
    usage,
    h('label', { class: 'checkrow' }, withPdfs, h('span', null, 'Include PDFs in the backup')),
    h('button', { class: 'btn big primary', onclick: () => exportBackup(withPdfs.checked).then(redraw) }, 'Back up to one file'),
    h('p', { class: 'muted small' }, last ? `Last backup: ${niceDate(last)}.` : 'No backup yet. You will be reminded weekly.'),
    h('button', { class: 'btn big', onclick: async () => {
      const [f] = await pickFiles('', false);
      if (!f) return;
      try { await importBackup(f); } catch (err) { toast(err.message, null, 6000); }
    } }, 'Restore from a backup file'),
    h('p', { class: 'muted small' }, 'App updates never touch your data or PDFs.'));
}

export { S };
