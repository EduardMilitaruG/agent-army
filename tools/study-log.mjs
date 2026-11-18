#!/usr/bin/env node
// The Tutor's study log: agent-army/data/study-log.csv (date,topic,score).
//   node tools/study-log.mjs add python 7      append today's drill (score 0-10)
//   node tools/study-log.mjs stats [--days 7]  streak, sessions, average per topic
//   node tools/study-log.mjs next              the topic practised least recently
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const FILE = resolve(import.meta.dirname, '..', 'data', 'study-log.csv');
const TOPICS = ['dev', 'qa', 'ai', 'python', 'sql', 'linux', 'istqb'];
const today = () => new Date().toLocaleDateString('sv-SE'); // local YYYY-MM-DD

function rows() {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf8').trim().split('\n').slice(1).filter(Boolean).map((l) => {
    const [date, topic, score] = l.split(',');
    return { date, topic, score: Number(score) };
  });
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'add') {
  const [topic, scoreRaw] = rest;
  const score = Number(scoreRaw);
  if (!TOPICS.includes(topic)) { console.error(`topic must be one of: ${TOPICS.join(', ')}`); process.exit(2); }
  if (!Number.isInteger(score) || score < 0 || score > 10) { console.error('score must be an integer 0-10'); process.exit(2); }
  mkdirSync(dirname(FILE), { recursive: true });
  if (!existsSync(FILE)) writeFileSync(FILE, 'date,topic,score\n');
  appendFileSync(FILE, `${today()},${topic},${score}\n`);
  console.log(`Logged ${today()} ${topic} ${score}/10`);
} else if (cmd === 'stats') {
  const i = rest.indexOf('--days');
  const days = i >= 0 ? Number(rest[i + 1]) : 7;
  const all = rows();
  const dates = new Set(all.map((r) => r.date));
  // Streak: consecutive days with a drill, ending today (or yesterday if today isn't done yet).
  let streak = 0;
  const d = new Date();
  if (!dates.has(today())) d.setDate(d.getDate() - 1);
  while (dates.has(d.toLocaleDateString('sv-SE'))) { streak++; d.setDate(d.getDate() - 1); }
  const from = new Date(Date.now() - (days - 1) * 864e5).toLocaleDateString('sv-SE');
  const recent = all.filter((r) => r.date >= from);
  const daysDone = new Set(recent.map((r) => r.date)).size;
  console.log(`Study log (${FILE})`);
  console.log(`Current streak: ${streak} day(s)`);
  console.log(`Last ${days} days: ${daysDone}/${days} days with a drill, ${recent.length} drill(s)`);
  for (const t of TOPICS) {
    const s = recent.filter((r) => r.topic === t);
    if (s.length) console.log(`  ${t}: ${s.length} drill(s), average ${(s.reduce((a, r) => a + r.score, 0) / s.length).toFixed(1)}/10`);
  }
} else if (cmd === 'next') {
  const all = rows();
  const last = Object.fromEntries(TOPICS.map((t) => [t, all.filter((r) => r.topic === t).map((r) => r.date).sort().pop() || '']));
  console.log(TOPICS.slice().sort((a, b) => last[a].localeCompare(last[b]))[0]);
} else {
  console.error('usage: study-log.mjs add <topic> <score> | stats [--days N] | next');
  process.exit(2);
}
