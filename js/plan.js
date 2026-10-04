// Decides Today's single task from redo items, exam plan phases and the rota.
import { S, kv, settings, dueRedo, pdfList, sectionsOf, sectionAt, qEnd, activePaper } from './store.js';
import { today, addDays, daysBetween } from './util.js';
import { dayType } from './rota.js';

// Reading ~30%, question books ~45%, past papers ~25% of the time left.
export function proposePlan(examDate, from = today()) {
  const total = Math.max(0, daysBetween(from, examDate));
  return {
    readEnd: addDays(from, Math.round(total * 0.3)),
    qEnd: addDays(from, Math.round(total * 0.75)),
  };
}

export function phaseOn(d = today()) {
  const s = settings();
  if (!s.examDate) return null;
  if (d > s.examDate) return 'after';
  if (s.readEnd && d <= s.readEnd) return 'reading';
  if (s.qEnd && d <= s.qEnd) return 'questions';
  return 'papers';
}
export const PHASE_LABEL = { reading: 'Reading phase', questions: 'Question books phase', papers: 'Past papers phase', after: 'Exam passed' };

export function daysLeft() {
  const s = settings();
  return s.examDate ? daysBetween(today(), s.examDate) : null;
}

function secPos(s, pdf) {
  if (pdf && pdf.pos && pdf.pos.page >= s.start && pdf.pos.page <= qEnd(s)) return pdf.pos;
  const lp = s.lastPage && s.lastPage >= s.start && s.lastPage <= qEnd(s) ? s.lastPage : s.start;
  return { page: lp, frac: 0 };
}

// Where "Start" should take you: the exact place you stopped, or the next
// section once the current one is done.
export function nextStudy(kinds) {
  const pdfs = pdfList().filter((p) => !p.error && (!kinds || kinds.includes(p.kind)));
  if (!pdfs.length) return null;
  const recent = pdfs.filter((p) => p.opened).sort((a, b) => b.opened - a.opened)[0];
  if (recent) {
    const page = (recent.pos && recent.pos.page) || 1;
    const sec = sectionAt(recent.id, page);
    if (sec && !sec.done) return { pdfId: recent.id, pos: recent.pos, sec };
    const after = sectionsOf(recent.id).find((s) => !s.done && s.start > page);
    if (after) return { pdfId: recent.id, pos: secPos(after, recent), sec: after };
  }
  for (const p of pdfs) {
    const s = sectionsOf(p.id).find((x) => !x.done);
    if (s) return { pdfId: p.id, pos: secPos(s, p), sec: s };
  }
  if (recent) return { pdfId: recent.id, pos: recent.pos };
  const first = pdfs[0];
  return { pdfId: first.id, pos: first.pos || { page: 1 } };
}

export function nextPaper() {
  const papers = pdfList().filter((p) => p.kind === 'paper' && !p.error);
  const doneIds = new Set([...S.papers.values()].filter((x) => x.status === 'done').map((x) => x.pdfId));
  return papers.find((p) => !doneIds.has(p.id)) || null;
}

function kindsFor(ph) {
  return ph === 'reading' ? ['reading'] : ph === 'questions' ? ['question'] : ph === 'papers' ? ['paper', 'question'] : null;
}

export function todayTask() {
  const t = today();
  if (!S.pdfs.size) return { type: 'empty' };
  const dt = dayType(t);
  const ap = activePaper();
  if (ap && S.pdfs.has(ap.pdfId)) return { type: 'paperRunning', dt, pdfId: ap.pdfId };
  if (kv('snooze') === t) return { type: 'rest', dt };
  const due = dueRedo(t);
  if (dt === 'away') return { type: 'quick5', dt, due: due.length };
  if (due.length) return { type: 'redo', dt, count: due.length, first: due[0] };
  const ph = phaseOn(t);
  const study = () => nextStudy(kindsFor(ph)) || nextStudy(null);
  if (dt === 'work' || dt === 'long' || dt === 'night') {
    if (S.cards.size) return { type: 'cards', dt, count: S.cards.size };
    const r = study();
    return r ? { type: 'read', dt, short: true, ...r } : { type: 'nothing', dt };
  }
  if (ph === 'papers') {
    const p = nextPaper();
    if (p) return { type: 'paper', dt, pdfId: p.id };
  }
  const r = study();
  return r ? { type: 'read', dt, ...r } : { type: 'nothing', dt };
}
