// Today: one task, one Start button.
import { h, icon, toast, today, niceDate, plural, fmtDur } from '../util.js';
import { S, kv, setKv, dueRedo, cardQueue, secLabel, postponeDue, activePaper, paperElapsed, settings, KIND_LABEL } from '../store.js';
import { todayTask, daysLeft, phaseOn, PHASE_LABEL } from '../plan.js';
import { DAY_LABEL, rotaNotices } from '../rota.js';
import { nav, openRead, startQuick5, banners } from '../app.js';
import { addPdfs } from './library.js';

export function renderToday(root) {
  const task = todayTask();
  const left = daysLeft();
  const ph = phaseOn();
  const t = today();
  const due = dueRedo(t).length;
  const later = S.redo.size - due;

  const card = taskCard(task, root);
  root.replaceChildren(
    h('header', { class: 'top' },
      h('div', null, h('h1', null, 'Today'), h('div', { class: 'muted' }, niceDate(t))),
      left != null && left >= 0 ? h('div', { class: 'daysleft' }, h('b', null, String(left)), h('small', null, left === 1 ? 'day left' : 'days left')) : null),
    h('div', { class: 'pad' },
      h('div', { class: 'chips' },
        task.dt ? h('span', { class: 'chip day-' + task.dt }, DAY_LABEL[task.dt]) : null,
        ph && ph !== 'after' ? h('span', { class: 'chip' }, PHASE_LABEL[ph]) : null),
      banners(),
      rotaNotices(() => renderToday(root)),
      card,
      task.type !== 'empty' ? h('div', { class: 'row2' },
        h('button', { class: 'btn big', onclick: startQuick5 }, icon('bolt'), 'Quick 5'),
        task.type !== 'rest' && task.type !== 'nothing' ? h('button', { class: 'btn big ghost', onclick: () => notToday(root) }, 'Not today') : null) : null,
      task.type !== 'empty' ? h('p', { class: 'muted center small' },
        `Redo list: ${due} due${later > 0 ? ` · ${later} later` : ''} · ${plural(S.cards.size, 'card')}`) : null));
}

function taskCard(task, root) {
  const pdf = task.pdfId && S.pdfs.get(task.pdfId);
  let title, detail, start, startLabel = 'Start';
  switch (task.type) {
    case 'empty':
      title = 'Add your PDFs';
      detail = 'Pick your question books, past papers and reading from the Files app. You can choose many at once.';
      startLabel = 'Add PDFs';
      start = () => addPdfs().then(() => nav('#/library'));
      break;
    case 'paperRunning': {
      const p = activePaper();
      const leftS = p.limitSec - paperElapsed(p);
      title = 'Timed paper running';
      detail = `${pdf.name} · ${leftS >= 0 ? fmtDur(leftS) + ' left' : fmtDur(-leftS) + ' over'}`;
      startLabel = 'Continue';
      start = () => openRead(task.pdfId);
      break;
    }
    case 'rest':
      title = 'Not today';
      detail = 'Your task moved to tomorrow. Quick 5 is still here if a gap turns up.';
      startLabel = 'Show my task anyway';
      start = () => { setKv('snooze', null); renderToday(root); };
      break;
    case 'quick5':
      title = 'Quick 5';
      detail = `Day away: just a few redo items and cards${task.due ? ` (${task.due} redo due)` : ''}.`;
      start = startQuick5;
      break;
    case 'redo': {
      const sec = S.sections.get(task.first.sectionId);
      title = `Redo ${plural(task.count, 'question')}`;
      detail = `First: Q${task.first.qNum}${sec ? ' · ' + secLabel(sec) : ''}. Each opens with its answer.`;
      start = () => nav('#/redo');
      break;
    }
    case 'cards':
      title = 'Card round';
      detail = `${plural(task.count, 'card')}, missed ones first. Short day, short task.`;
      start = () => nav('#/cards/review');
      break;
    case 'paper':
      title = 'Timed past paper';
      detail = `${pdf.name}. Pick 1, 2 or 3 hours and go.`;
      start = () => openRead(task.pdfId, { timed: true });
      break;
    case 'read': {
      const sec = task.sec;
      title = task.short ? 'A short read' : sec ? (sec.done ? 'Next section' : 'Continue') : 'Continue reading';
      detail = `${pdf.name}${sec ? ' · ' + secLabel(sec) : ''} · p.${(task.pos && task.pos.page) || 1}`;
      if (pdf.kind) detail = KIND_LABEL[pdf.kind] + ': ' + detail;
      start = () => openRead(task.pdfId, task.pos || {});
      break;
    }
    default:
      title = 'All caught up';
      detail = 'Nothing due. Add PDFs or sections to keep going.';
      startLabel = 'Open library';
      start = () => nav('#/library');
  }
  return h('section', { class: 'task' },
    h('h2', null, title),
    h('p', null, detail),
    h('button', { class: 'btn huge primary', onclick: start }, icon('start'), startLabel));
}

function notToday(root) {
  const t = today();
  const moved = [...S.redo.values()].filter((r) => r.due <= t).map((r) => [r, r.due]);
  postponeDue();
  setKv('snooze', t);
  renderToday(root);
  toast('Moved to tomorrow.', {
    label: 'Undo',
    fn: () => {
      for (const [r, d] of moved) { r.due = d; }
      import('../store.js').then(({ save }) => moved.forEach(([r]) => save('redo', r)));
      setKv('snooze', null);
      renderToday(root);
    },
  });
}

export { cardQueue, settings, kv };
