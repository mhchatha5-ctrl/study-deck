// In-memory copy of everything (except PDF bytes), written through to IndexedDB.
import { dbGetAll, dbPut, dbDel, dbPutMany } from './db.js';
import { uid, today, addDays, toast } from './util.js';

export const S = {
  pdfs: new Map(),
  sections: new Map(),
  marks: new Map(),
  log: [],
  redo: new Map(),
  cards: new Map(),
  papers: new Map(),
  kv: {},
};

export async function loadAll() {
  const [kvRows, pdfs, sections, marks, log, redo, cards, papers] = await Promise.all(
    ['kv', 'pdfs', 'sections', 'marks', 'log', 'redo', 'cards', 'papers'].map(dbGetAll));
  S.kv = {};
  for (const r of kvRows) S.kv[r.k] = r.v;
  const fill = (map, rows) => { map.clear(); for (const r of rows) map.set(r.id, r); };
  fill(S.pdfs, pdfs);
  fill(S.sections, sections);
  fill(S.marks, marks);
  fill(S.redo, redo);
  fill(S.cards, cards);
  fill(S.papers, papers);
  S.log = log.sort((a, b) => a.at - b.at);
}

let saveErrShown = 0;
function onSaveErr(err) {
  if (Date.now() - saveErrShown > 5000) {
    saveErrShown = Date.now();
    toast('Could not save on this phone: ' + (err && err.message ? err.message : err));
  }
}
export function save(store, obj) { return dbPut(store, obj).catch(onSaveErr); }
export function remove(store, id) { return dbDel(store, id).catch(onSaveErr); }
export function saveMany(store, objs) { return dbPutMany(store, objs).catch(onSaveErr); }

// ---------- key/value ----------
export const kv = (k, def) => (S.kv[k] === undefined ? def : S.kv[k]);
export function setKv(k, v) {
  S.kv[k] = v;
  save('kv', { k, v });
}

const DEFAULT_SETTINGS = {
  examDate: null,
  readEnd: null,
  qEnd: null,
  topics: [],
  theme: 'auto',
  invert: false,
  rate: 1,
  pause: 3,
  cover: { mode: 'below', pos: 0.45 },
};
export const settings = () => ({ ...DEFAULT_SETTINGS, ...kv('settings', {}) });
export function setSettings(patch) {
  setKv('settings', { ...kv('settings', {}), ...patch });
}

// ---------- PDFs ----------
export const pdfList = () =>
  [...S.pdfs.values()].sort((a, b) => a.added - b.added || a.name.localeCompare(b.name));
export function putPdf(p) {
  S.pdfs.set(p.id, p);
  save('pdfs', p);
}
export const KIND_LABEL = { question: 'Question book', paper: 'Past paper', reading: 'Reading' };

export function deletePdf(id) {
  S.pdfs.delete(id);
  remove('pdfs', id);
  remove('files', id);
  for (const s of [...S.sections.values()]) {
    if (s.pdfId === id) deleteSection(s.id);
    else if (s.aPdf === id) { s.aPdf = null; s.aPage = null; save('sections', s); }
  }
  for (const r of [...S.redo.values()]) if (r.pdfId === id || r.aPdf === id) removeRedo(r.id);
  const last = kv('last');
  if (last && last.pdfId === id) setKv('last', null);
}

