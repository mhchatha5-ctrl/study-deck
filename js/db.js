// On-device storage (IndexedDB). Nothing ever leaves the phone.
//
// UPGRADE RULE: database versions may only ADD stores or indexes.
// Never delete or clear a store in onupgradeneeded, so app updates can
// never wipe the user's data or PDFs.

const DB_NAME = 'study-deck';
const DB_VERSION = 1;

const STORES = {
  kv: { keyPath: 'k' },          // settings and small state
  pdfs: { keyPath: 'id' },       // PDF metadata
  files: { keyPath: 'id' },      // PDF bytes (Blob), kept apart from metadata
  sections: { keyPath: 'id' },
  marks: { keyPath: 'id' },      // latest first-pass mark per section + question number
  log: { keyPath: 'id' },        // every tick / cross / ? with a timestamp
  redo: { keyPath: 'id' },
  cards: { keyPath: 'id' },
  papers: { keyPath: 'id' },     // timed past paper sessions
};

let dbp;
export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, opts] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Storage is busy. Close other tabs of this app.'));
  });
  return dbp;
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage write was aborted'));
  }));
}

export const dbGetAll = (store) => tx(store, 'readonly', (s) => s.getAll());
export const dbGet = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const dbPut = (store, val) => tx(store, 'readwrite', (s) => s.put(val));
export const dbDel = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const dbClear = (store) => tx(store, 'readwrite', (s) => s.clear());

export function dbPutMany(store, vals) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const v of vals) s.put(v);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage write was aborted'));
  }));
}

export const STORE_NAMES = Object.keys(STORES);
