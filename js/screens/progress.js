// Progress: scores by topic and section (weakest first), this week, days left, papers.
import { h, pct, plural, weekStart, fmtHM, niceDate, dstr } from '../util.js';
import { S, secLabel, dueRedo, settings } from '../store.js';
import { daysLeft } from '../plan.js';

function tally(marks) {
  const c = { right: 0, wrong: 0, unsure: 0, total: 0 };
  for (const m of marks) { c[m.m]++; c.total++; }
  // "?" means right but unsure, so it counts as right in the score.
  c.score = c.total ? (c.right + c.unsure) / c.total : 0;
  return c;
}

function bar(title, c, sub) {
  const w = (n) => `${(100 * n) / (c.total || 1)}%`;
  return h('div', { class: 'bar' },
    h('b', null, title),
    h('span', { class: 'num' }, `${pct(c.right + c.unsure, c.total)}%`),
    h('div', { class: 'meter', role: 'img', 'aria-label': `${c.right} right, ${c.unsure} unsure, ${c.wrong} wrong` },
      h('i', { class: 'g', style: { width: w(c.right) } }),
      h('i', { class: 'u', style: { width: w(c.unsure) } }),
      h('i', { class: 'b', style: { width: w(c.wrong) } })),
    h('small', null, `${c.right} ✓ · ${c.wrong} ✗ · ${c.unsure} ? ${sub ? ' · ' + sub : ''}`));
}

const weakestFirst = (a, b) => a.c.score - b.c.score || b.c.total - a.c.total;

export function renderProgress(root) {
  const marks = [...S.marks.values()].filter((m) => S.sections.has(m.sectionId));
  const bySection = new Map();
  for (const m of marks) {
    if (!bySection.has(m.sectionId)) bySection.set(m.sectionId, []);
    bySection.get(m.sectionId).push(m);
  }
  const sections = [...bySection.entries()].map(([id, ms]) => ({ sec: S.sections.get(id), c: tally(ms) })).sort(weakestFirst);

  const byTopic = new Map();
  for (const { sec } of sections) {
    const key = sec.topic || '';
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key).push(...bySection.get(sec.id));
  }
  const topics = [...byTopic.entries()].filter(([k]) => k).map(([k, ms]) => ({ topic: k, c: tally(ms) })).sort(weakestFirst);
  const untagged = byTopic.get('');
  // Topics on the list that have no scores yet.
  const unscored = settings().topics.filter((tp) => !byTopic.has(tp));

  const since = weekStart().getTime();
  const week = S.log.filter((l) => l.at >= since && (l.t === 'q' || l.t === 'redo')).length;
  const left = daysLeft();
  const papers = [...S.papers.values()].filter((p) => p.status === 'done').sort((a, b) => b.endedAt - a.endedAt);
  const due = dueRedo().length;
  const sectionsAll = [...S.sections.values()];
  const doneSecs = sectionsAll.filter((s) => s.done).length;

  root.replaceChildren(
    h('header', { class: 'top' }, h('h1', null, 'Progress')),
    h('div', { class: 'pad' },
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', null, left == null ? '—' : String(Math.max(0, left))), h('small', null, left == null ? 'set exam date' : 'days left')),
        h('div', { class: 'stat' }, h('b', null, String(week)), h('small', null, 'questions this week')),
        h('div', { class: 'stat' }, h('b', null, String(S.redo.size)), h('small', null, `redo (${due} due)`))),
      h('p', { class: 'muted small center' }, `${doneSecs} of ${plural(sectionsAll.length, 'section')} done · ${plural(S.cards.size, 'card')}`),

      h('section', { class: 'card' },
        h('h2', null, 'By topic, weakest first'),
        topics.length ? topics.map((x) => bar(x.topic, x.c, plural(x.c.total, 'question'))) : h('p', { class: 'muted small' }, 'Tag sections with a topic to see scores here.'),
        untagged ? bar('No topic', tally(untagged), plural(untagged.length, 'question')) : null,
        unscored.length ? h('p', { class: 'muted small' }, 'Not started: ' + unscored.join(', ')) : null),

      h('section', { class: 'card' },
        h('h2', null, 'By section, weakest first'),
        sections.length ? sections.map(({ sec, c }) => bar(`${(S.pdfs.get(sec.pdfId) || {}).name || ''} · ${secLabel(sec)}`, c, sec.topic || ''))
          : h('p', { class: 'muted small' }, 'Tick, cross or ? questions while studying to see scores here.')),

      h('section', { class: 'card' },
        h('h2', null, 'Timed past papers'),
        papers.length ? papers.map((p) => h('div', { class: 'bar' },
          h('b', null, (S.pdfs.get(p.pdfId) || { name: 'Removed PDF' }).name),
          h('span', { class: 'num' }, `${pct(p.right + p.unsure, p.total)}%`),
          h('small', null, `${p.right + p.unsure} / ${p.total} · ${fmtHM(p.takenSec)} of ${fmtHM(p.limitSec)} · ${niceDate(dstr(new Date(p.endedAt)))}`)))
          : h('p', { class: 'muted small' }, 'Start a timed paper from a past paper’s More menu, or from Today in the past papers phase.'))));
}
