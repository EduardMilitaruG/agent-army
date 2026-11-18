#!/usr/bin/env node
// Read-only: your own commits across jobfy-qa/repos/* since a date.
//   node tools/commits.mjs                 last 7 days
//   node tools/commits.mjs --since 2026-11-01
//   node tools/commits.mjs --days 30 --repo warehouse-simulator
// Only runs `git config` and `git log` (no shell), so bots can be allowed this one command.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPOS = resolve(import.meta.dirname, '..', '..', 'jobfy-qa', 'repos');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

let since = opt('since');
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) { console.error('--since must be YYYY-MM-DD'); process.exit(2); }
if (!since) {
  const days = Number(opt('days') || 7);
  since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}
const only = opt('repo');
if (only && !/^[\w.-]+$/.test(only)) { console.error('bad --repo'); process.exit(2); }

const git = (cwd, ...a) => { try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

let total = 0;
const out = [];
for (const name of readdirSync(REPOS).sort()) {
  if (only && name !== only) continue;
  const dir = join(REPOS, name);
  if (!existsSync(join(dir, '.git'))) continue;
  const email = git(dir, 'config', 'user.email');
  const log = git(dir, 'log', '--all', `--since=${since}`, ...(email ? [`--author=${email}`] : []), '--no-merges', '--date=short', '--pretty=format:%ad %h %s');
  const lines = log ? log.split('\n') : [];
  total += lines.length;
  if (lines.length) out.push(`## ${name} (${lines.length})\n${lines.map((l) => `- ${l}`).join('\n')}`);
}
console.log(`# Commits since ${since}: ${total}\n`);
console.log(out.join('\n\n') || '(none)');
