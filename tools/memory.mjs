#!/usr/bin/env node
// Shared memory about the user (agent-army/data/memory/about-me.md). Every bot sees it in its prompt.
//   node tools/memory.mjs add "Body and training" "Has a pull-up bar since Nov 2026"
//   node tools/memory.mjs show
//   node tools/memory.mjs sections
// Refuses secrets: passwords, ID numbers (DNI/NIE/passport), bank details, card numbers.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const FILE = resolve(import.meta.dirname, '..', 'data', 'memory', 'about-me.md');
const BACKUPS = resolve(import.meta.dirname, '..', 'data', 'backups');
const MAX = 8000; // the whole file goes into every bot's prompt, so keep it compact

const SENSITIVE = [
  [/\b\d{8}[A-HJ-NP-TV-Z]\b/i, 'a Spanish DNI'],
  [/\b[XYZ]\d{7}[A-HJ-NP-TV-Z]\b/i, 'a Spanish NIE'],
  [/\b[A-Z]{3}\d{6}\b/, 'a passport number'],
  [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/, 'an IBAN'],
  [/\b(?:\d[ -]?){13,19}\b/, 'a card number'],
  [/\b\d{13}\b/, 'a national ID number'],
  [/(password|contraseña|parola|passwd|pin code|api[_ -]?key|token)\s*[:=]/i, 'a password or secret'],
];

const [cmd, ...rest] = process.argv.slice(2);
const read = () => (existsSync(FILE) ? readFileSync(FILE, 'utf8') : '# About me\n');

if (cmd === 'note') {
  // A bot's own private notes (only that bot sees them): data/memory/bots/<bot>.md
  const bot = process.env.ARMY_BOT_ID;
  if (!bot || !/^[a-z0-9-]+$/.test(bot)) { console.error('Notes only work inside an Agent Army bot.'); process.exit(2); }
  const fact = rest.join(' ').replace(/\s+/g, ' ').trim();
  if (!fact || fact.length > 300) { console.error('usage: memory.mjs note "<one short note, max 300 characters>"'); process.exit(2); }
  for (const [re, what] of SENSITIVE) if (re.test(fact)) { console.error(`Not saved: this looks like ${what}.`); process.exit(3); }
  const f = resolve(import.meta.dirname, '..', 'data', 'memory', 'bots', `${bot}.md`);
  mkdirSync(dirname(f), { recursive: true });
  let t = existsSync(f) ? readFileSync(f, 'utf8') : `# ${bot} notes\n`;
  if (t.toLowerCase().includes(fact.toLowerCase())) { console.log('Already noted.'); process.exit(0); }
  t = `${t.trimEnd()}\n- ${new Date().toLocaleDateString('sv-SE')}: ${fact}\n`;
  // Keep the newest notes when the file grows past 3,000 characters.
  while (t.length > 3000) { const lines = t.split('\n'); const i = lines.findIndex((l) => l.startsWith('- ')); if (i < 0) break; lines.splice(i, 1); t = lines.join('\n'); }
  writeFileSync(f, t);
  console.log(`Noted: ${fact}`);
} else if (cmd === 'show') {
  console.log(read());
} else if (cmd === 'sections') {
  console.log(read().split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3)).join('\n'));
} else if (cmd === 'add') {
  const [section, ...words] = rest;
  const fact = words.join(' ').replace(/\s+/g, ' ').trim();
  if (!section || !fact) { console.error('usage: memory.mjs add "<Section>" "<fact>"'); process.exit(2); }
  if (fact.length > 300) { console.error('Keep a memory under 300 characters: one clear fact.'); process.exit(2); }
  for (const [re, what] of SENSITIVE) if (re.test(fact)) { console.error(`Not saved: this looks like ${what}. Secrets and ID numbers never go into shared memory.`); process.exit(3); }
  let text = read();
  if (text.toLowerCase().includes(fact.toLowerCase())) { console.log('Already in memory.'); process.exit(0); }
  const lines = text.split('\n');
  const head = `## ${section.trim()}`;
  let i = lines.findIndex((l) => l.trim().toLowerCase() === head.toLowerCase());
  if (i < 0) { lines.push('', head); i = lines.length - 1; }
  let j = i + 1;
  while (j < lines.length && !lines[j].startsWith('## ')) j++;
  while (j > i + 1 && !lines[j - 1].trim()) j--; // insert after the section's last bullet
  lines.splice(j, 0, `- ${fact}`);
  text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  if (text.length > MAX) { console.error(`Not saved: memory is full (${MAX} characters). Ask the user to tidy it in Manage bots → About me.`); process.exit(4); }
  mkdirSync(dirname(FILE), { recursive: true });
  mkdirSync(BACKUPS, { recursive: true });
  if (existsSync(FILE)) copyFileSync(FILE, resolve(BACKUPS, `about-me-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`));
  writeFileSync(FILE, text.endsWith('\n') ? text : text + '\n');
  console.log(`Remembered under "${section.trim()}": ${fact}`);
} else {
  console.error('usage: memory.mjs add "<Section>" "<fact>" | show | sections');
  process.exit(2);
}