// ---------- sections ----------
// A section runs from its start page until the next section starts. Answer
// start pages that sit inside the same PDF also end a range, so books with
// "questions, answers, questions, answers" chapters split correctly.
export function sectionsOf(pdfId) {
  return [...S.sections.values()].filter((s) => s.pdfId === pdfId).sort((a, b) => a.start - b.start);
}
function boundariesIn(pdfId) {
  const b = new Set();
  for (const s of S.sections.values()) {
    if (s.pdfId === pdfId) b.add(s.start);
    if (!s.same && s.aPdf === pdfId && s.aPage) b.add(s.aPage);
  }
  return [...b].sort((x, y) => x - y);
}
function nextBoundary(pdfId, page) {
  for (const x of boundariesIn(pdfId)) if (x > page) return x;
  return null;
}
export function qEnd(sec) {
  const nb = nextBoundary(sec.pdfId, sec.start);
  return nb ? nb - 1 : (S.pdfs.get(sec.pdfId)?.pages || sec.start);
}
export function aEnd(sec) {
  if (!sec.aPdf || !sec.aPage) return null;
  const nb = nextBoundary(sec.aPdf, sec.aPage);
  return nb ? nb - 1 : (S.pdfs.get(sec.aPdf)?.pages || sec.aPage);
}
export function sectionAt(pdfId, page) {
  let found = null;
  for (const s of sectionsOf(pdfId)) {
    if (s.start <= page) found = s;
    else break;
  }
  return found && page <= qEnd(found) ? found : null;
}
export function answersAt(pdfId, page) {
  for (const s of S.sections.values()) {
    if (s.same || s.aPdf !== pdfId || !s.aPage) continue;
    if (page >= s.aPage && page <= aEnd(s)) return s;
  }
  return null;
}
export function hasAnswers(sec) {
  return !!(sec && (sec.same || (sec.aPdf && sec.aPage)));
}
export function secLabel(sec) {
  if (!sec) return '';
  if (sec.title) return sec.title;
  const i = sectionsOf(sec.pdfId).findIndex((s) => s.id === sec.id);
  return `Section ${i + 1} · p.${sec.start}–${qEnd(sec)}`;
}
export function createSection(pdfId, start, extra = {}) {
  if (sectionsOf(pdfId).some((s) => s.start === start)) return null;
  const sec = {
    id: uid(), pdfId, start, title: '', topic: null, aPdf: null, aPage: null, same: false,
    startNum: 1, nextQ: 1, done: false, doneAt: null, lastPage: start, aLast: null,
    topicAsked: false, created: Date.now(), ...extra,
  };
  S.sections.set(sec.id, sec);
  save('sections', sec);
  return sec;
}
export function putSection(sec) {
  S.sections.set(sec.id, sec);
  save('sections', sec);
}
export function deleteSection(id) {
  S.sections.delete(id);
  remove('sections', id);
  for (const m of [...S.marks.values()]) if (m.sectionId === id) { S.marks.delete(m.id); remove('marks', m.id); }
  for (const r of [...S.redo.values()]) if (r.sectionId === id) removeRedo(r.id);
}
// All sections in library order: by PDF, then page.
export function allSectionsOrdered(kinds) {
  const out = [];
  for (const p of pdfList()) {
    if (kinds && !kinds.includes(p.kind)) continue;
    out.push(...sectionsOf(p.id));
  }
  return out;
}

// ---------- marks, redo ----------
export const markKey = (sectionId, qNum) => sectionId + ':' + qNum;

function putRedo(r) { S.redo.set(r.id, r); save('redo', r); }
export function removeRedo(id) { S.redo.delete(id); remove('redo', id); }
function addLog(rec) { S.log.push(rec); save('log', rec); return rec; }
function dropLog(rec) {
  const i = S.log.indexOf(rec);
  if (i >= 0) S.log.splice(i, 1);
  remove('log', rec.id);
}

// First-pass mark while working through a section. Returns an undo function.
export function markQuestion(sec, qNum, m, ctx) {
  const id = markKey(sec.id, qNum);
  const prevMark = S.marks.get(id);
  const prevRedo = S.redo.get(id) ? { ...S.redo.get(id) } : null;
  const prevNext = sec.nextQ;
  const paper = activePaper();
  const inPaper = paper && paper.status === 'running' && paper.pdfId === sec.pdfId;
  const prevPaperMark = inPaper ? paper.marks[id] : undefined;
  const now = Date.now();

  const rec = { id, sectionId: sec.id, pdfId: sec.pdfId, qNum, m, at: now, qPage: ctx.qPage, aPdf: ctx.aPdf, aPage: ctx.aPage };
  S.marks.set(id, rec);
  save('marks', rec);
  const logRec = addLog({ id: uid(), at: now, t: 'q', m, sectionId: sec.id, qNum });

  if (m === 'right') {
    if (prevRedo && !prevRedo.reviews) removeRedo(id);
  } else {
    putRedo({
      ...(prevRedo || { reviews: 0, created: now }),
      id, sectionId: sec.id, pdfId: sec.pdfId, qNum, qPage: ctx.qPage,
      aPdf: ctx.aPdf, aPage: ctx.aPage, same: !!sec.same, stage: 3, due: addDays(today(), 3),
    });
  }
  sec.nextQ = qNum + 1;
  putSection(sec);
  if (inPaper) { paper.marks[id] = m; save('papers', paper); }

  return () => {
    if (prevMark) { S.marks.set(id, prevMark); save('marks', prevMark); }
    else { S.marks.delete(id); remove('marks', id); }
    dropLog(logRec);
    if (prevRedo) putRedo(prevRedo); else if (S.redo.has(id)) removeRedo(id);
    sec.nextQ = prevNext;
    putSection(sec);
    if (inPaper) {
      if (prevPaperMark === undefined) delete paper.marks[id]; else paper.marks[id] = prevPaperMark;
      save('papers', paper);
    }
  };
}

