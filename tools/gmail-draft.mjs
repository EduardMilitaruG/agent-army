#!/usr/bin/env node
// Creates a Gmail DRAFT (never sends) through job-hunter's draft-only Gmail client.
//   node tools/gmail-draft.mjs --to someone@company.com --subject "..." --body-file path/to/body.txt
// The client knows only the token endpoint and drafts.create, and has no send method.
// Every draft is logged to data/gmail-drafts.log. Exit code 3 = Gmail not connected (use the text instead).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const JH = resolve(import.meta.dirname, '..', '..', 'jobfy-qa', 'job-hunter');
const LOG = resolve(import.meta.dirname, '..', 'data', 'gmail-drafts.log');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const to = opt('to'), subject = opt('subject'), bodyFile = opt('body-file');
const checkOnly = args.includes('--check'); // only verify the client loads and Gmail is connected
if (!checkOnly && (!to || !subject || !bodyFile)) { console.error('usage: --to <address> --subject <text> --body-file <path>'); process.exit(2); }
if (!checkOnly && !existsSync(bodyFile)) { console.error(`no such file: ${bodyFile}`); process.exit(2); }

// Credentials: job-hunter's .env (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET) and its stored refresh token.
const env = {};
try {
  for (const line of readFileSync(resolve(JH, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

// Load job-hunter's TypeScript client with its own tsx.
const require = createRequire(resolve(JH, 'package.json'));
const { register } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
register();
const { gmailFromEnv } = await import(pathToFileURL(resolve(JH, 'src', 'gmail', 'client.ts')).href);
const { buildRawMessage } = await import(pathToFileURL(resolve(JH, 'src', 'gmail', 'mime.ts')).href);

const gmail = gmailFromEnv(resolve(JH, 'data', 'gmail-token.json'), env);
if (!gmail) { console.error('Gmail is not connected (job-hunter has no token). Give the user the text instead.'); process.exit(3); }
if (checkOnly) {
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(gmail)).filter((m) => /send/i.test(m));
  console.log(`Gmail draft client loaded and connected. Send methods: ${methods.length ? methods.join(', ') : 'none'}.`);
  process.exit(0);
}
const raw = buildRawMessage({ to, subject, text: readFileSync(bodyFile, 'utf8') });
const id = await gmail.createDraft(raw);
mkdirSync(dirname(LOG), { recursive: true });
appendFileSync(LOG, `${new Date().toISOString()}\t${id}\t${to}\t${subject.replace(/\s+/g, ' ')}\n`);
console.log(`Gmail draft created (NOT sent): ${id} to ${to}. The user reviews and sends it themselves.`);
