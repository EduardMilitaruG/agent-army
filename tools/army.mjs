#!/usr/bin/env node
// The Chief of Staff's handle on the rest of the team (talks to the local Agent Army server).
//   node tools/army.mjs bots                         who is on the team
//   node tools/army.mjs ask <bot> <task text...>     give a bot a task, wait for it (15 min max), print its answer
//   node tools/army.mjs today                        jobs (Dossier), study, habits, schedule, recent runs
//   node tools/army.mjs runs [--days 1]              results of recent scheduled runs
//   node tools/army.mjs working                      bots running or queued right now
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.ARMY_URL || 'http://127.0.0.1:4777';
const RUNS = resolve(import.meta.dirname, '..', 'data', 'runs');
const [cmd, ...rest] = process.argv.slice(2);
const api = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { ...opts, headers: { 'content-type': 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
};
const fail = (m) => { console.error(m); process.exit(2); };

try {
  if (cmd === 'bots') {
    for (const b of await api('/api/bots')) console.log(`${b.id.padEnd(10)} ${b.name}: ${b.description}`);
  } else if (cmd === 'ask') {
    const [bot, ...words] = rest;
    const task = words.join(' ').trim();
    if (!bot || !task) fail('usage: army.mjs ask <bot> <task>');
    if (bot === 'chief') fail('The Chief of Staff cannot delegate to itself.');
    const bots = await api('/api/bots');
    const target = bots.find((b) => b.id === bot);
    if (!target) fail(`no bot "${bot}". Team: ${bots.map((b) => b.id).join(', ')}`);
    const a = await api('/api/agents', { method: 'POST', body: JSON.stringify({ botId: bot, prompt: task, parentId: process.env.ARMY_AGENT_ID || null, name: `From Chief: ${task.slice(0, 50)}` }) });
    const deadline = Date.now() + 15 * 60_000;
    let s = a;
    while (['queued', 'running', 'idle'].includes(s.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      s = await api(`/api/agents/${a.id}`);
    }
    if (['queued', 'running'].includes(s.status)) {
      console.log(`${target.name} is still working after 15 min (chat ${a.id}). Tell the user to check it in the dashboard.`);
    } else {
      console.log(`[${target.name}: ${s.status}, chat ${a.id}]\n${s.lastResult || '(no answer)'}`);
    }
  } else if (cmd === 'today') {
    const t = await api('/api/today?fresh');
    const j = t.jobs;
    console.log(`# Today ${t.date}`);
    console.log(`## Jobs (Dossier ${j.online ? 'online' : 'OFFLINE'})${j.error ? ` error: ${j.error}` : ''}`);
    console.log(`Sent this week: ${j.sentThisWeek.length}/5${j.sentThisWeek.map((a) => `\n- ${a.company}: ${a.role} (${a.status}, ${a.updated})`).join('')}`);
    console.log(`Drafts waiting for review: ${j.drafts.length}${j.drafts.map((a) => `\n- ${a.company}: ${a.role} (updated ${a.updated})`).join('')}`);
    console.log(`Replies in progress: ${j.replies.length}${j.replies.map((a) => `\n- ${a.company}: ${a.role} (${a.status})`).join('')}`);
    console.log(`## Study\nStreak ${t.study.streak} day(s), drill done today: ${t.study.doneToday ? 'yes' : 'no'}, days this week: ${t.study.daysThisWeek}/7`);
    console.log(`## Habits this week\n${Object.entries(t.habits.week).map(([h, n]) => `${h}: ${n}`).join(', ') || 'nothing logged'}`);
    console.log(`## Next scheduled runs${t.next.map((n) => `\n- ${new Date(n.at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} ${n.bot}: ${n.prompt}`).join('')}`);
    console.log(`## Recent runs${t.runs.map((r) => `\n- ${r.time} ${r.bot} ${r.status}`).join('')}`);
  } else if (cmd === 'runs') {
    const i = rest.indexOf('--days');
    const days = i >= 0 ? Number(rest[i + 1]) : 1;
    const from = new Date(Date.now() - days * 864e5);
    const log = existsSync(join(RUNS, 'runs.log')) ? readFileSync(join(RUNS, 'runs.log'), 'utf8').trim().split(/\r?\n/) : [];
    const rows = log.map((l) => l.replace(/^﻿/, '').split('\t')).filter(([t]) => new Date(t.replace(' ', 'T')) >= from);
    if (!rows.length) console.log(`No scheduled runs in the last ${days} day(s).`);
    for (const [time, bot, status, , file] of rows) {
      let result = '';
      try { result = readFileSync(join(RUNS, file), 'utf8').split('## Result')[1]?.trim() || ''; } catch { /* missing */ }
      console.log(`\n### ${time} ${bot} (${status})\n${result.slice(0, 1500)}`);
    }
  } else if (cmd === 'working') {
    const busy = (await api('/api/agents')).filter((a) => ['running', 'queued'].includes(a.status));
    console.log(busy.length ? busy.map((a) => `- ${a.botId || a.role} ${a.status}: ${a.name}`).join('\n') : 'Nobody is working right now.');
  } else {
    fail('usage: army.mjs bots | ask <bot> <task> | today | runs [--days N] | working');
  }
} catch (e) {
  console.error(`Agent Army error: ${e.message}`);
  process.exit(1);
}