export function dueRedo(d = today()) {
  return [...S.redo.values()]
    .filter((r) => r.due <= d && S.pdfs.has(r.pdfId))
    .sort((a, b) => a.due.localeCompare(b.due) || a.created - b.created);
}

// Redo rules: back after 3 days; a tick moves it to 10 days; a tick at the
// 10-day stage clears it; a cross (or ?) restarts it at 3 days.
export function reviewRedo(item, m) {
  const before = { ...item };
  const logRec = addLog({ id: uid(), at: Date.now(), t: 'redo', m, sectionId: item.sectionId, qNum: item.qNum });
  let result;
  if (m === 'right' && item.stage >= 10) {
    removeRedo(item.id);
    result = { cleared: true };
  } else {
    const stage = m === 'right' ? 10 : 3;
    Object.assign(item, { stage, due: addDays(today(), stage), reviews: (item.reviews || 0) + 1 });
    putRedo(item);
    result = { stage };
  }
  result.undo = () => {
    dropLog(logRec);
    Object.keys(item).forEach((k) => delete item[k]);
    Object.assign(item, before);
    putRedo(item);
  };
  return result;
}

// "Not today": anything due today moves to tomorrow.
export function postponeDue() {
  const t = today(), tm = addDays(t, 1);
  for (const r of S.redo.values()) if (r.due <= t) { r.due = tm; save('redo', r); }
}

// ---------- timed past papers ----------
export function activePaper() {
  const id = kv('activePaper');
  const p = id ? S.papers.get(id) : null;
  return p && p.status === 'running' ? p : null;
}
export function startPaper(pdfId, limitSec) {
  const p = { id: uid(), pdfId, startedAt: Date.now(), limitSec, takenSec: null, status: 'running', marks: {} };
  S.papers.set(p.id, p);
  save('papers', p);
  setKv('activePaper', p.id);
  return p;
}
export function paperElapsed(p) {
  return p.takenSec != null ? p.takenSec : (Date.now() - p.startedAt) / 1000;
}
export function stopPaperClock(p) {
  if (p.takenSec == null) { p.takenSec = Math.round((Date.now() - p.startedAt) / 1000); save('papers', p); }
}
export function paperCounts(p) {
  const c = { right: 0, wrong: 0, unsure: 0, total: 0 };
  for (const m of Object.values(p.marks || {})) { c[m]++; c.total++; }
  return c;
}
export function finishPaper(p) {
  stopPaperClock(p);
  Object.assign(p, { status: 'done', endedAt: Date.now() }, paperCounts(p));
  save('papers', p);
  setKv('activePaper', null);
}
export function cancelPaper(p) {
  S.papers.delete(p.id);
  remove('papers', p.id);
  setKv('activePaper', null);
}

// ---------- cards ----------
export function addCard(c) {
  const card = { id: uid(), created: Date.now(), last: null, seen: 0, n: 0, misses: 0, ...c };
  S.cards.set(card.id, card);
  save('cards', card);
  return card;
}
export function putCard(c) { S.cards.set(c.id, c); save('cards', c); }
export function deleteCard(id) { S.cards.delete(id); remove('cards', id); }
// Missed cards first, then new ones, then the longest unseen.
export function cardQueue() {
  const rank = (c) => (c.last === 'missed' ? 0 : c.last == null ? 1 : 2);
  return [...S.cards.values()].sort((a, b) =>
    rank(a) - rank(b) || (rank(a) === 1 ? a.created - b.created : a.seen - b.seen));
}
export function reviewCard(card, knew) {
  card.last = knew ? 'knew' : 'missed';
  card.seen = Date.now();
  card.n = (card.n || 0) + 1;
  if (!knew) card.misses = (card.misses || 0) + 1;
  putCard(card);
  addLog({ id: uid(), at: card.seen, t: 'card', m: card.last });
}

// ---------- reading position ----------
const pendingPos = new Map();
let posTimer;
export function savePos(pdfId, pos) {
  const p = S.pdfs.get(pdfId);
  if (!p) return;
  p.pos = pos;
  p.opened = Date.now();
  S.kv.last = { pdfId, page: pos.page };
  pendingPos.set(pdfId, p);
  clearTimeout(posTimer);
  posTimer = setTimeout(flushPos, 800);
}
export function flushPos() {
  clearTimeout(posTimer);
  for (const p of pendingPos.values()) save('pdfs', p);
  pendingPos.clear();
  if (S.kv.last) save('kv', { k: 'last', v: S.kv.last });
}
