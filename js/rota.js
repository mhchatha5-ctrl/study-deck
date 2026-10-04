// Rota: an iCal (.ics) feed read directly by the phone (never via another
// service), a downloaded .ics file, or days tapped on a small calendar.
import { h, toast, today, addDays, dstr, parseD, niceDate, pickFiles, plural } from './util.js';
import { kv, setKv } from './store.js';

export const DAY_LABEL = { work: 'Work day', long: 'Long day', night: 'Night', off: 'Day off', away: 'Away' };
const LABELS = ['work', 'long', 'night', 'off', 'away'];
const SHORT = { work: 'Work', long: 'Long', night: 'Night', off: 'Off', away: 'Away' };
const PRIORITY = ['away', 'night', 'long', 'work', 'off'];

const rota = () => ({ url: '', events: [], labels: {}, manual: {}, status: null, ...kv('rota', {}) });
const saveRota = (r) => setKv('rota', r);

// ---------- iCalendar parsing ----------
function unescape(v) {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}
function icsDate(value, params) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const allDay = !hh || /VALUE=DATE(?!-)/.test(params || '');
  if (z && hh) {
    const t = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +(ss || 0)));
    return { day: dstr(t), allDay: false };
  }
  return { day: `${y}-${mo}-${d}`, allDay };
}
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function parseICS(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = { ex: [] }; continue; }
    if (line === 'END:VEVENT') { if (ev) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [name, ...params] = head.split(';');
    const p = params.join(';');
    switch (name.toUpperCase()) {
      case 'SUMMARY': ev.name = unescape(value); break;
      case 'DTSTART': ev.start = icsDate(value, p); break;
      case 'DTEND': ev.end = icsDate(value, p); break;
      case 'RRULE': ev.rrule = value; break;
      case 'EXDATE': value.split(',').forEach((v) => { const d = icsDate(v, p); if (d) ev.ex.push(d.day); }); break;
      case 'STATUS': ev.cancelled = /CANCELLED/i.test(value); break;
      default:
    }
  }
  const out = [];
  const lo = addDays(today(), -60), hi = addDays(today(), 400);
  for (const e of events) {
    if (!e.start || !e.name || e.cancelled) continue;
    // Days one occurrence covers: all-day events cover each day up to DTEND
    // (exclusive); timed shifts count on the day they start (nights too).
    let span = 1;
    if (e.start.allDay && e.end && e.end.day > e.start.day) {
      span = Math.min(31, Math.round((parseD(e.end.day) - parseD(e.start.day)) / 86400000));
    }
    for (const startDay of occurrences(e, lo, hi)) {
      for (let k = 0; k < span; k++) out.push({ d: addDays(startDay, k), n: e.name });
    }
  }
  const seen = new Set();
  return out.filter((x) => { const key = x.d + '|' + x.n; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => a.d.localeCompare(b.d));
}

function occurrences(e, lo, hi) {
  if (!e.rrule) return [e.start.day];
  const r = Object.fromEntries(e.rrule.split(';').map((kvp) => kvp.split('=')));
  const freq = r.FREQ, interval = +(r.INTERVAL || 1);
  const count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? icsDate(r.UNTIL, '').day : null;
  const byday = r.BYDAY ? r.BYDAY.split(',').map((x) => WD[x.slice(-2)]).filter((x) => x != null) : null;
  const days = [];
  let n = 0;
  const startD = parseD(e.start.day);
  for (let i = 0; i < 800 && n < count; i++) {
    const d = new Date(startD);
    let candidates = [];
    if (freq === 'DAILY') { d.setDate(d.getDate() + i * interval); candidates = [dstr(d)]; }
    else if (freq === 'WEEKLY') {
      d.setDate(d.getDate() + i * 7 * interval);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      candidates = (byday || [startD.getDay()]).map((wd) => { const x = new Date(weekStart); x.setDate(weekStart.getDate() + wd); return dstr(x); })
        .filter((x) => x >= e.start.day).sort();
    } else if (freq === 'MONTHLY') { d.setMonth(d.getMonth() + i * interval); candidates = [dstr(d)]; }
    else return [e.start.day];
    for (const c of candidates) {
      if (until && c > until) return days;
      if (n >= count) break;
      n++;
      if (c > hi) return days;
      if (c >= lo && !e.ex.includes(c)) days.push(c);
    }
  }
  return days;
}

