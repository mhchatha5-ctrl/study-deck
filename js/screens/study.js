// The study view: a PDF with question and answer "sides", section marking,
// the cover, the tick / cross / ? bar, redo mode and the past paper timer.
import { h, icon, toast, sheet, closeSheets, keepAwake, dockToasts, vibrate, clamp, fmtDur, plural, confirmSheet } from '../util.js';
import { PdfViewer } from '../viewer.js';
import {
  S, kv, setKv, settings, setSettings, putPdf, pdfList, sectionsOf, sectionAt, answersAt, hasAnswers, secLabel,
  createSection, putSection, deleteSection, qEnd, aEnd, markQuestion, reviewRedo, savePos, flushPos, activePaper,
  startPaper, stopPaperClock, finishPaper, cancelPaper, paperElapsed, paperCounts, KIND_LABEL, dueRedo,
} from '../store.js';
import { cardForm } from './cards.js';
import { nav, goBack } from '../app.js';

let current = null; // active study controller

export function leaveStudy() {
  if (current) { current.destroy(); current = null; }
}

// opts: { pdfId, page, frac, zoom, mode: 'read'|'redo', queue, quick5, sectionId }
export function openStudy(root, opts) {
  leaveStudy();
  current = new Study(root, opts);
  return current;
}

class Study {
  constructor(root, opts) {
    this.opts = opts;
    this.mode = opts.mode || 'read';
    this.side = 'q';
    this.pending = null;       // section waiting for its answer page
    this.dismissed = new Set();// sections whose "answers?" / "topic?" prompts were dismissed
    this.otherPdf = null;      // answers-in-another-PDF picking: { backPdf, backPos }
    this.coverOn = false;
    this.coverShown = false;
    this.root = root;
    this.build();
    keepAwake(true).then((ok) => { if (!ok && !kv('wakeWarned')) { setKv('wakeWarned', true); toast('This browser cannot keep the screen awake.'); } });
    this.timerInt = setInterval(() => this.tick(), 1000);
    this.onVis = () => { if (document.visibilityState === 'hidden') this.persist(); };
    document.addEventListener('visibilitychange', this.onVis);
    if (this.mode === 'redo') this.startRedo();
    else {
      this.openPdf(opts.pdfId, { page: opts.page, frac: opts.frac, zoom: opts.zoom })
        .then(() => { if (opts.timed && !activePaper()) this.timedSheet(); });
    }
  }

  destroy() {
    this.persist();
    clearInterval(this.timerInt);
    document.removeEventListener('visibilitychange', this.onVis);
    this.qv.destroy();
    this.av.destroy();
    keepAwake(false);
    closeSheets();
  }

