// Everything outside the bots themselves: the Dossier connection (health, auto-start, MCP calls),
// the habit and study logs, the schedule, and the "Today" summary the dashboard home shows.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, exec, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const DOSSIER_DIR = path.resolve(ROOT, '..', 'jobfy-qa', 'dossier');
const DOSSIER_URL = 'http://localhost:3000';
const DOCKER_DESKTOP = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const localDate = (d = new Date()) => d.toLocaleDateString('sv-SE'); // YYYY-MM-DD in local time
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, timeout: 120000, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }));
});

// ---------- Dossier ----------
async function dossierHealthy() {
  try { return (await fetch(`${DOSSIER_URL}/api/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}
const dockerUp = async () => (await run('docker', ['info'], { timeout: 15000 })).ok;

let starting = null;
/** Starts Docker Desktop (if needed) and Dossier's containers, and waits until Dossier answers. */
function ensureDossier(log = () => {}) {
  if (starting) return starting;
  starting = (async () => {
    if (await dossierHealthy()) return true;
    if (!(await dockerUp())) {
      if (!fs.existsSync(DOCKER_DESKTOP)) throw new Error('Docker Desktop is not installed where expected.');
      log('Starting Docker Desktop…');
      spawn(DOCKER_DESKTOP, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      for (let i = 0; i < 60 && !(await dockerUp()); i++) await sleep(4000);
      if (!(await dockerUp())) throw new Error('Docker Desktop did not start within 4 minutes.');
    }
    log('Starting Dossier…');
    const up = await run('docker', ['compose', 'up', '-d'], { cwd: DOSSIER_DIR, timeout: 240000 });
    if (!up.ok) throw new Error(`docker compose up failed: ${up.stderr.trim().split('\n').pop()}`);
    for (let i = 0; i < 60 && !(await dossierHealthy()); i++) await sleep(3000);
    if (!(await dossierHealthy())) throw new Error('Dossier did not become healthy within 3 minutes.');
    log('Dossier is up.');
    return true;
  })().finally(() => { starting = null; });
  return starting;
}

/** Calls one Dossier MCP tool over HTTP with the same login Claude Code uses. Returns parsed JSON (or text). */
async function dossierCall(tool, args = {}) {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).mcpServers?.dossier;
  if (!cfg?.url) throw new Error('Dossier MCP is not configured in Claude Code');
  let headers = cfg.headers || {};
  if (cfg.headersHelper) {
    headers = await new Promise((resolve, reject) => exec(cfg.headersHelper, { windowsHide: true, timeout: 20000 }, (err, out) => {
      if (err) return reject(new Error('Dossier login helper failed: run its login.mjs again'));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('Dossier login helper returned no headers')); }
    }));
  }
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await r.text();
  const line = body.split('\n').find((l) => l.startsWith('data:'));
  const msg = JSON.parse(line ? line.slice(5) : body);
  if (msg.error) throw new Error(msg.error.message);
  const text = (msg.result?.content || []).map((c) => c.text || '').join('');
  if (msg.result?.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}

// ---------- CSV logs (study by the Tutor, habits by you / the Chief of Staff) ----------
function readCsv(file) {
  try {
    const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    const cols = head.split(',');
    return lines.filter(Boolean).map((l) => {
      const parts = l.split(',');
      return Object.fromEntries(cols.map((c, i) => [c, i === cols.length - 1 ? parts.slice(i).join(',') : parts[i]]));
    });
  } catch { return []; }
}
const HABITS = path.join(DATA, 'habits.csv');
function addHabit(habit, note = '') {
  const h = String(habit || '').toLowerCase().trim();
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(h)) throw new Error('habit must be a short word, e.g. gym, run, reading');
  if (!fs.existsSync(HABITS)) fs.writeFileSync(HABITS, 'date,habit,note\n');
  fs.appendFileSync(HABITS, `${localDate()},${h},${String(note).replace(/[\r\n,]+/g, ' ').trim().slice(0, 120)}\n`);
  return { date: localDate(), habit: h };
}
function weekStart(d = new Date()) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  return x;
}
function studySummary() {
  const rows = readCsv(path.join(DATA, 'study-log.csv'));
  const dates = new Set(rows.map((r) => r.date));
  let streak = 0; const d = new Date();
  if (!dates.has(localDate(d))) d.setDate(d.getDate() - 1);
  while (dates.has(localDate(d))) { streak++; d.setDate(d.getDate() - 1); }
  const from = localDate(weekStart());
  const week = rows.filter((r) => r.date >= from);
  return { streak, doneToday: dates.has(localDate()), daysThisWeek: new Set(week.map((r) => r.date)).size, last: rows.slice(-5).reverse() };
}
function habitSummary() {
  const rows = readCsv(HABITS);
  const from = localDate(weekStart());
  const week = rows.filter((r) => r.date >= from);
  const counts = {};
  for (const r of week) counts[r.habit] = (counts[r.habit] || 0) + 1;
  return { week: counts, gymThisWeek: counts.gym || 0, last: rows.slice(-5).reverse() };
}

// ---------- schedule (scheduler/tasks.json) ----------
const DAY = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
function nextRuns(limit = 6) {
  let tasks = [];
  try { tasks = JSON.parse(fs.readFileSync(path.join(ROOT, 'scheduler', 'tasks.json'), 'utf8')); } catch { return []; }
  try { // only bots that exist and are turned on
    const active = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'bots.json'), 'utf8')).filter((b) => !b.disabled).map((b) => b.id));
    tasks = tasks.filter((t) => active.has(t.bot));
  } catch { /* keep all */ }
  let paused = false;
  try { paused = fs.existsSync(path.join(ROOT, 'scheduler', 'PAUSED')); } catch { /* ignore */ }
  const now = new Date();
  const out = [];
  for (const t of tasks) {
    const [h, m] = t.at.split(':').map(Number);
    for (let i = 0; i < 8; i++) {
      const d = new Date(now); d.setDate(now.getDate() + i); d.setHours(h, m, 0, 0);
      const ok = t.days.includes('daily') || t.days.some((day) => DAY[day] === d.getDay());
      if (ok && d > now) { out.push({ id: t.id, bot: t.bot, prompt: t.prompt, at: d.getTime() }); break; }
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, limit).map((r) => ({ ...r, paused }));
}
function recentRuns(limit = 8) {
  try {
    return fs.readFileSync(path.join(DATA, 'runs', 'runs.log'), 'utf8').trim().split(/\r?\n/).slice(-limit).reverse().map((l) => {
      const [time, bot, status, duration, file] = l.replace(/^\uFEFF/, '').split('\t');
      return { time, bot, status, duration, file };
    });
  } catch { return []; }
}

/** The Chief of Staff's most recent saved brief (data/briefs/YYYY-MM-DD.md). */
function latestBrief() {
  try {
    const dir = path.join(DATA, 'briefs');
    const file = fs.readdirSync(dir).filter((f) => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort().pop();
    if (!file) return null;
    const full = path.join(dir, file);
    return { date: file.slice(0, 10), at: fs.statSync(full).mtimeMs, text: fs.readFileSync(full, 'utf8').replace(/^﻿/, '').replace(/^# .*\n+/, '') };
  } catch { return null; }
}

// ---------- Today ----------
let cache = { at: 0, data: null };
async function today(force = false) {
  if (!force && cache.data && Date.now() - cache.at < 30000) return cache.data;
  const online = await dossierHealthy();
  let jobs = { online, error: null, drafts: [], sentThisWeek: [], replies: [] };
  if (online) {
    try {
      const apps = await dossierCall('list_applications', { limit: 100 });
      const from = localDate(weekStart());
      const list = Array.isArray(apps) ? apps : [];
      jobs.drafts = list.filter((a) => a.status === 'Draft').map((a) => ({ id: a.id, company: a.company, role: a.role, updated: a.updated, link: a.link }));
      jobs.sentThisWeek = list.filter((a) => a.status !== 'Draft' && a.updated >= from).map((a) => ({ company: a.company, role: a.role, status: a.status, updated: a.updated }));
      jobs.replies = list.filter((a) => ['Screening', 'Interview', 'Offer'].includes(a.status)).map((a) => ({ id: a.id, company: a.company, role: a.role, status: a.status, link: a.link }));
    } catch (e) { jobs.error = e.message; }
  }
  const data = { at: Date.now(), date: localDate(), jobs, study: studySummary(), habits: habitSummary(), next: nextRuns(), runs: recentRuns(), brief: latestBrief() };
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { ensureDossier, dossierHealthy, dossierCall, addHabit, today, nextRuns, recentRuns, studySummary, habitSummary, DATA };
