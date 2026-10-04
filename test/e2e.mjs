// End-to-end tests in a phone-sized headless Chromium.
// Default device: Android Chrome (Pixel 7). Add --iphone to emulate iPhone Safari's screen.
//   node tools/make-samples.mjs && node test/e2e.mjs
import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';
import { serve } from './server.mjs';

const DEVICE = process.argv.includes('--iphone') ? 'iPhone 13' : 'Pixel 7';
const ONLY = (process.argv.find((a) => a.startsWith('--stage=')) || '').split('=')[1];
const PORT = 8300 + Math.floor(Math.random() * 400);
const BASE = `http://localhost:${PORT}/`;
const FIX = new URL('./fixtures/', import.meta.url).pathname;

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.log('  ✗ ' + name + '\n      ' + String(err && err.message).split('\n').slice(0, 3).join('\n      '));
  }
}

const server = await serve(PORT);
const browser = await chromium.launch();
const errors = [];

async function newPhone(opts = {}) {
  const ctx = await browser.newContext({ ...devices[DEVICE], serviceWorkers: opts.sw ? 'allow' : 'block', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  if (opts.time) await page.clock.install({ time: opts.time });
  return { ctx, page };
}

// ---------- helpers ----------
const H = (page) => ({
  async importPdfs(names) {
    await page.goto(BASE + '#/library');
    await page.waitForSelector('header .btn.primary');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('header .btn.primary')]);
    await fc.setFiles(names.map((n) => FIX + n));
    await page.waitForFunction((n) => document.querySelectorAll('.pdfrow').length === n &&
      ![...document.querySelectorAll('.pdf-open small')].some((s) => s.textContent.includes('Reading…')), names.length, { timeout: 30000 });
  },
  async kind(name, label) {
    await page.locator('.pdfrow', { hasText: name }).locator('.seg-btn', { hasText: label }).click();
  },
  async open(name) {
    await page.click('#tabs button[data-tab=library]');
    await page.locator('.pdfrow', { hasText: name }).locator('.pdf-open').click();
    await page.waitForSelector('.pv:not(.hidden-side) .pv-canvas');
    await page.waitForTimeout(250);
  },
  async scrollTo(n, frac = 0) {
    await page.evaluate(([n, frac]) => {
      const v = document.querySelector('.pv:not(.hidden-side)');
      const p = v.querySelectorAll('.pv-page')[n - 1];
      v.scrollTop = p.offsetTop + frac * p.offsetHeight;
    }, [n, frac]);
    await page.waitForTimeout(250);
  },
  page: () => page.locator('.st-head .chip:not(.timer)').innerText().then((t) => +t.match(/p\.(\d+)/)[1]),
  strip: () => page.locator('.st-strip').innerText().then((t) => t.replace(/\s*\n\s*/g, ' | ')),
  sub: () => page.locator('.st-sub').innerText(),
  qnum: () => page.locator('.qnum').innerText().then((t) => t.replace(/\s+/g, ' ')),
  state: () => page.evaluate(async () => {
    const { S } = await import('./js/store.js');
    const name = (id) => (S.pdfs.get(id) || {}).name;
    return {
      pdfs: [...S.pdfs.values()].map((p) => ({ name: p.name, kind: p.kind, pages: p.pages, pos: p.pos })),
      sections: [...S.sections.values()].sort((a, b) => a.created - b.created).map((s) => ({
        pdf: name(s.pdfId), start: s.start, title: s.title, aPdf: name(s.aPdf), aPage: s.aPage, same: s.same,
        nextQ: s.nextQ, startNum: s.startNum, done: s.done, topic: s.topic,
      })),
      redo: [...S.redo.values()].sort((a, b) => a.created - b.created).map((r) => ({
        pdf: name(r.pdfId), qNum: r.qNum, qPage: r.qPage, aPdf: name(r.aPdf), aPage: r.aPage, stage: r.stage, due: r.due,
      })),
      marks: [...S.marks.values()].map((m) => [m.qNum, m.m]),
      cards: [...S.cards.values()],
      papers: [...S.papers.values()],
      kv: S.kv,
    };
  }),
  back: () => page.click('.st-head .iconbtn[aria-label=Back]'),
  tool: (label) => page.locator('.tool', { hasText: label }).first().click(),
});

