// Trigger → Target cards: quick form, review, and rapid-fire audio.
import { h, icon, toast, sheet, keepAwake, confirmSheet, plural, dockToasts } from '../util.js';
import { S, addCard, putCard, deleteCard, cardQueue, reviewCard, settings, setSettings, secLabel } from '../store.js';
import { nav } from '../app.js';

export function cardForm(card, link) {
  const trig = h('textarea', { class: 'ta', rows: 2, placeholder: 'Trigger (what you see)', value: card ? card.trigger : '' });
  const targ = h('textarea', { class: 'ta', rows: 3, placeholder: 'Target (what you should recall)', value: card ? card.target : '' });
  const src = link && link.sectionId && S.sections.get(link.sectionId);
  const pdf = link && S.pdfs.get(link.pdfId);
  const save = () => {
    const t = trig.value.trim(), g = targ.value.trim();
    if (!t || !g) { toast('Write both the trigger and the target.'); return; }
    if (card) { card.trigger = t; card.target = g; putCard(card); toast('Card updated'); }
    else { addCard({ trigger: t, target: g, ...(link || {}) }); toast('Card saved'); }
    close();
  };
  const close = sheet(card ? 'Edit card' : 'New card', [
    link && pdf ? h('p', { class: 'muted small' }, `From ${pdf.name}${src ? ' · ' + secLabel(src) : ''}${link.qNum ? ' · Q' + link.qNum : ''} · p.${link.page}`) : null,
    h('label', { class: 'lbl' }, 'Trigger'), trig,
    h('div', { class: 'arrow' }, '↓'),
    h('label', { class: 'lbl' }, 'Target'), targ,
    h('button', { class: 'btn big primary', onclick: save }, 'Save card'),
    card ? h('button', { class: 'btn big ghost danger-text', onclick: async () => {
      close();
      if (await confirmSheet('Delete this card?', card.trigger, 'Delete', true)) { deleteCard(card.id); toast('Card deleted'); nav(location.hash, true); }
    } }, 'Delete card') : null,
  ]);
  setTimeout(() => trig.focus(), 280);
}

// ---------- list screen ----------
export function renderCards(root) {
  const cards = cardQueue();
  const missed = cards.filter((c) => c.last === 'missed').length;
  root.replaceChildren(
    h('header', { class: 'top' }, h('h1', null, 'Cards'), h('span', { class: 'muted' }, plural(cards.length, 'card'))),
    h('div', { class: 'pad' },
      h('div', { class: 'row2' },
        h('button', { class: 'btn big primary', disabled: !cards.length, onclick: () => nav('#/cards/review') }, icon('cards'), 'Review'),
        h('button', { class: 'btn big', disabled: !cards.length, onclick: () => nav('#/cards/audio') }, icon('audio'), 'Audio')),
      missed ? h('p', { class: 'muted' }, `${missed} missed last time — they come first.`) : null,
      h('button', { class: 'btn big ghost', onclick: () => { cardForm(null, null); } }, icon('add'), 'New card'),
      cards.length ? h('div', { class: 'list' }, cards.map((c) =>
        h('button', { class: 'cardrow', onclick: () => cardForm(c) },
          h('span', { class: 'dot ' + (c.last || 'new') }),
          h('span', { class: 'cr-t' }, c.trigger),
          h('span', { class: 'cr-g' }, '→ ' + c.target))))
        : h('p', { class: 'empty' }, 'No cards yet. While studying, tap Card after a wrong answer to write one in seconds.'),
    ));
}

// ---------- review ----------
export function renderReview(root, { quick5 } = {}) {
  const queue = cardQueue();
  let i = 0, shown = false, knew = 0, missed = 0;
  const body = h('div', { class: 'rv-body' });
  const bar = h('div', { class: 'rv-bar' });
  const count = h('span', { class: 'muted' });
  const draw = () => {
    if (i >= queue.length) {
      body.replaceChildren(h('div', { class: 'rv-done' },
        h('p', { class: 'bignum' }, `${knew} / ${knew + missed}`),
        h('p', null, queue.length ? 'cards known this round' : 'No cards yet.'),
        missed ? h('p', { class: 'muted' }, `${missed} missed — they come first next time.`) : null));
      bar.replaceChildren(h('button', { class: 'btn big primary', onclick: () => nav(quick5 ? '#/today' : '#/cards') }, 'Done'));
      count.textContent = '';
      return;
    }
    const c = queue[i];
    count.textContent = `${i + 1} / ${queue.length}`;
    body.replaceChildren(h('div', { class: 'rv-card', onclick: () => { if (!shown) { shown = true; draw(); } } },
      h('div', { class: 'rv-trig' }, c.trigger),
      shown ? h('div', { class: 'rv-targ' }, c.target) : h('div', { class: 'rv-hint' }, 'Tap to reveal')));
    bar.replaceChildren(...(shown
      ? [h('button', { class: 'btn big bad', onclick: () => { reviewCard(c, false); missed++; i++; shown = false; draw(); } }, icon('cross'), 'Missed it'),
        h('button', { class: 'btn big good', onclick: () => { reviewCard(c, true); knew++; i++; shown = false; draw(); } }, icon('tick'), 'Knew it')]
      : [h('button', { class: 'btn big primary wide', onclick: () => { shown = true; draw(); } }, 'Reveal')]));
  };
  root.replaceChildren(h('div', { class: 'review' },
    h('header', { class: 'st-head' },
      h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => nav(quick5 ? '#/today' : '#/cards') }, icon('back')),
      h('div', { class: 'st-titles' }, h('div', { class: 'st-title' }, quick5 ? 'Quick 5 · Cards' : 'Cards'), count),
      quick5 ? quick5Chip() : null),
    body, bar));
  dockToasts(bar);
  draw();
}

