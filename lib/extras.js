// Extras around the bots: local settings (secrets stay on this PC), file uploads, and the Inbox
// (everything that is waiting for the user across bots).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SECRETS = path.join(DATA, 'secrets');
const SETTINGS = path.join(SECRETS, 'settings.json');
const UPLOADS = path.join(DATA, 'uploads');
const DISMISSED = path.join(DATA, 'inbox-dismissed.json');
const REPOS = path.resolve(ROOT, '..', 'jobfy-qa', 'repos');
const PUSH_REPOS = ['warehouse-simulator', 'jobfy-playwright-tests', 'JobFy-v2'];

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); };

// ---------- settings (data/secrets/settings.json, never sent anywhere but where each value belongs) ----------
const DEFAULTS = {
  telegram: { token: '', pairCode: '', chats: [], pushBrief: true, pushFailures: true, pushReplies: true },
  calendar: { icsUrl: '' },
  voice: { lang: 'es-ES', speak: false },
};
function getSettings() {
  const s = readJson(SETTINGS, {});
  const out = { telegram: { ...DEFAULTS.telegram, ...(s.telegram || {}) }, calendar: { ...DEFAULTS.calendar, ...(s.calendar || {}) }, voice: { ...DEFAULTS.voice, ...(s.voice || {}) } };
  if (!out.telegram.pairCode) { out.telegram.pairCode = crypto.randomInt(100000, 999999).toString(); writeJson(SETTINGS, out); }
  return out;
}
function saveSettings(s) { writeJson(SETTINGS, s); return s; }
const mask = (t) => (t ? `${t.slice(0, 4)}…${t.slice(-4)}` : '');
function publicSettings() {
  const s = getSettings();
  return {
    telegram: { tokenSet: !!s.telegram.token, tokenHint: mask(s.telegram.token), pairCode: s.telegram.pairCode, chats: s.telegram.chats.map((c) => ({ id: c.id, name: c.name })), pushBrief: s.telegram.pushBrief, pushFailures: s.telegram.pushFailures, pushReplies: s.telegram.pushReplies },
    calendar: { icsSet: !!s.calendar.icsUrl, icsHint: s.calendar.icsUrl ? s.calendar.icsUrl.replace(/(private-)[^/]+/, '$1…') .slice(0, 70) : '' },
    voice: s.voice,
  };
}
function updateSettings(patch) {
  const s = getSettings();
  if (patch.telegram) {
    const t = patch.telegram;
    if (typeof t.token === 'string') {
      const tok = t.token.trim();
      if (tok && !/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(tok)) throw new Error('That does not look like a Telegram bot token (it looks like 123456789:AA...).');
      s.telegram.token = tok;
    }
    for (const k of ['pushBrief', 'pushFailures', 'pushReplies']) if (k in t) s.telegram[k] = !!t[k];
    if (t.newPairCode) s.telegram.pairCode = crypto.randomInt(100000, 999999).toString();
    if (t.unpair) s.telegram.chats = s.telegram.chats.filter((c) => String(c.id) !== String(t.unpair));
  }
  if (patch.calendar && typeof patch.calendar.icsUrl === 'string') {
    const u = patch.calendar.icsUrl.trim();
    if (u && !/^https:\/\/\S+$/i.test(u)) throw new Error('The calendar link must be an https:// iCal (.ics) address.');
    s.calendar.icsUrl = u;
  }
  if (patch.voice) {
    if (['es-ES', 'en-US', 'en-GB', 'ro-RO'].includes(patch.voice.lang)) s.voice.lang = patch.voice.lang;
    if ('speak' in patch.voice) s.voice.speak = !!patch.voice.speak;
  }
  return saveSettings(s);
}

// Adds a Telegram chat after it sent the right code, and rotates the code (it works once).
function pairTelegramChat(id, name) {
  const s = getSettings();
  if (!s.telegram.chats.some((c) => String(c.id) === String(id))) s.telegram.chats.push({ id, name });
  s.telegram.pairCode = crypto.randomInt(100000, 999999).toString();
  return saveSettings(s);
}