const run = (stage) => !ONLY || ONLY === String(stage);
console.log(`Testing as ${DEVICE}`);

// =====================================================================
if (run(1)) {
  console.log('Stage 1: library, sections, study view, scoring, redo');
  const { ctx, page } = await newPhone({ time: new Date('2026-10-04T09:00:00') });
  const t = H(page);
  await page.goto(BASE);

  await check('opens with zero setup and offers to add PDFs', async () => {
    await page.waitForSelector('.task');
    assert.match(await page.locator('.task h2').innerText(), /Add your PDFs/);
  });

  await check('adds five PDFs at once and reads page counts', async () => {
    await t.importPdfs(['Sample Question Book.pdf', 'Sample Answers.pdf', 'Sample Paper.pdf', 'Sample Reading.pdf', 'Sample Scan.pdf']);
    const s = await t.state();
    assert.deepEqual(s.pdfs.map((p) => [p.name, p.pages]).sort(), [
      ['Sample Answers', 2], ['Sample Paper', 3], ['Sample Question Book', 13], ['Sample Reading', 8], ['Sample Scan', 3]]);
  });

  await check('one tap sets each PDF type', async () => {
    await t.kind('Sample Question Book', 'Question book');
    await t.kind('Sample Paper', 'Past paper');
    await t.kind('Sample Reading', 'Reading');
    await t.kind('Sample Scan', 'Question book');
    await t.kind('Sample Answers', 'Question book');
    const s = await t.state();
    assert.equal(s.pdfs.find((p) => p.name === 'Sample Paper').kind, 'paper');
    assert.equal(s.pdfs.find((p) => p.name === 'Sample Reading').kind, 'reading');
  });

  await check('bookmarks are offered as sections; answer chapters unticked', async () => {
    await t.open('Sample Question Book');
    assert.match(await t.strip(), /4 chapters/);
    await page.click('.st-strip >> text=Use chapters');
    const rows = await page.$$eval('.checkrow', (els) => els.map((e) => [e.querySelector('span').textContent, e.querySelector('input').checked]));
    assert.deepEqual(rows.map((r) => r[1]), [true, true, true, false]);
    await page.click('text=Create sections');
    const s = await t.state();
    assert.deepEqual(s.sections.map((x) => [x.start, x.title]), [[1, 'Chapter 1: Sample topic one'], [4, 'Chapter 2: Sample topic two'], [7, 'Chapter 3: Sample topic three']]);
    assert.match(await t.strip(), /Answers for Chapter 1/);
  });

  await check('only one tap needed where answers start (same PDF)', async () => {
    await t.scrollTo(10);
    assert.match(await t.strip(), /first answer page for Chapter 1/);
    await page.click('.st-strip >> text=Answers start here');
    await page.waitForTimeout(300);
    assert.equal(await t.page(), 1, 'returns to the question page');
    assert.equal((await t.state()).sections[0].aPage, 10);
    assert.ok(await page.locator('.st-marks').isVisible());
  });

  await check('sections end where the next starts (questions and answers)', async () => {
    const r = await page.evaluate(async () => {
      const { S, qEnd, aEnd, sectionsOf } = await import('./js/store.js');
      const pdf = [...S.pdfs.values()].find((p) => p.name === 'Sample Question Book');
      return sectionsOf(pdf.id).map((s) => [s.start, qEnd(s), s.aPage, aEnd(s)]);
    });
    assert.deepEqual(r, [[1, 3, 10, 13], [4, 6, null, null], [7, 9, null, null]], JSON.stringify(r));
  });

  await check('start number can be set before the first mark; counts up; − and + fix drift', async () => {
    assert.match(await t.qnum(), /START Q1/);
    await page.click('.step[aria-label="Next number"]');
    await page.click('.step[aria-label="Next number"]');
    assert.match(await t.qnum(), /START Q3/);
    await page.click('.step[aria-label="Previous number"]');
    await page.click('.step[aria-label="Previous number"]');
    await page.click('.mark.right');
    await page.click('.mark.wrong');
    await page.click('.mark.unsure');
    assert.match(await t.qnum(), /NEXT Q4/);
    await page.click('.step[aria-label="Previous number"]');
    assert.match(await t.qnum(), /NEXT Q3/);
    await page.click('.step[aria-label="Next number"]');
    const s = await t.state();
    assert.deepEqual(s.marks.sort(), [[1, 'right'], [2, 'wrong'], [3, 'unsure']]);
    assert.equal(s.sections[0].startNum, 1);
  });

  await check('cross and ? join the redo list with PDF, question page, number and answer page', async () => {
    const s = await t.state();
    assert.deepEqual(s.redo.map((r) => [r.pdf, r.qNum, r.qPage, r.aPdf, r.aPage, r.stage, r.due]), [
      ['Sample Question Book', 2, 1, 'Sample Question Book', 10, 3, '2026-10-07'],
      ['Sample Question Book', 3, 1, 'Sample Question Book', 10, 3, '2026-10-07']]);
  });

  await check('undo removes a mark and its redo item', async () => {
    await page.click('.mark.wrong');
    await page.click('#toast .toast-btn');
    const s = await t.state();
    assert.equal(s.marks.length, 3);
    assert.equal(s.redo.length, 2);
    assert.match(await t.qnum(), /Q4/);
  });

  await check('one tap flips to answers and back, keeping each side’s place', async () => {
    await t.scrollTo(2, 0.3);
    await t.tool('Answers');
    await page.waitForSelector('.pv:not(.hidden-side) .pv-canvas');
    assert.equal(await t.page(), 10);
    assert.equal(await page.locator('.side-badge').innerText(), 'ANSWERS');
    await t.scrollTo(11);
    await t.tool('Questions');
    assert.equal(await t.page(), 2);
    await t.tool('Answers');
    assert.equal(await t.page(), 11);
    await page.click('.mark.wrong'); // marking from the answer side records the answer page in view
    const r = (await t.state()).redo.at(-1);
    assert.deepEqual([r.qNum, r.qPage, r.aPage], [4, 2, 11]);
    await t.tool('Questions');
  });

  await check('card form opens with one tap, linked to the current question', async () => {
    await t.tool('Card');
    await page.fill('.sheet textarea >> nth=0', 'Sample trigger');
    await page.fill('.sheet textarea >> nth=1', 'Sample target');
    await page.click('text=Save card');
    const c = (await t.state()).cards[0];
    assert.equal(c.trigger, 'Sample trigger');
    assert.equal(c.qNum, 4);
    assert.equal(c.page, 2);
  });

  await check('Android back closes a sheet without leaving the PDF', async () => {
    await t.tool('More');
    await page.waitForSelector('.sheet');
    await page.goBack();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.sheet').count(), 0);
    assert.match(page.url(), /#\/read\//);
  });

  await check('Section done moves on to the next section', async () => {
    await t.tool('Section done');
    await page.waitForTimeout(300);
    assert.equal(await t.page(), 4);
    assert.match(await t.sub(), /Chapter 2/);
    assert.equal((await t.state()).sections[0].done, true);
    assert.match(await t.strip(), /Answers for Chapter 2/);
    await t.scrollTo(12);
    await page.click('.st-strip >> text=Answers start here');
    await page.waitForTimeout(300);
    assert.equal(await t.page(), 4);
    assert.match(await t.qnum(), /START Q1/, 'numbering restarts at 1 in a new section');
  });

  await check('screen wake lock is requested while studying', async () => {
    const asked = await page.evaluate(() => 'wakeLock' in navigator);
    assert.ok(typeof asked === 'boolean');
  });

  await check('same-page answers: cover drags, turns to either side, reveals, returns after marking', async () => {
    await t.back();
    await t.open('Sample Paper');
    await page.click('.st-strip >> text=Questions start here');
    await page.click('.st-strip >> text=Same page');
    assert.equal(await page.locator('.tool', { hasText: 'Answers' }).count(), 0);
    await t.tool('Cover');
    assert.ok(await page.locator('.cover').isVisible());
    const b1 = await page.locator('.cover-handle').boundingBox();
    await page.mouse.move(b1.x + b1.width / 2, b1.y + 20);
    await page.mouse.down();
    await page.mouse.move(b1.x + b1.width / 2, b1.y + 180, { steps: 6 });
    await page.mouse.up();
    const b2 = await page.locator('.cover-handle').boundingBox();
    assert.ok(b2.y > b1.y + 120, 'cover moved down');
    await page.click('.cover-btn:has-text("Turn")');
    assert.match(await page.locator('.cover').getAttribute('class'), /right/);
    await page.click('.cover-btn:has-text("Turn")');
    assert.match(await page.locator('.cover').getAttribute('class'), /left/);
    await page.click('.cover-btn:has-text("Reveal")');
    assert.ok(await page.locator('.cover').isHidden());
    await page.click('.mark.wrong');
    assert.ok(await page.locator('.cover').isVisible(), 'cover returns for the next question');
    const r = (await t.state()).redo.at(-1);
    assert.deepEqual([r.pdf, r.qNum, r.aPdf, r.aPage], ['Sample Paper', 1, 'Sample Paper', 1]);
    await page.click('.cover-btn:has-text("Turn")'); // back to "below" for later
  });

  await check('answers in another PDF; scanned pages draw like typed ones', async () => {
    await t.back();
    await t.open('Sample Scan');
    const ink = await page.evaluate(() => {
      const c = document.querySelector('.pv:not(.hidden-side) .pv-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 16) if (d[i] < 90) dark++;
      return dark;
    });
    assert.ok(ink > 500, 'scanned handwriting is visible on the canvas');
    await page.click('.st-strip >> text=Questions start here');
    await page.click('.st-strip >> text=Other PDF');
    await page.click('.sheet .listbtn:has-text("Sample Answers")');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.st-title').innerText(), 'Sample Answers');
    await t.scrollTo(2);
    await page.click('.st-strip >> text=Answers start here');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.st-title').innerText(), 'Sample Scan');
    await t.tool('Answers');
    await page.waitForSelector('.pv:not(.hidden-side) .pv-canvas');
    assert.equal(await t.page(), 2);
    assert.equal(await page.locator('.st-title').innerText(), 'Sample Answers');
    await t.tool('Questions');
  });

  await check('scanned PDF with mixed page sizes lays out each page at its own shape', async () => {
    await page.waitForTimeout(400);
    const ratios = await page.$$eval('.pv:not(.hidden-side) .pv-page', (els) => els.map((e) => +(e.offsetHeight / e.offsetWidth).toFixed(2)));
    const want = [842 / 595, 792 / 612, 595 / 842];
    ratios.forEach((r, i) => assert.ok(Math.abs(r - want[i]) < 0.015, JSON.stringify(ratios)));
  });

  await check('pinch zooms the page (two fingers), double-tap zooms back', async () => {
    const cdp = await ctx.newCDPSession(page);
    const box = await page.locator('.st-view').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const tp = (d) => [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(40) });
    for (let d = 40; d <= 120; d += 8) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(d) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(500);
    const w = await page.evaluate(() => { const v = document.querySelector('.pv:not(.hidden-side)'); return v.firstChild.offsetWidth / v.clientWidth; });
    assert.ok(w > 2.5 && w < 3.5, 'zoomed about 3x, got ' + w);
    for (let i = 0; i < 2; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 3 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(300);
    const w2 = await page.evaluate(() => { const v = document.querySelector('.pv:not(.hidden-side)'); return v.firstChild.offsetWidth / v.clientWidth; });
    assert.ok(Math.abs(w2 - 1) < 0.01, 'back to fit width, got ' + w2);
  });

  await check('reading PDFs: Section starts here, then Done (no scoring)', async () => {
    await t.back();
    await t.open('Sample Reading');
    await page.click('.st-strip >> text=No thanks');
    assert.equal(await page.locator('.st-marks').isVisible(), false);
    await t.tool('Section starts here');
    await t.scrollTo(4);
    await t.tool('Section starts here');
    await t.scrollTo(2);
    await t.tool('Done');
    await page.waitForTimeout(300);
    assert.equal(await t.page(), 4);
    const s = (await t.state()).sections.filter((x) => x.pdf === 'Sample Reading');
    assert.deepEqual(s.map((x) => [x.start, x.done]), [[1, true], [4, false]]);
  });

  await check('topics: one tap from the pasted list (optional)', async () => {
    await page.evaluate(async () => { const { setSettings } = await import('./js/store.js'); setSettings({ topics: ['Topic A', 'Topic B'] }); });
    await t.scrollTo(5);
    assert.match(await t.strip(), /Topic for this section/);
    await page.click('.st-strip .chip:has-text("Topic B")');
    const s = (await t.state()).sections.find((x) => x.pdf === 'Sample Reading' && x.start === 4);
    assert.equal(s.topic, 'Topic B');
  });

  await check('reopening resumes at the exact page (no page numbers typed)', async () => {
    await t.scrollTo(6, 0.5);
    await t.back();
    await page.goto(BASE + '#/today');
    await page.reload();
    await page.waitForSelector('.task');
    assert.match(await page.locator('.task p').innerText(), /Sample Reading.*p\.6/);
    await page.click('.task .btn');
    await page.waitForSelector('.pv-canvas');
    await page.waitForTimeout(300);
    assert.equal(await t.page(), 6);
    await page.screenshot({ path: 'test/out/resume.png' });
    const frac = await page.evaluate(() => {
      const v = document.querySelector('.pv:not(.hidden-side)');
      const p = v.querySelectorAll('.pv-page')[5];
      return (v.scrollTop - p.offsetTop) / p.offsetHeight;
    });
    assert.ok(Math.abs(frac - 0.5) < 0.03, 'same spot on the page, got ' + frac);
    await t.back();
  });

  await check('redo items come back after 3 days, first on Today, opening with their answers', async () => {
    await page.clock.setSystemTime(new Date('2026-10-07T08:00:00'));
    await page.reload();
    await page.waitForSelector('.task');
    assert.match(await page.locator('.task h2').innerText(), /Redo 4 questions/);
    await page.click('.task .btn');
    await page.waitForSelector('.st-marks:not([hidden])');
    await page.waitForTimeout(400);
    assert.match(await page.locator('.st-title').innerText(), /Redo 1 of 4/);
    assert.equal(await t.page(), 1);
    await t.tool('Answer');
    await page.waitForTimeout(300);
    assert.equal(await t.page(), 10, 'answer page opens with one tap');
  });

  await check('tick → 10 days, cross → back to 3 days', async () => {
    await page.click('.mark.right');   // Q2 → 10 days
    await page.waitForTimeout(400);
    await page.click('.mark.wrong');   // Q3 → 3 days
    await page.waitForTimeout(400);
    await page.click('.mark.right');   // Q4 (aPage 11) → 10 days
    await page.waitForTimeout(400);
    await page.click('.mark.unsure');  // paper Q1 → 3 days
    await page.waitForTimeout(600);
    assert.match(page.url(), /#\/today/);
    const r = (await t.state()).redo;
    assert.deepEqual(r.map((x) => [x.qNum, x.stage, x.due]), [[2, 10, '2026-10-17'], [3, 3, '2026-10-10'], [4, 10, '2026-10-17'], [1, 3, '2026-10-10']]);
  });

  await check('a tick at the 10-day stage clears the item', async () => {
    await page.clock.setSystemTime(new Date('2026-10-17T08:00:00'));
    await page.reload();
    await page.waitForSelector('.task');
    await page.click('.task .btn');
    await page.waitForSelector('.st-marks:not([hidden])');
    await page.waitForTimeout(300);
    for (let i = 0; i < 4; i++) { await page.click('.mark.right'); await page.waitForTimeout(400); }
    const after = (await t.state()).redo;
    assert.deepEqual(after.map((x) => [x.qNum, x.stage, x.due]), [[3, 10, '2026-10-27'], [1, 10, '2026-10-27']]);
  });

  await check('data survives a reload (on-device storage)', async () => {
    await page.goto(BASE + '#/library');
    await page.reload();
    await page.waitForSelector('.pdfrow');
    await page.click('#tabs button[data-tab=today]');
    await page.waitForSelector('.task');
    const s = await t.state();
    assert.equal(s.pdfs.length, 5);
    assert.ok(s.sections.length >= 6);
    assert.equal(s.cards.length, 1);
  });
  await ctx.close();
}

// =====================================================================
async function seedLibrary(page, t) {
  await t.importPdfs(['Sample Question Book.pdf', 'Sample Answers.pdf', 'Sample Paper.pdf', 'Sample Reading.pdf']);
  await t.kind('Sample Question Book', 'Question book');
  await t.kind('Sample Answers', 'Question book');
  await t.kind('Sample Paper', 'Past paper');
  await t.kind('Sample Reading', 'Reading');
  // Sections set up directly (the tapping itself is covered in stage 1).
  await page.evaluate(async () => {
    const { S, createSection, putSection } = await import('./js/store.js');
    const id = (n) => [...S.pdfs.values()].find((p) => p.name === n).id;
    const qb = id('Sample Question Book'), rd = id('Sample Reading'), pp = id('Sample Paper');
    const a = createSection(qb, 1, { title: 'Ch 1' }); a.aPdf = qb; a.aPage = 10; putSection(a);
    const b = createSection(qb, 4, { title: 'Ch 2' }); b.aPdf = qb; b.aPage = 12; putSection(b);
    createSection(rd, 1, { title: 'Part 1' });
    createSection(rd, 4, { title: 'Part 2' });
    const c = createSection(pp, 1, { title: 'Paper' }); c.same = true; putSection(c);
  });
}

if (run(2)) {
  console.log('Stage 2: Today and Quick 5');
  const { ctx, page } = await newPhone({ time: new Date('2026-10-04T09:00:00') });
  const t = H(page);
  await page.goto(BASE);
  await seedLibrary(page, t);

  await check('without setup, Today resumes where you stopped', async () => {
    await t.open('Sample Question Book');
    await t.scrollTo(5, 0.2);
    await t.back();
    await page.click('#tabs button[data-tab=today]');
    assert.match(await page.locator('.task p').innerText(), /Sample Question Book · Ch 2 · p\.5/);
    await page.click('.task .btn');
    await page.waitForSelector('.pv-canvas');
    assert.equal(await t.page(), 5);
    await t.back();
  });

  await check('exam date proposes plan phase dates, which can be adjusted', async () => {
    await page.click('#tabs button[data-tab=settings]');
    await page.locator('.card', { hasText: 'Exam and plan' }).locator('input[type=date]').first().fill('2026-12-31');
    await page.waitForTimeout(200);
    let s = (await t.state()).kv.settings;
    assert.deepEqual([s.examDate, s.readEnd, s.qEnd], ['2026-12-31', '2026-10-30', '2026-12-09']);
    await page.locator('.field', { hasText: 'Reading until' }).locator('input').fill('2026-10-20');
    await page.waitForTimeout(200);
    s = (await t.state()).kv.settings;
    assert.equal(s.readEnd, '2026-10-20');
  });

  await check('topics are pasted once, one per line', async () => {
    await page.locator('.card', { hasText: 'Topics' }).locator('textarea').fill('Topic A\nTopic B\n\nTopic C\nTopic A');
    await page.click('text=Save topics');
    assert.deepEqual((await t.state()).kv.settings.topics, ['Topic A', 'Topic B', 'Topic C']);
  });

  await check('reading phase: Today offers the next reading section; days left shown', async () => {
    await page.click('#tabs button[data-tab=today]');
    assert.equal(await page.locator('.daysleft b').innerText(), '88');
    assert.match(await page.locator('.chips').innerText(), /Reading phase/);
    assert.match(await page.locator('.task p').innerText(), /Sample Reading · Part 1/);
  });

  await check('Section done means Start moves on to the next section', async () => {
    await page.click('.task .btn');
    await page.waitForSelector('.pv-canvas');
    await t.tool('Done');
    await page.waitForTimeout(200);
    await t.back();
    await page.goto(BASE + '#/today');
    assert.match(await page.locator('.task p').innerText(), /Part 2 · p\.4/);
  });

  await check('due redo items always come first', async () => {
    await page.evaluate(async () => {
      const { S, markQuestion } = await import('./js/store.js');
      const sec = [...S.sections.values()].find((s) => s.title === 'Ch 1');
      markQuestion(sec, 1, 'wrong', { qPage: 1, aPdf: sec.aPdf, aPage: 10 });
      markQuestion(sec, 2, 'unsure', { qPage: 1, aPdf: sec.aPdf, aPage: 10 });
    });
    await page.clock.setSystemTime(new Date('2026-10-07T09:00:00'));
    await page.reload();
    await page.waitForSelector('.task');
    assert.match(await page.locator('.task h2').innerText(), /Redo 2 questions/);
  });

  await check('Not today moves the task (and due redo) to tomorrow; no self-rating', async () => {
    await page.click('text=Not today');
    assert.match(await page.locator('.task h2').innerText(), /Not today/);
    assert.deepEqual((await t.state()).redo.map((r) => r.due), ['2026-10-08', '2026-10-08']);
    await page.clock.setSystemTime(new Date('2026-10-08T09:00:00'));
    await page.reload();
    await page.waitForSelector('.task');
    assert.match(await page.locator('.task h2').innerText(), /Redo 2 questions/);
  });

  await check('Quick 5 serves due redo items, then cards, with a 5-minute countdown', async () => {
    await page.evaluate(async () => {
      const { addCard } = await import('./js/store.js');
      addCard({ trigger: 'Card one', target: 'Answer one' });
      addCard({ trigger: 'Card two', target: 'Answer two' });
    });
    await page.click('text=Quick 5');
    await page.waitForFunction(() => /Redo/.test(document.querySelector('.st-title')?.textContent));
    assert.match(await page.locator('.st-title').innerText(), /Redo 1 of 2 · Quick 5/);
    assert.match(await page.locator('.st-head span.chip.timer').innerText(), /^[45]:\d\d$/);
    await page.click('.mark.right');
    await page.waitForTimeout(300);
    await page.click('.mark.right');
    await page.waitForSelector('.rv-card');
    assert.match(await page.locator('.st-title').innerText(), /Quick 5 · Cards/);
    await page.click('.rv-card');
    await page.click('text=Knew it');
    await page.click('.rv-card');
    await page.click('text=Missed it');
    assert.match(await page.locator('.rv-done').innerText(), /1 \/ 2/);
    await page.click('.rv-bar .btn');
    assert.match(page.url(), /#\/today/);
  });

  await check('questions phase: Today offers the next question-book section', async () => {
    assert.deepEqual((await t.state()).redo.map((r) => [r.stage, r.due]), [[10, '2026-10-18'], [10, '2026-10-18']]);
    await page.evaluate(async () => { const { S, removeRedo } = await import('./js/store.js'); [...S.redo.keys()].forEach(removeRedo); });
    await page.clock.setSystemTime(new Date('2026-10-25T09:00:00'));
    await page.reload();
    await page.waitForSelector('.task');
    assert.match(await page.locator('.chips').innerText(), /Question books phase/);
    assert.match(await page.locator('.task p').innerText(), /Question book: Sample Question Book · Ch 2/);
  });

  await check('past papers phase: Today offers a timed paper; Start asks for the time limit', async () => {
    await page.clock.setSystemTime(new Date('2026-12-15T09:00:00'));
    await page.reload();
    await page.waitForSelector('.task');
    assert.match(await page.locator('.task h2').innerText(), /Timed past paper/);
    await page.click('.task .btn');
    await page.waitForSelector('.sheet');
    assert.match(await page.locator('.sheet').innerText(), /1 hour[\s\S]*2 hours[\s\S]*3 hours/);
    await page.goBack();
    await t.back();
  });

  await check('Quick 5 with nothing due says so plainly', async () => {
    await page.evaluate(async () => {
      const { S, deleteCard, removeRedo } = await import('./js/store.js');
      [...S.cards.keys()].forEach(deleteCard);
      [...S.redo.keys()].forEach(removeRedo);
    });
    await page.goto(BASE + '#/today');
    await page.click('text=Quick 5');
    assert.match(await page.locator('#toast').innerText(), /Nothing for Quick 5/);
  });
  await ctx.close();
}

// =====================================================================
if (run(3)) {
  console.log('Stage 3: cards and audio');
  const { ctx, page } = await newPhone();
  // Stand-in phone voice and wake lock, so speech can be checked headless.
  await ctx.addInitScript(() => {
    window.__spoken = [];
    window.__wake = 0;
    const fake = {
      speak(u) { window.__spoken.push({ text: u.text, at: performance.now() }); setTimeout(() => u.onend && u.onend(), 40); },
      cancel() {}, getVoices: () => [], speaking: false, paused: false,
    };
    Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true });
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => {
      window.__wake++;
      const l = new EventTarget();
      l.release = async () => { window.__wake--; l.dispatchEvent(new Event('release')); };
      return l;
    } } });
  });
  const t = H(page);
  await page.goto(BASE + '#/cards');
  await page.waitForSelector('header h1');

  await check('write Trigger → Target cards in seconds', async () => {
    for (const [a, b] of [['Alpha trigger', 'Alpha target'], ['Beta trigger', 'Beta target'], ['Gamma trigger', 'Gamma target']]) {
      await page.click('.pad .btn:has-text("New card")');
      await page.waitForSelector('.sheet-back.show textarea');
      await page.fill('.sheet textarea >> nth=0', a);
      await page.fill('.sheet textarea >> nth=1', b);
      await page.click('.sheet >> text=Save card');
      await page.waitForTimeout(250);
    }
    assert.equal((await t.state()).cards.length, 3);
    await page.goto(BASE + '#/today');
    await page.goto(BASE + '#/cards');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.cardrow').count(), 3);
  });

  await check('edit and delete a card', async () => {
    await page.click('.cardrow:has-text("Gamma")');
    await page.fill('.sheet textarea >> nth=1', 'Gamma target edited');
    await page.click('.sheet >> text=Save card');
    await page.waitForTimeout(250);
    assert.ok((await t.state()).cards.some((c) => c.target === 'Gamma target edited'));
    await page.click('.cardrow:has-text("Gamma")');
    await page.click('.sheet >> text=Delete card');
    await page.click('.sheet .btn.danger');
    await page.waitForTimeout(300);
    assert.equal((await t.state()).cards.length, 2);
  });

  await check('tap to reveal, then Knew it / Missed it', async () => {
    await page.click('.pad .btn:has-text("Review")');
    await page.waitForSelector('.rv-card');
    assert.equal(await page.locator('.rv-targ').count(), 0);
    await page.click('.rv-card');
    assert.equal(await page.locator('.rv-targ').innerText(), 'Alpha target');
    await page.click('text=Knew it');
    await page.click('.rv-bar >> text=Reveal');
    assert.equal(await page.locator('.rv-targ').innerText(), 'Beta target');
    await page.click('text=Missed it');
    assert.match(await page.locator('.rv-done').innerText(), /1 \/ 2/);
    await page.click('.rv-bar .btn');
  });

  await check('missed cards come first next time', async () => {
    await page.click('.pad .btn:has-text("Review")');
    await page.waitForSelector('.rv-card');
    assert.equal(await page.locator('.rv-trig').innerText(), 'Beta trigger');
    await page.click('.st-head .iconbtn');
  });

  await check('audio mode reads cards aloud, pausing before each Target, screen kept awake', async () => {
    await page.click('.pad .btn:has-text("Audio")');
    await page.waitForSelector('.audio');
    for (let k = 0; k < 2; k++) await page.click('[aria-label="Shorter pause"]');  // 3s → 1s
    await page.click('.rv-bar >> text=Play');
    await page.waitForFunction(() => window.__spoken.length >= 4, null, { timeout: 15000 });
    const spoken = await page.evaluate(() => window.__spoken);
    assert.deepEqual(spoken.slice(0, 4).map((x) => x.text), ['Beta trigger', 'Beta target', 'Alpha trigger', 'Alpha target']);
    const gap = spoken[1].at - spoken[0].at;
    assert.ok(gap >= 1000 && gap < 2500, 'pause before target was ' + Math.round(gap) + 'ms');
    await page.waitForSelector('text=All cards read.', { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.__wake), 0, 'released when the round ends');
  });

  await check('audio pause holds the screen awake only while playing', async () => {
    await page.click('.rv-bar >> text=Play');
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__wake), 1);
    await page.click('.rv-bar >> text=Pause');
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__wake), 0);
    const n = await page.evaluate(() => window.__spoken.length);
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => window.__spoken.length), n, 'nothing spoken while paused');
    await page.click('.st-head .iconbtn');
  });
  await ctx.close();
}

// =====================================================================
console.log(errors.length ? `Page errors:\n  ${[...new Set(errors)].join('\n  ')}` : 'No page errors.');
console.log(`${passed} passed, ${failed} failed`);
await browser.close();
server.close();
process.exit(failed || errors.length ? 1 : 0);