// Quick 5 countdown chip (shared start time kept in sessionStorage).
export function quick5Chip() {
  const chip = h('span', { class: 'chip timer' });
  let start = 0;
  try { start = +sessionStorage.getItem('q5start') || 0; } catch { /* private mode */ }
  if (!start) start = Date.now();
  const upd = () => {
    if (!chip.isConnected) { clearInterval(t); return; }
    const left = 300 - (Date.now() - start) / 1000;
    chip.textContent = left > 0 ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}` : "Time's up";
    chip.classList.toggle('over', left <= 0);
    if (left <= 0 && !chip.dataset.done) {
      chip.dataset.done = '1';
      toast("Quick 5 is up. Keep going or stop.", { label: 'Stop', fn: () => nav('#/today') }, 8000);
    }
  };
  const t = setInterval(upd, 1000);
  setTimeout(upd, 0);
  return chip;
}

// ---------- rapid-fire audio ----------
export function renderAudio(root) {
  const queue = cardQueue();
  const synth = window.speechSynthesis;
  let i = 0, playing = false, timer = null, phase = 'idle';
  const st = settings();
  let rate = st.rate, pause = st.pause;
  const trigEl = h('div', { class: 'rv-trig' });
  const targEl = h('div', { class: 'rv-targ' });
  const count = h('span', { class: 'muted' });
  const playBtn = h('button', { class: 'btn big primary', onclick: () => (playing ? stop() : play()) });
  const rateVal = h('b', { class: 'stepval' });
  const pauseVal = h('b', { class: 'stepval' });

  const showSettings = () => {
    rateVal.textContent = `Speed ${rate.toFixed(1)}×`;
    pauseVal.textContent = `Pause ${pause}s`;
  };

  const say = (text) => new Promise((resolve) => {
    if (!synth) { setTimeout(resolve, 1500); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate;
    let done = false;
    const fin = () => { if (!done) { done = true; clearTimeout(guard); resolve(); } };
    u.onend = fin;
    u.onerror = fin;
    // Some phones never fire onend; move on after a generous estimate.
    const guard = setTimeout(fin, 2500 + (text.length * 120) / rate);
    synth.speak(u);
  });
  const wait = (s) => new Promise((r) => { timer = setTimeout(r, s * 1000); });

  const draw = (reveal) => {
    const c = queue[i];
    count.textContent = queue.length ? `${Math.min(i + 1, queue.length)} / ${queue.length}` : '';
    trigEl.textContent = c ? c.trigger : 'No cards yet.';
    targEl.textContent = c && reveal ? c.target : '';
    playBtn.replaceChildren(icon(playing ? 'pause' : 'start'), playing ? 'Pause' : (i ? 'Resume' : 'Play'));
  };

  const loop = async () => {
    while (playing && i < queue.length) {
      const my = i;
      draw(false);
      phase = 'trigger';
      await say(queue[my].trigger);
      if (!playing || my !== i) continue;
      await wait(pause);
      if (!playing || my !== i) continue;
      draw(true);
      await say(queue[my].target);
      if (!playing || my !== i) continue;
      await wait(1.2);
      if (!playing || my !== i) continue;
      i++;
    }
    if (i >= queue.length) { stop(); i = 0; trigEl.textContent = 'All cards read.'; targEl.textContent = ''; }
  };
  const play = () => {
    if (!queue.length) return;
    if (!synth) toast('This browser has no built-in voice.');
    playing = true;
    keepAwake(true);
    draw(false);
    loop();
  };
  const stop = () => {
    playing = false;
    clearTimeout(timer);
    if (synth) synth.cancel();
    keepAwake(false);
    draw(phase === 'trigger');
  };
  const skip = () => {
    if (synth) synth.cancel();
    clearTimeout(timer);
    i = Math.min(i + 1, queue.length - 1);
    if (playing) { const keep = playing; playing = false; setTimeout(() => { playing = keep; loop(); }, 120); }
    else draw(false);
  };
  const leave = () => { stop(); nav('#/cards'); };

  root.replaceChildren(h('div', { class: 'review audio' },
    h('header', { class: 'st-head' },
      h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: leave }, icon('back')),
      h('div', { class: 'st-titles' }, h('div', { class: 'st-title' }, 'Audio cards'), count)),
    h('div', { class: 'rv-body' }, h('div', { class: 'rv-card' }, trigEl, targEl)),
    h('div', { class: 'audio-set' },
      h('div', { class: 'stepper' },
        h('button', { class: 'btn', onclick: () => { rate = Math.max(0.6, +(rate - 0.1).toFixed(1)); setSettings({ rate }); showSettings(); } }, '−'),
        rateVal,
        h('button', { class: 'btn', onclick: () => { rate = Math.min(2, +(rate + 0.1).toFixed(1)); setSettings({ rate }); showSettings(); } }, '+')),
      h('div', { class: 'stepper' },
        h('button', { class: 'btn', onclick: () => { pause = Math.max(1, pause - 1); setSettings({ pause }); showSettings(); } }, '−'),
        pauseVal,
        h('button', { class: 'btn', onclick: () => { pause = Math.min(15, pause + 1); setSettings({ pause }); showSettings(); } }, '+'))),
    h('div', { class: 'rv-bar' }, playBtn, h('button', { class: 'btn big', onclick: skip }, icon('next'), 'Next'))));
  dockToasts(root.querySelector('.rv-bar'));
  showSettings();
  draw(false);
  return () => stop();
}
