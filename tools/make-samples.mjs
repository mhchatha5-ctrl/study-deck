// Generates made-up sample PDFs and a sample rota calendar for testing.
// Nothing here is a real book, paper or calendar.
//   node tools/make-samples.mjs [outDir]
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const outDir = process.argv[2] || 'test/fixtures';
mkdirSync(outDir, { recursive: true });

// ---------- tiny PDF writer ----------
function pdf({ pages, outline = [] }) {
  // pages: [{ w, h, text: [[x, y, size, str]], image: {w, h, gray|jpeg} }]
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = add(null);
  const pageIds = [];
  const esc = (s) => s.replace(/[\\()]/g, (m) => '\\' + m);
  for (const p of pages) {
    let content = '';
    let res = `/Font << /F1 ${font} 0 R >>`;
    if (p.image) {
      const im = p.image;
      const data = im.jpeg ? im.jpeg : deflateSync(im.gray);
      const head = `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace ${im.jpeg ? '/DeviceRGB' : '/DeviceGray'} /BitsPerComponent 8 /Filter ${im.jpeg ? '/DCTDecode' : '/FlateDecode'} /Length ${data.length} >>`;
      const imId = add({ head, data });
      res += ` /XObject << /Im1 ${imId} 0 R >>`;
      content += `q ${p.w} 0 0 ${p.h} 0 0 cm /Im1 Do Q\n`;
    }
    for (const [x, y, size, str] of p.text || []) content += `BT /F1 ${size} Tf ${x} ${y} Td (${esc(str)}) Tj ET\n`;
    const cBuf = Buffer.from(content, 'latin1');
    const cId = add({ head: `<< /Length ${cBuf.length} >>`, data: cBuf });
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << ${res} >> /Contents ${cId} 0 R >>`));
  }
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`;
  let outlinesId = null;
  if (outline.length) {
    outlinesId = add(null);
    const first = objs.length + 1;
    outline.forEach((o, i) => {
      const id = first + i;
      const parts = [`/Title (${esc(o.title)})`, `/Parent ${outlinesId} 0 R`, `/Dest [${pageIds[o.page - 1]} 0 R /Fit]`];
      if (i > 0) parts.push(`/Prev ${id - 1} 0 R`);
      if (i < outline.length - 1) parts.push(`/Next ${id + 1} 0 R`);
      add(`<< ${parts.join(' ')} >>`);
    });
    objs[outlinesId - 1] = `<< /Type /Outlines /First ${first} 0 R /Last ${first + outline.length - 1} 0 R /Count ${outline.length} >>`;
  }
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R${outlinesId ? ` /Outlines ${outlinesId} 0 R /PageMode /UseOutlines` : ''} >>`);
  const chunks = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let len = chunks[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(len);
    const parts = typeof o === 'string'
      ? [Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')]
      : [Buffer.from(`${i + 1} 0 obj\n${o.head}\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\nendobj\n', 'latin1')];
    for (const b of parts) { chunks.push(b); len += b.length; }
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${len}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

const A4 = [595, 842], LETTER = [612, 792];
const qPage = (title, from, to, extra = []) => ({
  w: A4[0], h: A4[1],
  text: [[60, 780, 22, title], ...Array.from({ length: to - from + 1 }, (_, i) => [60, 720 - i * 90, 16, `Q${from + i}. Sample question ${from + i}: which option is correct? (A) (B) (C) (D)`]), ...extra],
});
const aPage = (title, from, to) => ({
  w: A4[0], h: A4[1],
  text: [[60, 780, 22, title], ...Array.from({ length: to - from + 1 }, (_, i) => [60, 720 - i * 60, 16, `A${from + i}. The answer to sample question ${from + i} is (${'ABCD'[(from + i) % 4]}).`])],
});

// Question book: 3 chapters of questions, then an answers chapter, all bookmarked.
const book = [
  qPage('Chapter 1: Sample topic one', 1, 6), qPage('Chapter 1 (cont.)', 7, 12), qPage('Chapter 1 (cont.)', 13, 15),
  qPage('Chapter 2: Sample topic two', 1, 6), qPage('Chapter 2 (cont.)', 7, 10), qPage('Chapter 2 (cont.)', 11, 12),
  qPage('Chapter 3: Sample topic three', 1, 6), qPage('Chapter 3 (cont.)', 7, 9), qPage('Chapter 3 (cont.)', 10, 11),
  aPage('Answers: Chapter 1', 1, 10), aPage('Answers: Chapter 1 (cont.)', 11, 15),
  aPage('Answers: Chapter 2', 1, 12), aPage('Answers: Chapter 3', 1, 11),
];
writeFileSync(`${outDir}/Sample Question Book.pdf`, pdf({
  pages: book,
  outline: [
    { title: 'Chapter 1: Sample topic one', page: 1 },
    { title: 'Chapter 2: Sample topic two', page: 4 },
    { title: 'Chapter 3: Sample topic three', page: 7 },
    { title: 'Answers', page: 10 },
  ],
}));

// Separate answers PDF, no bookmarks.
writeFileSync(`${outDir}/Sample Answers.pdf`, pdf({
  pages: [aPage('Answers to the sample paper', 1, 10), aPage('Answers (cont.)', 11, 20)],
}));

// Past paper with answers on the same page.
writeFileSync(`${outDir}/Sample Paper.pdf`, pdf({
  pages: [1, 6, 11].map((from) => ({
    w: LETTER[0], h: LETTER[1],
    text: [[60, 740, 20, `Sample past paper: questions ${from}-${from + 4}`],
      ...Array.from({ length: 5 }, (_, i) => [[60, 680 - i * 120, 15, `Q${from + i}. Made-up exam question number ${from + i}?`],
        [80, 650 - i * 120, 13, `Answer: (${'ABCD'[(from + i) % 4]}) because of sample reason ${from + i}.`]]).flat()],
  })),
}));

// Reading PDF with bookmarks.
writeFileSync(`${outDir}/Sample Reading.pdf`, pdf({
  pages: Array.from({ length: 8 }, (_, i) => ({ w: A4[0], h: A4[1], text: [[60, 780, 22, `Reading part ${Math.floor(i / 3) + 1}, page ${i + 1}`], [60, 740, 14, 'Lorem ipsum sample text for reading practice.']] })),
  outline: [{ title: 'Part 1', page: 1 }, { title: 'Part 2', page: 4 }, { title: 'Part 3', page: 7 }],
}));

// "Scanned / handwritten" PDF: image-only pages (Flate gray + JPEG colour), mixed sizes.
const browser = await chromium.launch();
const page = await browser.newPage();
const scans = await page.evaluate(() => {
  function scribble(w, h, seed, color) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    let s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    g.fillStyle = color ? '#f3eedf' : '#ececec';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = color ? '#1d3b8a' : '#222';
    g.lineWidth = Math.max(2, w / 300);
    g.lineCap = 'round';
    for (let line = 0; line < 14; line++) {
      const y0 = 90 + line * (h - 160) / 14;
      let x = 60;
      g.beginPath();
      g.moveTo(x, y0);
      while (x < w - 80) {
        const dx = 8 + rnd() * 18;
        g.quadraticCurveTo(x + dx / 2, y0 - 18 - rnd() * 14, x + dx, y0 + (rnd() - .5) * 8);
        x += dx;
        if (rnd() < .12) { x += 20; g.moveTo(x, y0); }
      }
      g.stroke();
    }
    g.font = `bold ${Math.round(w / 14)}px serif`;
    g.fillStyle = g.strokeStyle;
    g.fillText('Q' + seed, 50, 70);
    const img = g.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rnd() - .5) * 26;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  const grayOf = (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const out = new Array(c.width * c.height);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
    return out;
  };
  const a = scribble(900, 1273, 1, false);
  const b = scribble(918, 1188, 2, true);
  const l = scribble(1200, 850, 3, true);
  return {
    gray: { w: 900, h: 1273, px: grayOf(a) },
    jpeg: { w: 918, h: 1188, url: b.toDataURL('image/jpeg', 0.8) },
    land: { w: 1200, h: 850, url: l.toDataURL('image/jpeg', 0.8) },
  };
});
await browser.close();
const jpegBuf = (u) => Buffer.from(u.split(',')[1], 'base64');
writeFileSync(`${outDir}/Sample Scan.pdf`, pdf({
  pages: [
    { w: A4[0], h: A4[1], image: { w: scans.gray.w, h: scans.gray.h, gray: Buffer.from(scans.gray.px) } },
    { w: LETTER[0], h: LETTER[1], image: { w: scans.jpeg.w, h: scans.jpeg.h, jpeg: jpegBuf(scans.jpeg.url) } },
    { w: A4[1], h: A4[0], image: { w: scans.land.w, h: scans.land.h, jpeg: jpegBuf(scans.land.url) } },
  ],
}));

// ---------- sample rota (iCalendar) ----------
const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
};
const ev = [];
const shifts = [
  [0, 'Early', '0700', '1500'], [1, 'LD', '0800', '2030'], [2, 'Night', '2000', '0830'],
  [4, 'Early', '0700', '1500'], [5, 'Early', '0700', '1500'], [7, 'Night', '2000', '0830'],
];
for (const [off, name, s, e] of shifts) {
  const end = e < s ? day(off + 1) : day(off);
  ev.push(['BEGIN:VEVENT', `UID:sample-${off}@example.invalid`, `DTSTART;TZID=Europe/London:${day(off)}T${s}00`,
    `DTEND;TZID=Europe/London:${end}T${e}00`, `SUMMARY:${name}`, 'END:VEVENT'].join('\r\n'));
}
ev.push(['BEGIN:VEVENT', 'UID:sample-leave@example.invalid', `DTSTART;VALUE=DATE:${day(9)}`, `DTEND;VALUE=DATE:${day(12)}`,
  'SUMMARY:Annual leave - a very long shift name that the calendar folds onto a second line', 'END:VEVENT'].join('\r\n'));
const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//study-deck//sample//EN', ...ev, 'END:VCALENDAR', '']
  .join('\r\n')
  .replace(/(SUMMARY:.{60})(.+)/, '$1\r\n $2'); // line folding
writeFileSync(`${outDir}/sample-rota.ics`, ics);
console.log('samples written to', outDir);