// ---------- day type ----------
export function dayType(date) {
  const r = rota();
  if (r.manual[date]) return r.manual[date];
  if (!r.events.length) return null;
  const names = r.events.filter((e) => e.d === date).map((e) => e.n);
  const labels = names.map((n) => r.labels[n]).filter(Boolean);
  if (labels.length) return PRIORITY.find((p) => labels.includes(p));
  if (names.length) return null; // shift names not labelled yet
  const first = r.events[0].d, last = r.events[r.events.length - 1].d;
  return date >= first && date <= last ? 'off' : null;
}

export function unlabelled() {
  const r = rota();
  return [...new Set(r.events.map((e) => e.n))].filter((n) => !r.labels[n]);
}

function setEvents(events, source) {
  const r = rota();
  const before = JSON.stringify(r.events);
  r.events = events;
  r.source = source;
  r.fetchedAt = Date.now();
  r.status = 'ok';
  r.error = null;
  saveRota(r);
  return before !== JSON.stringify(events);
}

// Read the feed each time the app opens. Returns true if anything changed.
export async function refreshRota() {
  const r = rota();
  if (!r.url) return false;
  const url = r.url.trim().replace(/^webcal:\/\//i, 'https://');
  let res;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    res = await fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal });
    clearTimeout(timer);
  } catch {
    const rr = rota();
    if (!navigator.onLine) { rr.status = 'offline'; saveRota(rr); return false; }
    rr.status = 'blocked';
    rr.error = null;
    saveRota(rr);
    return true;
  }
  const rr = rota();
  if (!res.ok) {
    rr.status = 'error';
    rr.error = `The calendar site answered with error ${res.status}.`;
    saveRota(rr);
    return true;
  }
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/.test(text)) {
    rr.status = 'error';
    rr.error = 'That link did not return a calendar (.ics) file.';
    saveRota(rr);
    return true;
  }
  const changed = setEvents(parseICS(text), 'url');
  return changed || rr.status !== 'ok';
}

async function importIcs(redraw) {
  const [f] = await pickFiles('.ics,text/calendar', false);
  if (!f) return;
  const text = await f.text();
  if (!/BEGIN:VCALENDAR/.test(text)) { toast('That file is not a calendar (.ics) file.'); return; }
  const events = parseICS(text);
  setEvents(events, 'file');
  const r = rota();
  r.url = ''; // the file replaces a link the browser could not read
  saveRota(r);
  toast(`Rota imported: ${plural(events.length, 'day')} with shifts.`);
  redraw();
}

// ---------- UI pieces ----------
function labelChips(name, redraw) {
  const r = rota();
  return h('div', { class: 'chips' }, LABELS.map((l) =>
    h('button', {
      class: 'chip big' + (r.labels[name] === l ? ' on' : ''),
      onclick: () => { const rr = rota(); rr.labels[name] = l; saveRota(rr); redraw(); },
    }, SHORT[l])));
}

// Shown on Today: new shift names to label, or a blocked link.
export function rotaNotices(redraw) {
  const r = rota();
  const out = [];
  const names = unlabelled();
  if (names.length) {
    out.push(h('section', { class: 'card' },
      h('h2', null, names.length === 1 ? 'New shift name in your rota' : 'New shift names in your rota'),
      h('p', { class: 'muted small' }, 'Tap what each one means. You will only be asked once.'),
      names.map((n) => h('div', { class: 'shiftrow' }, h('b', null, n), labelChips(n, redraw)))));
  }
  if (r.url && (r.status === 'blocked' || r.status === 'error')) {
    out.push(h('div', { class: 'banner warn' },
      h('span', null, r.status === 'blocked' ? 'Your browser could not read your rota link directly.' : r.error),
      h('button', { class: 'btn', onclick: () => { location.hash = '#/settings'; } }, 'Fix')));
  }
  return out;
}

let calMonth = null;
let brush = 'work';
let calOpen = false;

