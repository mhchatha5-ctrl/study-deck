// Settings: exam date and plan, topics, rota, display, data and install.
import { h, icon, toast, today, niceDate, addDays, isIOS } from '../util.js';
import { kv, settings, setSettings } from '../store.js';
import { proposePlan, phaseOn, PHASE_LABEL } from '../plan.js';
import { rotaSettings } from '../rota.js';
import { applyTheme, canInstall, promptInstall, isStandalone, requestPersist, nav } from '../app.js';
import { dataSettings, exportBackup } from '../backup.js';

export { exportBackup };

export function renderSettings(root) {
  const draw = () => {
    root.replaceChildren(
      h('header', { class: 'top' }, h('h1', null, 'Settings')),
      h('div', { class: 'pad' },
        h('p', { class: 'muted small' }, 'Everything here is optional. Reading works without any of it.'),
        examCard(draw),
        topicsCard(),
        rotaSettings(draw),
        displayCard(draw),
        dataSettings(draw),
        installCard(draw),
        helpCard(),
        aboutCard()));
  };
  draw();
}

function examCard(redraw) {
  const s = settings();
  const date = (value, onchange, min) => h('input', { class: 'inp', type: 'date', value: value || '', min: min || '', onchange });
  const ph = phaseOn();
  const kids = [
    h('h2', null, 'Exam and plan'),
    h('label', { class: 'field' }, h('span', null, 'Exam date'),
      date(s.examDate, (e) => {
        const examDate = e.target.value || null;
        const patch = { examDate };
        if (examDate && (!s.readEnd || !s.qEnd || s.qEnd > examDate)) Object.assign(patch, proposePlan(examDate));
        setSettings(patch);
        if (examDate) toast('Plan dates proposed. Adjust them if you like.');
        redraw();
      }, today())),
  ];
  if (s.examDate) {
    kids.push(
      h('p', { class: 'muted small' }, 'Phases run in order: Reading, then Question books, then Past papers up to the exam.'),
      h('label', { class: 'field' }, h('span', null, 'Reading until'),
        date(s.readEnd, (e) => { setSettings({ readEnd: e.target.value || null }); redraw(); })),
      h('label', { class: 'field' }, h('span', null, 'Question books until'),
        date(s.qEnd, (e) => { setSettings({ qEnd: e.target.value || null }); redraw(); }, s.readEnd)),
      h('div', { class: 'status' }, `Past papers from ${s.qEnd ? niceDate(addDays(s.qEnd, 1)) : '…'} to ${niceDate(s.examDate)}.`),
      ph ? h('div', { class: 'status ok' }, 'Today: ' + PHASE_LABEL[ph]) : null,
      s.readEnd && s.qEnd && s.readEnd > s.qEnd ? h('div', { class: 'status bad' }, 'Reading should end before question books end.') : null,
      h('button', { class: 'btn', onclick: () => { setSettings(proposePlan(s.examDate)); toast('Dates proposed from today.'); redraw(); } }, 'Propose dates again'));
  }
  return h('section', { class: 'card' }, kids);
}

function topicsCard() {
  const s = settings();
  const ta = h('textarea', { class: 'ta', rows: 5, placeholder: 'Paste your topics, one per line', value: s.topics.join('\n') });
  const count = h('span', { class: 'muted small' }, s.topics.length ? `${s.topics.length} topics` : '');
  return h('section', { class: 'card' },
    h('h2', null, 'Topics'),
    h('p', { class: 'muted small' }, 'Paste once. Then tag a section with one tap while studying (optional).'),
    ta,
    h('button', { class: 'btn primary', onclick: () => {
      const topics = [...new Set(ta.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))];
      setSettings({ topics });
      count.textContent = `${topics.length} topics`;
      toast(`${topics.length} topics saved`);
    } }, 'Save topics'),
    count);
}

function displayCard(redraw) {
  const s = settings();
  const seg = (val, label) => h('button', { class: 'chip big' + (s.theme === val ? ' on' : ''), onclick: () => { setSettings({ theme: val }); applyTheme(); redraw(); } }, label);
  return h('section', { class: 'card' },
    h('h2', null, 'Display'),
    h('div', { class: 'chips' }, seg('auto', 'Auto'), seg('light', 'Light'), seg('dark', 'Dark')),
    h('label', { class: 'checkrow' },
      h('input', { type: 'checkbox', checked: s.invert, onchange: (e) => setSettings({ invert: e.target.checked }) }),
      h('span', null, 'Invert page colours (white text on black, for night shifts)')));
}

function installCard(redraw) {
  const kids = [h('h2', null, 'Install on your phone')];
  if (isStandalone()) kids.push(h('div', { class: 'status ok' }, 'Installed. It opens from your Home Screen and works offline.'));
  else if (canInstall()) kids.push(h('button', { class: 'btn big primary', onclick: () => promptInstall().then(redraw) }, icon('add'), 'Install app'));
  kids.push(h('details', { class: 'help' }, h('summary', null, 'How to install by hand'),
    h('p', null, h('b', null, 'Android (Chrome): '), 'tap ⋮ (top right) › Add to Home screen › Install.'),
    h('p', null, h('b', null, 'iPhone (Safari): '), 'tap Share › Add to Home Screen › Add. On iPhone, add your PDFs after installing: the Home Screen app keeps its own storage.')));
  return h('section', { class: 'card' }, kids);
}

function helpCard() {
  const tips = [
    ['Start', 'Today shows one task. Start opens the PDF exactly where you stopped.'],
    ['Sections', 'On the first question page tap “Questions start here”, then scroll to the first answer page (or open another PDF) and tap “Answers start here”, or “Same page”. A section runs until the next one starts.'],
    ['Studying', 'Answers flips between questions and answers; each side keeps its place. Cover hides answers on the same page: drag its edge, Turn it to come from the side, Reveal to lift it.'],
    ['Scoring', '✓ right, ✗ wrong, ? right but unsure. Numbers count up by themselves; − and + fix them. ✗ and ? go to the redo list: back in 3 days, then 10 days, then cleared.'],
    ['Cards', 'Tap Card while studying to turn a wrong answer into a Trigger → Target card.'],
    ['Zoom', 'Pinch with two fingers, or double-tap. Double-tap again to fit the page.'],
  ];
  return h('section', { class: 'card' },
    h('h2', null, 'How it works'),
    tips.map(([k, v]) => h('details', { class: 'help' }, h('summary', null, k), h('p', { class: 'small' }, v))));
}

function aboutCard() {
  return h('section', { class: 'card' },
    h('h2', null, 'Privacy'),
    h('p', { class: 'small' }, 'Everything stays on this phone in the browser’s own storage: your PDFs, sections, scores, cards and rota. No account, no server, no analytics. The rota link is read directly by your phone and never sent anywhere else.'),
    h('p', { class: 'muted small' }, 'Pages are shown with PDF.js (Mozilla, Apache-2.0 licence).'));
}

export { kv, requestPersist, nav, isIOS };
