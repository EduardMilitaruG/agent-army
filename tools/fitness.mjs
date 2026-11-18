#!/usr/bin/env node
// The Coach's training and body log (agent-army/data/fitness/).
//   node tools/fitness.mjs workout "push day: 4x8 push-ups, 3x6 pike push-ups, 3x10 dips" [--minutes 45]
//   node tools/fitness.mjs weight 72.4 [--waist 80]
//   node tools/fitness.mjs stats [--days 28]
// Workouts also count as "gym" in the habit log, so Today and the Chief see them.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(import.meta.dirname, '..', 'data', 'fitness');
const WORKOUTS = resolve(DIR, 'workouts.csv');
const BODY = resolve(DIR, 'body.csv');
const HABITS = resolve(import.meta.dirname, '..', 'data', 'habits.csv');
const today = () => new Date().toLocaleDateString('sv-SE');
const clean = (s) => String(s || '').replace(/[\r\n,]+/g, ' ').trim().slice(0, 300);
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const append = (file, head, line) => { mkdirSync(DIR, { recursive: true }); if (!existsSync(file)) writeFileSync(file, head + '\n'); appendFileSync(file, line + '\n'); };
const rows = (file) => existsSync(file) ? readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(',')) : [];
const [cmd] = args.splice(0, 1);

if (cmd === 'workout') {
  const minutes = opt('minutes');
  const what = clean(args.join(' '));
  if (!what) { console.error('usage: fitness.mjs workout "<what you did>" [--minutes N]'); process.exit(2); }
  if (minutes && !/^\d{1,3}$/.test(minutes)) { console.error('--minutes must be a number'); process.exit(2); }
  append(WORKOUTS, 'date,minutes,workout', `${today()},${minutes || ''},${what}`);
  if (!existsSync(HABITS)) writeFileSync(HABITS, 'date,habit,note\n');
  appendFileSync(HABITS, `${today()},gym,${what.slice(0, 60)}\n`);
  console.log(`Logged workout for ${today()}${minutes ? ` (${minutes} min)` : ''}.`);
} else if (cmd === 'weight') {
  const waist = opt('waist');
  const kg = args[0];
  if (!/^\d{2,3}(\.\d)?$/.test(kg || '')) { console.error('usage: fitness.mjs weight <kg, e.g. 72.4> [--waist cm]'); process.exit(2); }
  if (waist && !/^\d{2,3}(\.\d)?$/.test(waist)) { console.error('--waist must be cm, e.g. 80'); process.exit(2); }
  append(BODY, 'date,weight_kg,waist_cm', `${today()},${kg},${waist || ''}`);
  console.log(`Logged ${kg} kg${waist ? `, waist ${waist} cm` : ''} for ${today()}.`);
} else if (cmd === 'stats') {
  const days = Number(opt('days') || 28);
  const from = new Date(Date.now() - (days - 1) * 864e5).toLocaleDateString('sv-SE');
  const w = rows(WORKOUTS).filter(([d]) => d >= from);
  const b = rows(BODY).filter(([d]) => d >= from);
  const weekFrom = new Date(Date.now() - 6 * 864e5).toLocaleDateString('sv-SE');
  console.log(`Last ${days} days: ${w.length} workout(s), ${w.filter(([d]) => d >= weekFrom).length} in the last 7 days.`);
  for (const [d, m, what] of w.slice(-8)) console.log(`  ${d}${m ? ` ${m}min` : ''}: ${what}`);
  if (b.length) {
    const first = b[0], last = b[b.length - 1];
    console.log(`Bodyweight: ${first[1]} kg (${first[0]}) -> ${last[1]} kg (${last[0]})${last[2] ? `, waist ${last[2]} cm` : ''}`);
  } else console.log('Bodyweight: nothing logged yet.');
} else {
  console.error('usage: fitness.mjs workout "<text>" [--minutes N] | weight <kg> [--waist cm] | stats [--days N]');
  process.exit(2);
}
