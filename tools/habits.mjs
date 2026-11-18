#!/usr/bin/env node
// The user's habit log: agent-army/data/habits.csv (date,habit,note). Same file the dashboard writes.
//   node tools/habits.mjs add gym "legs"      log a habit for today (habit = one short word)
//   node tools/habits.mjs stats [--days 7]    counts per habit
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = resolve(import.meta.dirname, '..', 'data', 'habits.csv');
const today = () => new Date().toLocaleDateString('sv-SE');
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'add') {
  const [habit, ...note] = rest;
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(habit || '')) { console.error('habit must be one short lowercase word: gym, run, reading, sleep...'); process.exit(2); }
  if (!existsSync(FILE)) writeFileSync(FILE, 'date,habit,note\n');
  appendFileSync(FILE, `${today()},${habit},${note.join(' ').replace(/[\r\n,]+/g, ' ').trim().slice(0, 120)}\n`);
  console.log(`Logged ${habit} for ${today()}`);
} else if (cmd === 'stats') {
  const i = rest.indexOf('--days');
  const days = i >= 0 ? Number(rest[i + 1]) : 7;
  const from = new Date(Date.now() - (days - 1) * 864e5).toLocaleDateString('sv-SE');
  const rows = existsSync(FILE) ? readFileSync(FILE, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(',')) : [];
  const recent = rows.filter(([d]) => d >= from);
  const counts = {};
  for (const [, h] of recent) counts[h] = (counts[h] || 0) + 1;
  console.log(`Habits, last ${days} days: ${Object.entries(counts).map(([h, n]) => `${h} ${n}`).join(', ') || 'nothing logged'}`);
  for (const [d, h, n] of recent.slice(-10)) console.log(`  ${d} ${h}${n ? ` (${n})` : ''}`);
} else {
  console.error('usage: habits.mjs add <habit> [note] | stats [--days N]');
  process.exit(2);
}
