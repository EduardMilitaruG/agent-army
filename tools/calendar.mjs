#!/usr/bin/env node
// The user's calendar, without giving any bot write access to their account.
//   node tools/calendar.mjs upcoming [--days 7]          read events from his private iCal link (set in Settings)
//   node tools/calendar.mjs ics "Interview: Acme" 2026-11-25 10:00 60 ["Video call link or place"]
//        -> writes an .ics file he opens with a double click to add the event himself
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : d; };
const [cmd, ...rest] = args;

function settings() { try { return JSON.parse(readFileSync(resolve(ROOT, 'data', 'secrets', 'settings.json'), 'utf8')); } catch { return {}; } }

// Minimal iCal parser: VEVENT with DTSTART/DTEND/SUMMARY/LOCATION, unfolded lines, all-day and UTC/local times.
function parseIcs(text) {
  const lines = text.replace(/\r\n[ \t]/g, '').split(/\r?\n/);
  const events = []; let ev = null;
  const when = (v, params) => {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return null;
    const [, y, mo, d, h = '00', mi = '00', s = '00', z] = m;
    return { date: z ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: !m[4] || /VALUE=DATE/.test(params) };
  };
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') ev = {};
    else if (l === 'END:VEVENT') { if (ev?.start) events.push(ev); ev = null; }
    else if (ev) {
      const i = l.indexOf(':'); if (i < 0) continue;
      const [key, ...params] = l.slice(0, i).split(';'); const val = l.slice(i + 1);
      if (key === 'DTSTART') ev.start = when(val, params.join(';'));
      else if (key === 'DTEND') ev.end = when(val, params.join(';'));
      else if (key === 'SUMMARY') ev.title = val.replace(/\\,/g, ',').replace(/\\n/g, ' ');
      else if (key === 'LOCATION') ev.where = val.replace(/\\,/g, ',');
      else if (key === 'RRULE') ev.recurring = true;
    }
  }
  return events;
}

if (cmd === 'upcoming') {
  const days = Number(opt('days', 7));
  const url = settings().calendar?.icsUrl;
  if (!url) { console.log('No calendar connected. The user can add their private iCal link in the dashboard: Settings > Calendar.'); process.exit(0); }
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) { console.error(`Calendar link answered HTTP ${res.status}.`); process.exit(1); }
  const now = new Date(); const until = new Date(Date.now() + days * 864e5);
  const evs = parseIcs(await res.text()).filter((e) => e.start.date >= new Date(now.toDateString()) && e.start.date <= until).sort((a, b) => a.start.date - b.start.date);
  if (!evs.length) console.log(`No events in the next ${days} days (recurring events are not expanded).`);
  for (const e of evs) {
    const d = e.start.date;
    const time = e.start.allDay ? 'all day' : d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    console.log(`- ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}: ${e.title || '(no title)'}${e.where ? ` @ ${e.where}` : ''}`);
  }
} else if (cmd === 'ics') {
  const [title, date, time, minutes = '60', where = ''] = rest;
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '') || !/^\d{1,4}$/.test(minutes)) {
    console.error('usage: calendar.mjs ics "<title>" YYYY-MM-DD HH:MM [minutes] ["place or link"]'); process.exit(2);
  }
  const start = new Date(`${date}T${time}:00`); const end = new Date(start.getTime() + Number(minutes) * 60000);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Agent Army//EN', 'BEGIN:VEVENT', `UID:${Date.now()}@agent-army`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`, `SUMMARY:${esc(title)}`, where ? `LOCATION:${esc(where)}` : '', 'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', `DESCRIPTION:${esc(title)}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
  const dir = resolve(ROOT, 'data', 'calendar'); mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${date}-${title.replace(/[^\w-]+/g, '-').slice(0, 40)}.ics`);
  writeFileSync(file, ics + '\r\n');
  console.log(`Created ${file.replace(/\\/g, '/')}: The user double-clicks it to add "${title}" (${date} ${time}, ${minutes} min, reminder 30 min before) to their calendar.`);
} else {
  console.error('usage: calendar.mjs upcoming [--days N] | ics "<title>" YYYY-MM-DD HH:MM [minutes] ["place"]');
  process.exit(2);
}