  // ---------- layout ----------
  build() {
    const st = settings();
    this.title = h('div', { class: 'st-title' });
    this.sub = h('div', { class: 'st-sub' });
    this.timerChip = h('button', { class: 'chip timer', hidden: true, onclick: () => this.paperSheet() });
    this.pageChip = h('button', { class: 'chip', onclick: () => this.moreSheet() });
    this.head = h('header', { class: 'st-head' },
      h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => this.close() }, icon('back')),
      h('div', { class: 'st-titles' }, this.title, this.sub),
      this.timerChip, this.pageChip);

    this.view = h('div', { class: 'st-view' + (st.invert ? ' invert' : '') });
    this.qv = new PdfViewer(this.view, { onChange: (e) => this.onViewer('q', e) });
    this.av = new PdfViewer(this.view, { onChange: (e) => this.onViewer('a', e) });
    this.av.el.classList.add('hidden-side');
    this.av.setActive(false);
    this.sideBadge = h('div', { class: 'side-badge' });
    this.cover = this.buildCover();
    this.view.append(this.sideBadge, this.cover);

    this.strip = h('div', { class: 'st-strip' });
    this.marks = h('div', { class: 'st-marks' });
    this.tools = h('div', { class: 'st-tools' });
    this.bottom = h('div', { class: 'st-bottom' }, this.strip, this.marks, this.tools);
    this.el = h('div', { class: 'study' }, this.head, this.view, this.bottom);
    this.root.replaceChildren(this.el);
    dockToasts(this.bottom);
  }

  get v() { return this.side === 'q' ? this.qv : this.av; }

  async openPdf(pdfId, pos) {
    const meta = S.pdfs.get(pdfId);
    if (!meta) { toast('That PDF is no longer in your library.'); return this.close(); }
    this.pdfId = pdfId;
    this.setSide('q', true);
    const p = pos && pos.page ? pos : (meta.pos || { page: 1 });
    try { await this.qv.open(pdfId, p); } catch { /* message shown in viewer */ }
    this.refresh();
    this.maybeOfferChapters();
  }

  // ---------- state helpers ----------
  qPage() { return this.qv.currentPage(); }
  curSection() {
    if (this.mode === 'redo') return this.item ? S.sections.get(this.item.sectionId) : null;
    if (this.otherPdf || !this.pdfId) return null;
    return sectionAt(this.pdfId, this.qPage());
  }
  kind() { const p = S.pdfs.get(this.pdfId); return p ? p.kind : null; }
  isReading() { return this.kind() === 'reading'; }

  onViewer(side, e) {
    if (side !== this.side) return;
    if (side === 'q' && !this.otherPdf && this.mode === 'read' && this.pdfId) {
      savePos(this.pdfId, this.qv.getPos());
      const sec = this.curSection();
      if (sec && sec.lastPage !== e.cur) { sec.lastPage = e.cur; this.dirtySec = sec; }
    }
    if (side === 'a' && this.ansFor) {
      const sec = S.sections.get(this.ansFor);
      if (sec) { sec.aLast = { page: e.cur, pos: this.av.getPos() }; this.dirtySec = sec; }
    }
    if (e.changed) this.refresh();
    else this.updateChips();
  }

  persist() {
    if (this.dirtySec) { putSection(this.dirtySec); this.dirtySec = null; }
    flushPos();
  }

  // ---------- sides ----------
  setSide(side, silent) {
    this.side = side;
    const q = side === 'q';
    this.qv.el.classList.toggle('hidden-side', !q);
    this.av.el.classList.toggle('hidden-side', q);
    this.qv.setActive(q);
    this.av.setActive(!q);
    if (!silent) { this.restoreCover(); this.refresh(); }
  }

  async flip() {
    const sec = this.curSection();
    if (this.side === 'a') { this.setSide('q'); return; }
    if (!sec || !hasAnswers(sec)) { toast('Set where the answers start first.'); return; }
    if (sec.same) { this.toggleCover(); return; }
    this.persist();
    if (this.ansFor !== sec.id || this.av.pdfId !== sec.aPdf) {
      this.ansFor = sec.id;
      const pos = this.mode === 'redo' && this.item
        ? { page: this.item.aPage || sec.aPage }
        : (sec.aLast && sec.aLast.pos) || { page: sec.aPage };
      this.setSide('a', true);
      try { await this.av.open(sec.aPdf, pos); } catch { /* shown in viewer */ }
      this.restoreCover();
      this.refresh();
    } else {
      this.setSide('a');
    }
  }

  answerCtx(sec) {
    if (sec.same) return { qPage: this.qPage(), aPdf: sec.pdfId, aPage: this.qPage() };
    let aPage = sec.aPage;
    if (this.ansFor === sec.id && this.av.pdfId === sec.aPdf) aPage = this.av.currentPage();
    else if (sec.aLast) aPage = sec.aLast.page;
    return { qPage: this.qPage(), aPdf: sec.aPdf, aPage };
  }

  // ---------- rendering of bars ----------
  refresh() {
    this.updateChips();
    this.renderStrip();
    this.renderMarks();
    this.renderTools();
  }

  updateChips() {
    const pdf = S.pdfs.get(this.side === 'a' ? this.av.pdfId : (this.otherPdf ? this.qv.pdfId : this.pdfId));
    const v = this.v;
    this.pageChip.textContent = `p.${v.currentPage()}${pdf && pdf.pages ? ' / ' + pdf.pages : ''}`;
    const sec = this.curSection();
    if (this.mode === 'redo') {
      this.title.textContent = `Redo ${this.qi + 1} of ${this.queue.length}` + (this.opts.quick5 ? ' · Quick 5' : '');
      this.sub.textContent = this.item ? `Q${this.item.qNum} · ${secLabel(sec)}` : '';
    } else {
      this.title.textContent = pdf ? pdf.name : '';
      this.sub.textContent = this.otherPdf ? 'Pick the first answer page'
        : sec ? secLabel(sec) + (sec.topic ? ' · ' + sec.topic : '') + (sec.done ? ' · done' : '')
          : (pdf && pdf.kind ? KIND_LABEL[pdf.kind] : 'Choose a type below');
    }
    this.sideBadge.textContent = this.side === 'a' ? 'ANSWERS' : (sec && hasAnswers(sec) && !sec.same && !this.isReading() ? 'QUESTIONS' : '');
    this.sideBadge.hidden = !this.sideBadge.textContent;
    this.sideBadge.classList.toggle('ans', this.side === 'a');
    this.tick();
  }

  renderStrip() {
    const s = this.strip;
    s.replaceChildren();
    s.hidden = true;
    const show = (...kids) => { s.append(...kids); s.hidden = false; };
    if (this.mode === 'redo') return;
    const pdf = S.pdfs.get(this.pdfId);
    if (!pdf) return;

    if (this.otherPdf) {
      return show(
        h('div', { class: 'strip-msg' }, 'Scroll to the first answer page, then tap:'),
        h('div', { class: 'strip-row' },
          h('button', { class: 'btn primary', onclick: () => this.setAnswersHere() }, 'Answers start here'),
          h('button', { class: 'btn ghost', onclick: () => this.cancelOther() }, 'Cancel')));
    }
    if (!pdf.kind) {
      return show(
        h('div', { class: 'strip-msg' }, 'What is this PDF?'),
        h('div', { class: 'strip-row' }, ['question', 'paper', 'reading'].map((k) =>
          h('button', { class: 'btn', onclick: () => { pdf.kind = k; putPdf(pdf); this.refresh(); this.maybeOfferChapters(); } }, KIND_LABEL[k]))));
    }
    if (this.side === 'a') return;
    const page = this.qPage();
    const sec = this.curSection();

    // Offer built-in bookmarks as ready-made sections.
    if (this.chapterOffer) {
      return show(
        h('div', { class: 'strip-msg' }, `This PDF has ${plural(pdf.outline.length, 'chapter')} in its bookmarks. Use them as sections?`),
        h('div', { class: 'strip-row' },
          h('button', { class: 'btn primary', onclick: () => this.chaptersSheet() }, 'Use chapters'),
          h('button', { class: 'btn ghost', onclick: () => { this.chapterOffer = false; pdf.outlineAsked = true; putPdf(pdf); this.refresh(); } }, 'No thanks')));
    }

    if (!this.isReading()) {
      // Waiting for the answers of a section.
      if (!this.pending && sec && !hasAnswers(sec) && !this.dismissed.has(sec.id)) this.pending = sec.id;
      const pend = this.pending && S.sections.get(this.pending);
      if (pend && !hasAnswers(pend)) {
        const onStart = page === pend.start;
        return show(
          h('div', { class: 'strip-msg' },
            onStart ? `Answers for ${secLabel(pend)}: scroll to the first answer page, or:` : `Is this the first answer page for ${secLabel(pend)}?`),
          h('div', { class: 'strip-row' },
            h('button', { class: 'btn primary', disabled: onStart && pdf.pages > 1, onclick: () => this.setAnswersHere() }, 'Answers start here'),
            h('button', { class: 'btn', onclick: () => this.setSamePage() }, 'Same page'),
            h('button', { class: 'btn', onclick: () => this.pickOtherPdf() }, 'Other PDF'),
            h('button', { class: 'iconbtn', 'aria-label': 'Later', onclick: () => { this.dismissed.add(pend.id); this.pending = null; this.refresh(); } }, icon('close'))));
      }
      this.pending = null;

      // Not inside any section (or inside one already done): start a new one here.
      const inAns = answersAt(this.pdfId, page);
      if (!sec || (sec.done && page !== sec.start)) {
        return show(
          h('div', { class: 'strip-msg' }, inAns ? `Answer pages for ${secLabel(inAns)}.` : sec ? `${secLabel(sec)} is done.` : 'Not in a section yet.'),
          h('div', { class: 'strip-row' },
            h('button', { class: 'btn primary', onclick: () => this.newSectionHere() }, 'Questions start here')));
      }
    }

    // Optional topic, one tap.
    const topics = settings().topics;
    if (sec && !sec.done && !sec.topic && !sec.topicAsked && topics.length) {
      return show(
        h('div', { class: 'strip-msg' }, 'Topic for this section? (optional)'),
        h('div', { class: 'strip-row scroll' },
          topics.map((t) => h('button', { class: 'chip big', onclick: () => { sec.topic = t; sec.topicAsked = true; putSection(sec); this.refresh(); } }, t)),
          h('button', { class: 'chip big ghost', onclick: () => { sec.topicAsked = true; putSection(sec); this.refresh(); } }, 'Skip')));
    }
  }

  renderMarks() {
    const m = this.marks;
    m.replaceChildren();
    const sec = this.curSection();
    const redo = this.mode === 'redo';
    const can = redo ? !!this.item : (!this.otherPdf && sec && hasAnswers(sec) && !this.isReading());
    m.hidden = !can;
    if (!can) return;
    const markBtn = (kind, ic, label) => h('button', { class: 'mark ' + kind, 'aria-label': label, onclick: () => this.mark(kind) }, icon(ic));
    if (redo) {
      m.append(h('div', { class: 'qnum fixed' }, h('small', null, 'Redo'), 'Q' + this.item.qNum));
    } else {
      const firstMarked = [...S.marks.values()].some((x) => x.sectionId === sec.id);
      m.append(
        h('button', { class: 'step', 'aria-label': 'Previous number', onclick: () => this.bump(-1) }, icon('minus')),
        h('button', { class: 'qnum', onclick: () => this.numberSheet() }, h('small', null, firstMarked ? 'Next' : 'Start'), 'Q' + sec.nextQ),
        h('button', { class: 'step', 'aria-label': 'Next number', onclick: () => this.bump(1) }, icon('plus')));
    }
    m.append(markBtn('right', 'tick', 'Right'), markBtn('wrong', 'cross', 'Wrong'), markBtn('unsure', 'q', 'Right but unsure'));
  }

  renderTools() {
    const sec = this.curSection();
    const tool = (ic, label, fn, extra = {}) =>
      h('button', { class: 'tool' + (extra.on ? ' on' : '') + (extra.wide ? ' wide' : ''), disabled: !!extra.disabled, onclick: fn }, icon(ic), h('span', null, label));
    const same = sec && sec.same;
    const cover = tool('cover', 'Cover', () => this.toggleCover(), { on: this.coverOn });
    let items;
    if (this.mode === 'redo') {
      items = [
        same ? null : tool('flip', this.side === 'q' ? 'Answer' : 'Question', () => this.flip()),
        cover,
        tool('card', 'Card', () => this.newCard()),
        tool('next', 'Skip', () => this.nextRedo(true)),
      ];
    } else if (this.isReading()) {
      const atStart = sec && sec.start === this.qPage();
      items = [
        tool('section', 'Section starts here', () => this.newSectionHere(), { wide: true, disabled: atStart || this.side === 'a' }),
        tool('card', 'Card', () => this.newCard()),
        tool('done', 'Done', () => this.sectionDone(), { disabled: !sec || sec.done }),
        tool('more', 'More', () => this.moreSheet()),
      ];
    } else {
      items = [
        same ? null : tool('flip', this.side === 'q' ? 'Answers' : 'Questions', () => this.flip(), { disabled: !sec || !hasAnswers(sec) }),
        cover,
        tool('card', 'Card', () => this.newCard()),
        tool('done', 'Section done', () => this.sectionDone(), { disabled: !sec || sec.done }),
        tool('more', 'More', () => this.moreSheet()),
      ];
    }
    this.tools.replaceChildren(...items.filter(Boolean));
  }

  // ---------- sections ----------
  newSectionHere() {
    if (this.side === 'a') this.setSide('q');
    const page = this.qPage();
    const sec = createSection(this.pdfId, page);
    if (!sec) { toast('A section already starts on this page.'); return; }
    this.dismissed.delete(sec.id);
    this.pending = this.isReading() ? null : sec.id;
    const undo = () => { deleteSection(sec.id); this.pending = null; this.refresh(); };
    toast(this.isReading() ? 'Section starts here' : 'Questions start here. Now find the answers.', { label: 'Undo', fn: undo });
    vibrate();
    this.refresh();
  }

  setAnswersHere() {
    const sec = S.sections.get(this.pending) || (this.otherPdf && S.sections.get(this.otherPdf.secId));
    if (!sec) return;
    const pdfId = this.qv.pdfId, page = this.qv.currentPage();
    if (pdfId === sec.pdfId && page === sec.start && !this.otherPdf) {
      toast('That is the question page. Use "Same page" if answers sit with the questions.');
      return;
    }
    Object.assign(sec, { aPdf: pdfId, aPage: page, same: false, aLast: null });
    putSection(sec);
    this.pending = null;
    this.ansFor = null;
    vibrate();
    toast('Answers start here. Back to the questions.');
    this.backToQuestions(sec);
  }

  setSamePage() {
    const sec = S.sections.get(this.pending);
    if (!sec) return;
    Object.assign(sec, { same: true, aPdf: null, aPage: null });
    putSection(sec);
    this.pending = null;
    toast('Answers on the same page. Use Cover to hide them.');
    this.backToQuestions(sec);
  }

  async backToQuestions(sec) {
    if (this.otherPdf) {
      const back = this.otherPdf;
      this.otherPdf = null;
      await this.qv.open(back.backPdf, { page: sec.lastPage || sec.start });
    } else if (this.qPage() < sec.start || this.qPage() > qEnd(sec)) {
      this.qv.goTo(sec.lastPage && sec.lastPage <= qEnd(sec) ? sec.lastPage : sec.start);
    }
    this.refresh();
  }

  pickOtherPdf() {
    const sec = S.sections.get(this.pending);
    if (!sec) return;
    const others = pdfList().filter((p) => p.id !== this.pdfId);
    if (!others.length) { toast('Add the answers PDF to your library first.'); return; }
    const close = sheet('Answers are in…', others.map((p) =>
      h('button', { class: 'listbtn', onclick: async () => {
        close();
        this.persist();
        this.otherPdf = { backPdf: this.pdfId, secId: sec.id };
        await this.qv.open(p.id, p.pos || { page: 1 });
        this.refresh();
      } }, h('b', null, p.name), h('small', null, p.kind ? KIND_LABEL[p.kind] : ''))));
  }

  async cancelOther() {
    const back = this.otherPdf;
    this.otherPdf = null;
    const sec = S.sections.get(back.secId);
    await this.qv.open(back.backPdf, { page: (sec && sec.start) || 1 });
    this.refresh();
  }

  sectionDone() {
    const sec = this.curSection();
    if (!sec) return;
    sec.done = true;
    sec.doneAt = Date.now();
    putSection(sec);
    vibrate(30);
    const undo = () => { sec.done = false; sec.doneAt = null; putSection(sec); this.refresh(); };
    const next = sectionsOf(this.pdfId).find((s) => s.start > sec.start && !s.done);
    if (next) {
      if (this.side === 'a') this.setSide('q');
      this.qv.goTo(next.lastPage && next.lastPage <= qEnd(next) ? next.lastPage : next.start);
      toast(`Section done. Next: ${secLabel(next)}`, { label: 'Undo', fn: undo });
    } else {
      toast('Section done.', { label: 'Undo', fn: undo });
    }
    this.refresh();
  }

  maybeOfferChapters() {
    const pdf = S.pdfs.get(this.pdfId);
    this.chapterOffer = !!(this.mode === 'read' && pdf && pdf.kind && pdf.outline && pdf.outline.length >= 2 &&
      !pdf.outlineAsked && !sectionsOf(pdf.id).length);
    this.refresh();
  }

  chaptersSheet() {
    const pdf = S.pdfs.get(this.pdfId);
    const looksLikeAnswers = /answer|solution|mark scheme|key|explanation/i;
    const rows = pdf.outline.map((o) => ({ ...o, on: !looksLikeAnswers.test(o.title) }));
    const list = h('div', { class: 'checklist' }, rows.map((r) => {
      const cb = h('input', { type: 'checkbox', checked: r.on, onchange: () => { r.on = cb.checked; } });
      return h('label', { class: 'checkrow' }, cb, h('span', null, r.title), h('small', null, 'p.' + r.page));
    }));
    const close = sheet('Use chapters as sections', [
      h('p', { class: 'muted' }, 'Untick chapters that are answers, not questions.'),
      list,
      h('button', { class: 'btn big primary', onclick: () => {
        let n = 0;
        for (const r of rows) if (r.on && createSection(pdf.id, r.page, { title: r.title })) n++;
        pdf.outlineAsked = true;
        putPdf(pdf);
        this.chapterOffer = false;
        close();
        toast(`${plural(n, 'section')} ready.` + (this.isReading() ? '' : ' Tap where the answers start.'));
        const first = sectionsOf(pdf.id)[0];
        if (first && this.qPage() < first.start) this.qv.goTo(first.start);
        this.refresh();
      } }, 'Create sections'),
    ]);
  }

  // ---------- question numbers ----------
  bump(d) {
    const sec = this.curSection();
    if (!sec) return;
    sec.nextQ = Math.max(1, sec.nextQ + d);
    const marked = [...S.marks.values()].some((x) => x.sectionId === sec.id);
    if (!marked) sec.startNum = sec.nextQ;
    putSection(sec);
    this.renderMarks();
  }

  numberSheet() {
    const sec = this.curSection();
    if (!sec) return;
    const marked = [...S.marks.values()].some((x) => x.sectionId === sec.id);
    const inp = h('input', { class: 'numinput', type: 'number', inputmode: 'numeric', min: 1, value: sec.nextQ });
    const close = sheet(marked ? 'Next question number' : 'Start this section at question', [
      inp,
      h('button', { class: 'btn big primary', onclick: () => {
        const n = parseInt(inp.value, 10);
        if (n >= 1) { sec.nextQ = n; if (!marked) sec.startNum = n; putSection(sec); }
        close();
        this.renderMarks();
      } }, 'Set'),
    ]);
    setTimeout(() => inp.select(), 250);
  }

  // ---------- marking ----------
  mark(m) {
    vibrate(m === 'right' ? 12 : 25);
    if (this.mode === 'redo') return this.markRedo(m);
    const sec = this.curSection();
    if (!sec) return;
    const q = sec.nextQ;
    const undo = markQuestion(sec, q, m, this.answerCtx(sec));
    const word = { right: 'Right', wrong: 'Wrong — added to redo', unsure: 'Unsure — added to redo' }[m];
    toast(`Q${q}: ${word}`, { label: 'Undo', fn: () => { undo(); this.refresh(); } }, 2500);
    this.restoreCover();
    this.refresh();
  }

  // ---------- redo mode ----------
  startRedo() {
    this.queue = this.opts.queue || dueRedo().map((r) => r.id);
    this.qi = -1;
    this.nextRedo(false);
  }

  async nextRedo(skip) {
    if (skip && this.item) toast('Skipped');
    this.qi++;
    while (this.qi < this.queue.length && !S.redo.has(this.queue[this.qi])) this.qi++;
    if (this.qi >= this.queue.length) return this.redoFinished();
    this.item = S.redo.get(this.queue[this.qi]);
    const sec = S.sections.get(this.item.sectionId);
    this.pdfId = this.item.pdfId;
    this.ansFor = null;
    this.setSide('q', true);
    try { await this.qv.open(this.item.pdfId, { page: this.item.qPage }); } catch { /* shown */ }
    if (sec && sec.same) this.showCoverIfArmed(true);
    this.refresh();
    // Load the answer page behind the question so one tap shows it.
    if (sec && !sec.same && this.item.aPdf) {
      this.ansFor = sec.id;
      this.av.open(this.item.aPdf, { page: this.item.aPage || sec.aPage }).catch(() => {});
    }
  }

  markRedo(m) {
    const item = this.item;
    const res = reviewRedo(item, m);
    const msg = res.cleared ? `Q${item.qNum} cleared from redo` : `Q${item.qNum}: back in ${res.stage} days`;
    toast(msg, { label: 'Undo', fn: () => { res.undo(); this.qi--; this.queue.splice(this.qi + 1, 0, item.id); this.nextRedo(false); } }, 2500);
    this.nextRedo(false);
  }

  redoFinished() {
    this.item = null;
    if (this.opts.quick5) { nav('#/quick5/cards'); return; }
    toast('Redo list done for today.');
    nav('#/today');
  }

  // ---------- cover ----------
  buildCover() {
    const handle = h('div', { class: 'cover-handle' },
      h('button', { class: 'cover-btn', onclick: (e) => { e.stopPropagation(); this.cycleCover(); } }, 'Turn'),
      h('span', { class: 'grip' }),
      h('button', { class: 'cover-btn', onclick: (e) => { e.stopPropagation(); this.revealCover(); } }, 'Reveal'));
    const c = h('div', { class: 'cover', hidden: true }, h('div', { class: 'cover-fill' }), handle);
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.cover-btn')) return;
      drag = { id: e.pointerId };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = this.view.getBoundingClientRect();
      const mode = settings().cover.mode;
      const pos = mode === 'below' ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
      this.coverPos = clamp(pos, 0.02, 0.98);
      this.placeCover();
    });
    const up = () => {
      if (!drag) return;
      drag = null;
      setSettings({ cover: { mode: settings().cover.mode, pos: this.coverPos } });
    };
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    return c;
  }

  placeCover() {
    const { mode } = settings().cover;
    const pos = this.coverPos;
    const c = this.cover;
    c.className = 'cover ' + mode;
    const P = (v) => (v * 100).toFixed(2) + '%';
    if (mode === 'below') Object.assign(c.style, { top: P(pos), left: '0', right: '0', bottom: '0', width: '', height: '' });
    else if (mode === 'right') Object.assign(c.style, { top: '0', bottom: '0', left: P(pos), right: '0', width: '', height: '' });
    else Object.assign(c.style, { top: '0', bottom: '0', left: '0', right: P(1 - pos), width: '', height: '' });
  }

  toggleCover() {
    if (this.coverOn && this.coverShown) { this.coverOn = false; this.coverShown = false; }
    else { this.coverOn = true; this.coverShown = true; }
    this.coverPos = this.coverPos || settings().cover.pos;
    this.cover.hidden = !this.coverShown;
    if (this.coverShown) this.placeCover();
    this.renderTools();
  }

  showCoverIfArmed(arm) {
    if (arm && !this.coverOn) { this.coverOn = true; }
    if (!this.coverOn) return;
    this.coverPos = this.coverPos || settings().cover.pos;
    this.coverShown = true;
    this.cover.hidden = false;
    this.placeCover();
  }

  restoreCover() { if (this.coverOn) this.showCoverIfArmed(false); }

  revealCover() {
    this.coverShown = false;
    this.cover.hidden = true;
  }

  cycleCover() {
    const order = ['below', 'right', 'left'];
    const cur = settings().cover.mode;
    const mode = order[(order.indexOf(cur) + 1) % order.length];
    this.coverPos = mode === 'below' ? 0.45 : mode === 'right' ? 0.55 : 0.45;
    setSettings({ cover: { mode, pos: this.coverPos } });
    this.placeCover();
  }

  // ---------- cards ----------
  newCard() {
    const sec = this.curSection();
    const link = {
      pdfId: this.mode === 'redo' && this.item ? this.item.pdfId : this.pdfId,
      page: this.mode === 'redo' && this.item ? this.item.qPage : this.qPage(),
      sectionId: sec ? sec.id : null,
      qNum: this.mode === 'redo' && this.item ? this.item.qNum : sec ? Math.max(1, sec.nextQ - 1) : null,
    };
    cardForm(null, link);
  }

  // ---------- timed past paper ----------
  tick() {
    const p = activePaper();
    const show = p && this.mode === 'read' && p.pdfId === this.pdfId;
    this.timerChip.hidden = !show;
    if (!show) return;
    const el = paperElapsed(p);
    const left = p.limitSec - el;
    this.timerChip.classList.toggle('over', left < 0);
    this.timerChip.classList.toggle('stopped', p.takenSec != null);
    this.timerChip.replaceChildren(icon('timer'), h('span', null, left >= 0 ? fmtDur(left) : '+' + fmtDur(-left)));
    if (left < 0 && !p.alerted && p.takenSec == null) {
      p.alerted = true;
      vibrate([200, 100, 200]);
      toast("Time's up. Stop the clock when you finish.", { label: 'Stop clock', fn: () => { stopPaperClock(p); this.tick(); } }, 8000);
    }
  }

  timedSheet() {
    let custom = 90;
    const val = h('b', { class: 'stepval' }, '1h 30m');
    const show = () => { val.textContent = `${Math.floor(custom / 60)}h ${String(custom % 60).padStart(2, '0')}m`; };
    const start = (min) => {
      close();
      startPaper(this.pdfId, min * 60);
      toast(`Timer started: ${min >= 60 ? (min / 60) + ' h' : min + ' min'}. Your ticks and crosses are scored.`);
      this.tick();
    };
    const close = sheet('Timed paper', [
      h('div', { class: 'grid3' },
        [60, 120, 180].map((m) => h('button', { class: 'btn big', onclick: () => start(m) }, `${m / 60} hour${m > 60 ? 's' : ''}`))),
      h('div', { class: 'stepper' },
        h('button', { class: 'btn', onclick: () => { custom = Math.max(5, custom - 15); show(); } }, '−15'),
        val,
        h('button', { class: 'btn', onclick: () => { custom = Math.min(600, custom + 15); show(); } }, '+15')),
      h('button', { class: 'btn big primary', onclick: () => start(custom) }, 'Start custom time'),
    ]);
  }

  paperSheet() {
    const p = activePaper();
    if (!p) return;
    const c = paperCounts(p);
    const close = sheet('Timed paper', [
      h('p', null, `Time ${fmtDur(paperElapsed(p))} of ${fmtDur(p.limitSec)} · Marked ${c.total}: ${c.right}✓ ${c.wrong}✗ ${c.unsure}?`),
      p.takenSec == null ? h('button', { class: 'btn big', onclick: () => { stopPaperClock(p); close(); this.tick(); toast('Clock stopped. Mark your answers, then finish.'); } }, 'Stop the clock') : null,
      h('button', { class: 'btn big primary', onclick: () => {
        finishPaper(p);
        close();
        this.tick();
        const score = p.total ? Math.round((100 * (p.right + p.unsure)) / p.total) : 0;
        sheet('Paper saved', [
          h('p', { class: 'bignum' }, `${p.right + p.unsure} / ${p.total}`),
          h('p', null, `${score}% in ${fmtDur(p.takenSec)}`),
          h('button', { class: 'btn big', onclick: () => closeSheets() }, 'OK'),
        ]);
      } }, 'Finish and save score'),
      h('button', { class: 'btn big ghost', onclick: async () => {
        close();
        if (await confirmSheet('Cancel this paper?', 'The timer and its score are discarded. Your ticks stay in your section scores.', 'Cancel paper', true)) { cancelPaper(p); this.tick(); }
      } }, 'Cancel paper'),
    ]);
  }

  // ---------- more ----------
  moreSheet() {
    const pdf = S.pdfs.get(this.pdfId);
    if (!pdf) return;
    const sec = this.curSection();
    const reading = this.isReading();
    const items = [];
    const add = (label, fn, cls = '') => items.push(h('button', { class: 'listbtn ' + cls, onclick: () => { close(); fn(); } }, label));
    if (this.mode === 'read' && !this.otherPdf) {
      if (sec) items.push(h('div', { class: 'sheet-info' },
        h('b', null, secLabel(sec)),
        h('small', null, `Pages ${sec.start}–${qEnd(sec)}` + (sec.same ? ' · answers on same page' : sec.aPage ? ` · answers ${S.pdfs.get(sec.aPdf)?.name === pdf.name ? '' : 'in ' + (S.pdfs.get(sec.aPdf)?.name || '?') + ' '}p.${sec.aPage}–${aEnd(sec)}` : ' · no answers yet'))));
      add(reading ? 'Section starts here' : 'Questions start here (new section)', () => this.newSectionHere());
      if (sec && !reading) add('Answers start here… (set again)', () => { if (this.side === 'a') this.setSide('q'); this.dismissed.delete(sec.id); this.pending = sec.id; sec.aPdf = null; sec.aPage = null; sec.same = false; putSection(sec); this.refresh(); toast('Scroll to the first answer page.'); });
      if (sec) add('Topic: ' + (sec.topic || 'none'), () => this.topicSheet(sec));
      if (sec && !reading) add('Question number…', () => this.numberSheet());
      if (sec && sec.done) add('Mark section not done', () => { sec.done = false; putSection(sec); this.refresh(); });
      if (!reading) add(activePaper() ? 'Timed paper (running)…' : 'Timed paper…', () => (activePaper() ? this.paperSheet() : this.timedSheet()));
      if (pdf.outline && pdf.outline.length) {
        add('Chapters (bookmarks)…', () => this.outlineSheet());
        if (!sectionsOf(pdf.id).length || pdf.outlineAsked) add('Use chapters as sections…', () => this.chaptersSheet());
      }
      if (sec) add('Delete this section', async () => {
        if (await confirmSheet('Delete this section?', 'Its scores and redo items go too. Pages are not affected.', 'Delete', true)) { deleteSection(sec.id); this.refresh(); }
      }, 'danger-text');
    }
    add(settings().invert ? 'Normal page colours' : 'Invert page colours (night)', () => {
      const inv = !settings().invert;
      setSettings({ invert: inv });
      this.view.classList.toggle('invert', inv);
    });
    add('Close PDF', () => this.close());
    const close = sheet(pdf.name, items);
  }

  outlineSheet() {
    const pdf = S.pdfs.get(this.pdfId);
    const close = sheet('Chapters', pdf.outline.map((o) =>
      h('button', { class: 'listbtn', onclick: () => { close(); if (this.side === 'a') this.setSide('q'); this.qv.goTo(o.page); } },
        h('b', null, o.title), h('small', null, 'p.' + o.page))));
  }

  topicSheet(sec) {
    const topics = settings().topics;
    if (!topics.length) { toast('Paste your topic list in Settings first.'); return; }
    const close = sheet('Topic', [
      h('div', { class: 'chips' },
        topics.map((t) => h('button', { class: 'chip big' + (sec.topic === t ? ' on' : ''), onclick: () => { sec.topic = t; sec.topicAsked = true; putSection(sec); close(); this.refresh(); } }, t)),
        h('button', { class: 'chip big ghost', onclick: () => { sec.topic = null; putSection(sec); close(); this.refresh(); } }, 'No topic')),
    ]);
  }

  close() {
    goBack();
  }
}