// ---------- uploads ----------
const ALLOWED_EXT = /\.(png|jpe?g|gif|webp|pdf|txt|md|csv|json|docx?|xlsx?|mp4|mov|webm|mp3|m4a|wav|ogg|zip)$/i;
function saveUpload(name, buffer) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').slice(-80) || 'file';
  if (!ALLOWED_EXT.test(base)) throw new Error('That file type is not supported. Images, PDFs, text, documents, audio and video are.');
  if (buffer.length > 50 * 1024 * 1024) throw new Error('Files over 50 MB are not supported.');
  const dir = path.join(UPLOADS, new Date().toISOString().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${base}`);
  fs.writeFileSync(file, buffer);
  return { path: file.replace(/\\/g, '/'), name: base, size: buffer.length };
}

// ---------- inbox ----------
const git = (cwd, ...args) => new Promise((r) => execFile('git', args, { cwd, windowsHide: true, timeout: 10000 }, (e, out) => r(e ? null : String(out).trim())));
function recentFiles(dir, days, ext = /\.(md|txt)$/i) {
  try {
    const cut = Date.now() - days * 864e5;
    return fs.readdirSync(dir).filter((f) => ext.test(f)).map((f) => ({ f, full: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs })).filter((x) => x.m >= cut).sort((a, b) => b.m - a.m);
  } catch { return []; }
}
async function inbox({ agents, bots, today }) {
  const dismissed = new Set(readJson(DISMISSED, []));
  const items = [];
  const t = await today();
  for (const d of t.jobs.drafts || []) items.push({ id: `draft:${d.id}`, kind: 'draft', bot: 'dossier', title: `${d.company}: ${d.role}`, detail: 'Draft application waiting for your review in Dossier. Send it yourself, then tell Job Hunter.', link: d.link, at: Date.parse(d.updated) || 0 });
  for (const x of recentFiles(path.join(DATA, 'jobs', 'followups'), 14)) items.push({ id: `followup:${x.f}:${Math.round(x.m)}`, kind: 'followup', bot: 'dossier', title: `Follow-up draft: ${x.f.replace(/-followup.*$|\.txt$/g, '')}`, detail: 'Review it and send it from your email if it still makes sense.', file: x.full.replace(/\\/g, '/'), at: x.m });
  for (const x of recentFiles(path.join(DATA, 'linkedin'), 10)) items.push({ id: `linkedin:${x.f}:${Math.round(x.m)}`, kind: 'linkedin', bot: 'linkedin', title: `LinkedIn drafts: ${x.f.replace(/\.md$/, '')}`, detail: 'Edit and post the ones you like by hand.', file: x.full.replace(/\\/g, '/'), at: x.m });
  for (const repo of PUSH_REPOS) {
    const cwd = path.join(REPOS, repo);
    if (!fs.existsSync(cwd)) continue;
    const ahead = await git(cwd, 'rev-list', '--count', '@{u}..HEAD');
    if (ahead && Number(ahead) > 0) {
      const head = await git(cwd, 'rev-parse', '--short', 'HEAD');
      items.push({ id: `push:${repo}:${head}`, kind: 'push', bot: 'mentor', title: `${repo}: ${ahead} commit${ahead === '1' ? '' : 's'} ready to push`, detail: `Review with git log, then run git push in ${repo}.`, at: Date.now() - 1 });
    }
  }
  const cut = Date.now() - 3 * 864e5;
  for (const b of bots) {
    const s = [...agents.values()].filter((a) => a.botId === b.id && !a.parentId).sort((x, y) => y.createdAt - x.createdAt)[0];
    if (!s || s.status !== 'done' || (s.finishedAt || 0) < cut) continue;
    const last = String(s.lastResult || '').trim();
    if (last.endsWith('?')) items.push({ id: `question:${s.id}:${s.finishedAt}`, kind: 'question', bot: b.id, title: `${b.name} is waiting for your answer`, detail: last.split('\n').filter(Boolean).pop().slice(0, 200), at: s.finishedAt });
  }
  for (const r of t.runs || []) {
    if (r.status !== 'failed') continue;
    const at = Date.parse(r.time.replace(' ', 'T'));
    if (at < cut) continue;
    items.push({ id: `failed:${r.time}:${r.bot}`, kind: 'failed', bot: r.bot, title: `Scheduled run failed: ${bots.find((b) => b.id === r.bot)?.name || r.bot}`, detail: `At ${r.time}. Open the bot to see why.`, at });
  }
  return items.filter((i) => !dismissed.has(i.id)).sort((a, b) => b.at - a.at);
}
function dismiss(id) {
  const list = readJson(DISMISSED, []);
  if (!list.includes(id)) list.push(id);
  writeJson(DISMISSED, list.slice(-500));
}

module.exports = { getSettings, publicSettings, updateSettings, pairTelegramChat, saveUpload, inbox, dismiss, UPLOADS };