export function rotaSettings(redraw) {
  const r = rota();
  const url = h('input', { class: 'inp', type: 'url', inputmode: 'url', placeholder: 'https://… or webcal://… (.ics link)', value: r.url || '', autocomplete: 'off' });
  const status = [];
  if (r.url && r.source === 'url' && r.status === 'ok') status.push(h('div', { class: 'status ok' }, `Read ${r.fetchedAt ? 'at ' + new Date(r.fetchedAt).toLocaleString() : ''}: ${plural(r.events.length, 'shift day')}. It is read again each time the app opens.`));
  if (r.status === 'blocked') {
    status.push(h('div', { class: 'status bad' },
      h('b', null, 'Your browser blocked reading this link directly. '),
      'The calendar site does not allow web apps to read it (a browser safety rule), and this app never sends your link through another service. ',
      'Instead, download the calendar as an .ics file (open the link in Chrome, or use your rota site’s “export” or “download” option) and import it below.'));
  }
  if (r.status === 'error') status.push(h('div', { class: 'status bad' }, r.error));
  if (r.status === 'offline') status.push(h('div', { class: 'status warn' }, 'Offline: using the last copy of your rota.'));
  if (r.source === 'file' && r.events.length) status.push(h('div', { class: 'status ok' }, `Using an imported .ics file: ${plural(r.events.length, 'shift day')}. Import a new one when your rota changes.`));

  const names = [...new Set(r.events.map((e) => e.n))];
  return h('section', { class: 'card' },
    h('h2', null, 'Rota'),
    h('p', { class: 'muted small' }, 'Short tasks on work days, long days and nights; longer blocks on days off; Quick 5 only on days away.'),
    h('label', { class: 'field' }, h('span', null, 'Calendar link (iCal feed)'), url),
    h('div', { class: 'row2' },
      h('button', { class: 'btn primary', onclick: async () => {
        const rr = rota();
        rr.url = url.value.trim();
        saveRota(rr);
        if (!rr.url) { redraw(); return; }
        toast('Reading your rota…');
        await refreshRota();
        const st = rota().status;
        toast(st === 'ok' ? 'Rota read.' : st === 'blocked' ? 'Blocked by the browser. See below.' : 'Could not read the rota.');
        redraw();
      } }, 'Save and read'),
      h('button', { class: 'btn', onclick: () => importIcs(redraw) }, 'Import .ics file')),
    status,
    names.length ? h('div', null, h('h3', { class: 'lbl' }, 'Shift names'),
      names.map((n) => h('div', { class: 'shiftrow' }, h('b', null, n), labelChips(n, redraw)))) : null,
    h('details', { class: 'help', open: calOpen || r.status === 'blocked', ontoggle: (e) => { calOpen = e.target.open; } },
      h('summary', null, 'Or tap days on a calendar'),
      manualCalendar(redraw)),
    r.url || r.events.length || Object.keys(r.manual).length ? h('button', { class: 'btn ghost danger-text', onclick: () => {
      saveRota({ url: '', events: [], labels: r.labels, manual: {}, status: null });
      toast('Rota removed');
      redraw();
    } }, 'Remove rota') : null);
}

function manualCalendar(redraw) {
  const r = rota();
  const t = today();
  if (!calMonth) calMonth = t.slice(0, 7);
  const [y, m] = calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const daysIn = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(h('span'));
  for (let d = 1; d <= daysIn; d++) {
    const ds = dstr(new Date(y, m - 1, d));
    const lab = r.manual[ds] || dayType(ds);
    cells.push(h('button', {
      class: (lab ? 'l-' + lab : '') + (ds === t ? ' today' : ''),
      'aria-label': niceDate(ds) + (lab ? ' ' + DAY_LABEL[lab] : ''),
      onclick: () => {
        const rr = rota();
        if (brush === 'clear') delete rr.manual[ds]; else rr.manual[ds] = brush;
        saveRota(rr);
        redraw();
      },
    }, String(d), lab ? h('small', null, SHORT[lab]) : null));
  }
  const shift = (k) => { const d = new Date(y, m - 1 + k, 1); calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; redraw(); };
  return h('div', { class: 'field' },
    h('p', { class: 'muted small' }, 'Pick a type, then tap days. Tapped days override the rota.'),
    h('div', { class: 'chips' }, [...LABELS, 'clear'].map((l) =>
      h('button', { class: 'chip big' + (brush === l ? ' on' : ''), onclick: () => { brush = l; redraw(); } }, l === 'clear' ? 'Clear' : SHORT[l]))),
    h('div', { class: 'calnav' },
      h('button', { class: 'btn', 'aria-label': 'Previous month', onclick: () => shift(-1) }, '‹'),
      h('b', null, first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })),
      h('button', { class: 'btn', 'aria-label': 'Next month', onclick: () => shift(1) }, '›')),
    h('div', { class: 'cal' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => h('span', { class: 'dow' }, d)), cells));
}
