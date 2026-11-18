// Agent Army — local dashboard that runs a fleet of Claude Code workers.
// Every worker is a real `claude -p` (headless Claude Code) process, so it runs
// on your Claude subscription login. Zero npm dependencies.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const life = require('./lib/life');
const manage = require('./lib/manage');
const extras = require('./lib/extras');
const { createTelegram } = require('./lib/telegram');

// Settings: config.json next to this file (env vars override it).
let CONFIG = {};
try { CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { /* defaults */ }
const PORT = Number(process.env.PORT || CONFIG.port || 4777);
const HOST = '127.0.0.1'; // local only — never expose this to the network
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL || CONFIG.maxParallel || 4);
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MIN || CONFIG.idleTimeoutMin || 10) * 60000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const WORKSPACES = path.join(ROOT, 'workspaces');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WORKSPACES, { recursive: true });

// ---------- locate the Claude Code binary ----------
function findClaude() {
  if (process.env.CLAUDE_BIN) return { cmd: process.env.CLAUDE_BIN, shell: false };
  if (process.platform === 'win32') {
    const exe = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(exe)) return { cmd: exe, shell: false };
    return { cmd: 'claude.cmd', shell: true };
  }
  return { cmd: 'claude', shell: false };
}
const CLAUDE = findClaude();

// ---------- bots (saved presets in bots.json, re-read on every use so edits apply live) ----------
// bots.json is personal (git-ignored). On a fresh copy, start from the anonymized bots.example.json.
if (!fs.existsSync(path.join(ROOT, 'bots.json')) && fs.existsSync(path.join(ROOT, 'bots.example.json'))) {
  fs.copyFileSync(path.join(ROOT, 'bots.example.json'), path.join(ROOT, 'bots.json'));
}
// Placeholders so bot files carry no machine-specific paths: {{TOOLS}}, {{ROOT}}, {{REPOS}}.
const PLACEHOLDERS = {
  '{{TOOLS}}': path.join(ROOT, 'tools').replace(/\\/g, '/'),
  '{{ROOT}}': ROOT.replace(/\\/g, '/'),
  '{{REPOS}}': path.resolve(ROOT, '..', 'jobfy-qa', 'repos').replace(/\\/g, '/'),
};
const fillPlaceholders = (v) => (typeof v === 'string' ? v.replace(/\{\{(TOOLS|ROOT|REPOS)\}\}/g, (m) => PLACEHOLDERS[m])
  : Array.isArray(v) ? v.map(fillPlaceholders) : v);
function loadBots() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'bots.json'), 'utf8')).filter((b) => b && b.id).map((b) => ({
      ...b, instructions: fillPlaceholders(b.instructions), allowedTools: fillPlaceholders(b.allowedTools), disallowedTools: fillPlaceholders(b.disallowedTools),
    }));
  } catch { return []; }
}
const getBot = (id) => (id ? loadBots().find((b) => b.id === id) : null);
// Build an --mcp-config JSON with only the bot's servers, copied from your Claude Code user config.
function botMcpConfig(bot) {
  // Always explicit: a bot with no MCP servers gets an empty set, so it never inherits the plugins and
  // connectors from your own Claude Code setup (e.g. a browser-control plugin).
  if (!bot.mcpServers?.length) return JSON.stringify({ mcpServers: {} });
  let user = {};
  try { user = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).mcpServers || {}; } catch { /* none */ }
  const servers = {};
  for (const name of bot.mcpServers) {
    if (typeof name === 'object') Object.assign(servers, name);
    else if (user[name]) servers[name] = user[name];
  }
  return JSON.stringify({ mcpServers: servers });
}
async function checkRequires(bot) {
  if (!bot?.requires?.url) return true;
  try {
    const r = await fetch(bot.requires.url, { redirect: 'manual', signal: AbortSignal.timeout(2500) });
    return r.status < 500;
  } catch { return false; }
}
// ---------- shared memory: data/memory/about-me.md goes into every bot's prompt ----------
const MEMORY_FILE = path.join(DATA_DIR, 'memory', 'about-me.md');
const MEMORY_TOOL = path.join(ROOT, 'tools', 'memory.mjs').replace(/\\/g, '/');
function memoryPrompt(bot) {
  let text = '';
  try { text = fs.readFileSync(MEMORY_FILE, 'utf8').replace(/^\uFEFF/, '').trim().slice(0, 8000); } catch { /* none yet */ }
  let notes = '';
  try { notes = fs.readFileSync(path.join(DATA_DIR, 'memory', 'bots', `${bot.id}.md`), 'utf8').trim().slice(0, 3000); } catch { /* none yet */ }
  return `

SHARED MEMORY ABOUT THE USER (the same for every bot on their team; use it, don't recite it)
${text || '(empty)'}

YOUR OWN NOTES (only you see these; keep them useful)
${notes || '(none yet)'}
To add one: node ${MEMORY_TOOL} note "<short note>"  for things only you need next time (their current level, what you tried, what worked, open threads). Shared facts about Eduard go in shared memory instead.

ATTACHMENTS: when a message mentions an attached file path, open it with the Read tool (images and PDFs included) before answering.

REMEMBERING: when the user asks you to remember something, or tells you a lasting fact about themselves (goal, situation, preference, equipment, level, important date), save it with
  node ${MEMORY_TOOL} add "<Section>" "<one clear fact>"
using an existing section name when it fits, then confirm in one line. Save nothing for passing remarks, and never passwords, ID numbers, bank details or other people's private data. If a fact replaces an old one, say so and tell them they can tidy it in Manage bots → About me.`;
}

function botArgs(bot) {
  const args = [];
  // Every bot may run the memory tool (and only that, unless its own rules allow more).
  const tools = bot.tools ? [...new Set([...bot.tools, 'Bash'])] : null;
  if (tools) args.push('--tools', tools.join(','));
  const allowedBase = [...(bot.allowedTools || []), `Bash(node ${MEMORY_TOOL}:*)`];
  if (allowedBase.length) {
    // Models sometimes quote the script path (node "C:/.../x.mjs" ...): allow that spelling of the
    // same command too, so a helper script isn't blocked just for the quotes.
    const allowed = new Set(allowedBase);
    for (const rule of allowedBase) {
      const m = rule.match(/^Bash\(node (\S+\.mjs)(.*)\)$/);
      if (m) allowed.add(`Bash(node "${m[1]}"${m[2]})`);
    }
    args.push('--allowedTools', [...allowed].join(','));
  }
  if (bot.disallowedTools?.length) args.push('--disallowedTools', bot.disallowedTools.join(','));
  args.push('--append-system-prompt', (bot.instructions || '') + memoryPrompt(bot));
  args.push('--add-dir', path.join(DATA_DIR, 'uploads')); // attachments are readable by every bot
  for (const d of bot.addDirs || []) args.push('--add-dir', path.resolve(ROOT, d));
  if (bot.settings) args.push('--settings', JSON.stringify(bot.settings));
  const mcp = botMcpConfig(bot);
  if (mcp) args.push('--strict-mcp-config', '--mcp-config', mcp);
  return args;
}

// ---------- state ----------
/** @type {Map<string, any>} */
const agents = new Map();
let usage = null; // last rate_limit_event info
const queue = []; // pending runs: {agentId, prompt}
const procs = new Map(); // agentId -> child process

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const a of s.agents || []) {
      if (a.status === 'running' || a.status === 'queued') a.status = 'stopped';
      agents.set(a.id, a);
    }
    usage = s.usage || null;
  } catch { /* first run */ }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ agents: [...agents.values()], usage }, null, 1));
    fs.renameSync(tmp, STATE_FILE);
  }, 400);
}
load();

// ---------- SSE ----------
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
const publicAgent = (a) => {
  const { messages, ...rest } = a;
  return { ...rest, messageCount: messages.length };
};
function updateAgent(a, patch) {
  Object.assign(a, patch);
  broadcast('agent', publicAgent(a));
  save();
}
function pushMessage(a, m) {
  m.id = m.id || crypto.randomUUID();
  m.ts = Date.now();
  a.messages.push(m);
  broadcast('message', { agentId: a.id, message: m });
  save();
}

// ---------- agents ----------
const slug = (s) => String(s || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';

function createAgent({ name, model, cwd, permissionMode, role, parentId, effort, botId }) {
  const id = crypto.randomUUID().slice(0, 8);
  const bot = getBot(botId);
  if (bot) { model = model || bot.model; permissionMode = permissionMode || bot.permissionMode; role = 'bot'; }
  const dir = cwd && cwd.trim() ? path.resolve(cwd.trim())
    : bot?.cwd ? path.resolve(ROOT, bot.cwd) // a bot can work in a fixed folder (relative to agent-army)
    : bot ? path.join(WORKSPACES, `bot-${slug(bot.id)}`) // one shared folder per bot, so its files persist
    : path.join(WORKSPACES, `${slug(name)}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const a = {
    id,
    name: name || `Agent ${id}`,
    model: model || 'sonnet',
    effort: effort || '',
    cwd: dir,
    permissionMode: permissionMode || 'acceptEdits',
    role: role || 'solo', // solo | commander | worker | bot
    parentId: parentId || null,
    botId: bot ? bot.id : null,
    status: 'idle',
    sessionId: null,
    costUsd: 0,
    turns: 0,
    createdAt: Date.now(),
    lastResult: '',
    messages: [],
  };
  agents.set(id, a);
  broadcast('agent', publicAgent(a));
  save();
  return a;
}

function enqueue(a, prompt, { silent = false } = {}) {
  if (!silent) pushMessage(a, { role: 'user', kind: 'text', text: prompt });
  queue.push({ agentId: a.id, prompt });
  updateAgent(a, { status: 'queued' });
  pump();
}

function pump() {
  while (procs.size < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    const a = agents.get(job.agentId);
    if (!a || a.status !== 'queued') continue;
    run(a, job.prompt);
  }
  broadcast('stats', stats());
}

function run(a, prompt) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', a.model, '--permission-mode', a.permissionMode];
  if (a.effort) args.push('--effort', a.effort);
  if (a.sessionId) args.push('--resume', a.sessionId);
  const bot = getBot(a.botId);
  if (bot) args.push(...botArgs(bot));
  fs.mkdirSync(a.cwd, { recursive: true });

  const child = spawn(CLAUDE.cmd, args, {
    cwd: a.cwd,
    shell: CLAUDE.shell,
    windowsHide: true,
    // Force the subscription login (never an API key). ARMY_* lets a bot (the Chief of Staff)
    // delegate to other bots through tools/army.mjs, with its own agent as the parent.
    env: { ...process.env, ANTHROPIC_API_KEY: '', ARMY_AGENT_ID: a.id, ARMY_BOT_ID: a.botId || '', ARMY_URL: `http://127.0.0.1:${PORT}` },
  });
  procs.set(a.id, child);
  updateAgent(a, { status: 'running', startedAt: Date.now() });
  child.stdin.end(prompt);

  let buf = '';
  let stderr = '';
  let gotResult = false;
  // Watchdog: kill a worker that produces no output for IDLE_TIMEOUT_MIN minutes.
  let lastOut = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastOut > IDLE_TIMEOUT_MS && procs.get(a.id) === child) {
      pushMessage(a, { role: 'system', kind: 'error', text: `No output for ${IDLE_TIMEOUT_MS / 60000} min, so the worker was stopped. Send a message to continue it.` });
      stopAgent(a);
      updateAgent(a, { status: 'error' });
    }
  }, 15000);
  child.on('close', () => clearInterval(watchdog));
  child.stdout.on('data', (chunk) => {
    lastOut = Date.now();
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'result') gotResult = true;
      handleEvent(a, ev);
    }
  });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  child.on('error', (err) => {
    pushMessage(a, { role: 'system', kind: 'error', text: `Failed to start Claude Code: ${err.message}` });
  });
  child.on('close', (code) => {
    procs.delete(a.id);
    if (a.status === 'running') {
      if (!gotResult) {
        const msg = stderr.trim() || `Claude Code exited with code ${code}`;
        pushMessage(a, { role: 'system', kind: 'error', text: msg.slice(-2000) });
        updateAgent(a, { status: 'error' });
      }
    }
    onAgentFinished(a);
    pump();
  });
}

function handleEvent(a, ev) {
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init' && ev.session_id) updateAgent(a, { sessionId: ev.session_id, resolvedModel: ev.model });
      break;
    case 'assistant': {
      for (const block of ev.message?.content || []) {
        if (block.type === 'text' && block.text.trim()) pushMessage(a, { role: 'assistant', kind: 'text', text: block.text });
        else if (block.type === 'tool_use') pushMessage(a, { role: 'assistant', kind: 'tool', tool: block.name, toolId: block.id, input: block.input });
      }
      break;
    }
    case 'user': {
      for (const block of ev.message?.content || []) {
        if (block.type === 'tool_result') {
          let text = block.content;
          if (Array.isArray(text)) text = text.map((c) => c.text || '').join('\n');
          pushMessage(a, { role: 'tool', kind: 'tool_result', toolId: block.tool_use_id, isError: !!block.is_error, text: String(text || '').slice(0, 4000) });
        }
      }
      break;
    }
    case 'rate_limit_event':
      usage = { ...ev.rate_limit_info, at: Date.now() };
      broadcast('usage', usage);
      break;
    case 'result':
      updateAgent(a, {
        status: ev.is_error ? 'error' : 'done',
        sessionId: ev.session_id || a.sessionId,
        costUsd: +(a.costUsd + (ev.total_cost_usd || 0)).toFixed(4),
        turns: a.turns + (ev.num_turns || 0),
        lastResult: ev.result || '',
        finishedAt: Date.now(),
      });
      if (ev.is_error) pushMessage(a, { role: 'system', kind: 'error', text: ev.result || ev.subtype || 'Run failed' });
      if (ev.permission_denials?.length) {
        pushMessage(a, { role: 'system', kind: 'notice', text: `Blocked ${ev.permission_denials.length} tool call(s) by permission mode "${a.permissionMode}": ${[...new Set(ev.permission_denials.map((d) => d.tool_name))].join(', ')}` });
      }
      break;
  }
}

function stopAgent(a) {
  queue.splice(0, queue.length, ...queue.filter((j) => j.agentId !== a.id));
  const child = procs.get(a.id);
  updateAgent(a, { status: 'stopped' });
  if (child) {
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    else child.kill('SIGTERM');
  }
  pump();
}

// A bot that needs Dossier never fails just because Dossier (or Docker) is off: start it, then run.
async function needsDossier(bot) {
  return bot?.requires?.url && !(await checkRequires(bot));
}
function enqueueWhenReady(a, prompt, bot) {
  pushMessage(a, { role: 'user', kind: 'text', text: prompt });
  updateAgent(a, { status: 'queued' });
  pushMessage(a, { role: 'system', kind: 'notice', text: `${bot.requires.label || 'Dossier'} is off, starting it first (Docker can take a minute)…` });
  life.ensureDossier()
    .then(() => { if (a.status === 'queued') { queue.push({ agentId: a.id, prompt }); pump(); } })
    .catch((e) => { pushMessage(a, { role: 'system', kind: 'error', text: `Could not start ${bot.requires.label || 'Dossier'}: ${e.message}` }); updateAgent(a, { status: 'error' }); });
}
async function startBotRun(a, prompt) {
  const bot = getBot(a.botId);
  if (await needsDossier(bot)) enqueueWhenReady(a, prompt, bot);
  else enqueue(a, prompt);
}

// One continuous thread per bot: a message continues the bot's latest conversation if it was
// active in the last few hours, otherwise it starts a new one (shown as a divider in the thread).
const CONTINUE_WINDOW_MS = 3 * 3600_000;
function latestSession(botId) {
  return [...agents.values()].filter((x) => x.botId === botId).sort((x, y) => y.createdAt - x.createdAt)[0] || null;
}

// ---------- commander: plan -> parallel workers -> synthesis ----------
const PLAN_MARK = 'ARMY_PLAN';
function commanderPrompt(goal, maxWorkers) {
  return `You are the COMMANDER of a team of parallel AI worker agents (each is an independent Claude Code session with its own empty workspace folder and full tools: web search, files, shell).

GOAL:
${goal}

Split this goal into between 1 and ${maxWorkers} independent subtasks that can run IN PARALLEL with no dependency between them. Each worker only sees its own task text, so make every task fully self-contained (include all needed context, the exact deliverable, and the file name to write it to if relevant).

Do not do the work yourself. Reply with a short plan sentence, then a fenced code block tagged ${PLAN_MARK} containing ONLY a JSON array like:
\`\`\`${PLAN_MARK}
[{"name": "Short worker name", "task": "Full self-contained instructions..."}]
\`\`\``;
}

function parsePlan(text) {
  const m = text.match(new RegExp('```' + PLAN_MARK + '\\s*([\\s\\S]*?)```')) || text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]);
    return Array.isArray(arr) ? arr.filter((t) => t && t.task).slice(0, 12) : null;
  } catch { return null; }
}

// Talk to a bot: continue its latest conversation if recent, else start a new one. Shared by the
// dashboard and Telegram.
async function chatWithBot(botId, rawText, { newChat = false, model, telegramChat } = {}) {
  const bot = getBot(botId);
  const fail = (m, status = 400) => { const e = new Error(m); e.status = status; throw e; };
  if (!bot) fail('bot not found', 404);
  if (bot.disabled) fail(`${bot.name} is turned off. Turn it on in Manage bots.`, 409);
  const text = String(rawText || '').trim();
  if (!text) fail('text required');
  let a = newChat ? null : latestSession(bot.id);
  if (a && ['running', 'queued'].includes(a.status)) fail(`${bot.name} is still working. Wait, or press Stop.`, 409);
  const recent = a && a.sessionId && Date.now() - (a.finishedAt || a.createdAt) < CONTINUE_WINDOW_MS && !a.parentId;
  if (!recent) a = createAgent({ botId: bot.id, name: text.slice(0, 60), model });
  else if (model) a.model = model;
  if (telegramChat) a.telegramChat = telegramChat; else delete a.telegramChat;
  await startBotRun(a, text);
  return a;
}

// Phone notifications: replies to Telegram messages, the scheduled morning brief, failed scheduled runs.
function notifyPhone(a) {
  const s = extras.getSettings().telegram;
  if (!s.token || !s.chats.length) return;
  const bot = getBot(a.botId);
  const name = bot?.name || 'Agent';
  if (a.telegramChat && s.pushReplies) {
    const text = a.status === 'done' ? `${name}:\n${a.lastResult || '(no answer)'}` : `${name} could not finish (${a.status}). Open the dashboard to see why.`;
    telegram.send(a.telegramChat, text).catch((e) => console.log(`telegram: ${e.message}`));
    delete a.telegramChat;
    return;
  }
  if (!/^Scheduled/.test(a.name)) return;
  if (a.status === 'done' && a.botId === 'chief' && s.pushBrief) telegram.broadcast(`Morning brief\n\n${a.lastResult}`);
  else if (a.status !== 'done' && s.pushFailures) telegram.broadcast(`Scheduled run failed: ${name} (${a.status}). Open the dashboard to see why.`);
}

function onAgentFinished(a) {
  if (['done', 'error', 'stopped'].includes(a.status)) { try { notifyPhone(a); } catch (e) { console.log(`notify: ${e.message}`); } }
  if (!['done', 'error', 'stopped'].includes(a.status)) return;
  if (a.role === 'commander' && a.phase === 'planning') {
    if (a.status !== 'done') return;
    const plan = parsePlan(a.lastResult);
    if (!plan || !plan.length) {
      pushMessage(a, { role: 'system', kind: 'error', text: 'Could not read a plan from the commander reply. Send it a message asking for the ARMY_PLAN JSON block.' });
      return;
    }
    const workerIds = [];
    for (const t of plan) {
      const w = createAgent({ name: t.name || 'Worker', model: a.workerModel, permissionMode: a.permissionMode, role: 'worker', parentId: a.id, cwd: a.sharedCwd ? a.cwd : '' });
      workerIds.push(w.id);
      enqueue(w, t.task);
    }
    pushMessage(a, { role: 'system', kind: 'notice', text: `Deployed ${plan.length} worker(s): ${plan.map((t) => t.name).join(', ')}` });
    updateAgent(a, { phase: 'waiting', workerIds });
    return;
  }
  if (a.role === 'worker' && a.parentId) {
    const cmd = agents.get(a.parentId);
    if (!cmd || cmd.phase !== 'waiting' || cmd.status === 'stopped') return;
    const workers = (cmd.workerIds || []).map((id) => agents.get(id)).filter(Boolean);
    if (workers.some((w) => ['queued', 'running', 'idle'].includes(w.status))) return;
    const report = workers.map((w) => `### ${w.name} (${w.status})\nWorkspace: ${w.cwd}\n${w.lastResult || '(no result)'}`).join('\n\n');
    cmd.phase = 'synthesizing';
    pushMessage(cmd, { role: 'system', kind: 'notice', text: `All ${workers.length} worker(s) finished. Merging their results…` });
    enqueue(cmd, `All workers have finished. Here are their reports:\n\n${report}\n\nNow write the final combined answer for the original goal. Merge, deduplicate, resolve conflicts, and point to any files the workers produced using their full paths.`, { silent: true });
  }
  if (a.role === 'commander' && a.phase === 'synthesizing' && a.status === 'done') updateAgent(a, { phase: 'complete' });
}

function stats() {
  const all = [...agents.values()];
  return {
    running: procs.size,
    queued: queue.length,
    maxParallel: MAX_PARALLEL,
    total: all.length,
    costUsd: +all.reduce((s, a) => s + (a.costUsd || 0), 0).toFixed(4),
  };
}

// ---------- HTTP ----------
function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const telegram = createTelegram({
  extras,
  today: life.today,
  listBots: async () => loadBots().filter((b) => !b.disabled).map((b) => ({ id: b.id, name: b.name, description: b.description })),
  onChat: (botId, text, opts) => chatWithBot(botId, text, opts),
  log: (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`),
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  // Basic CSRF guard: only accept API writes from this page's own origin.
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'bad origin' });
  try {
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(ROOT, 'public', 'index.html')).pipe(res);
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${JSON.stringify({ agents: [...agents.values()].map(publicAgent), usage, stats: stats() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    // ---------- shared memory (About me) ----------
    if (p === '/api/memory' && req.method === 'GET') {
      let text = ''; let updatedAt = null;
      try { text = fs.readFileSync(MEMORY_FILE, 'utf8'); updatedAt = fs.statSync(MEMORY_FILE).mtimeMs; } catch { /* none */ }
      return json(res, 200, { text, updatedAt, max: 8000 });
    }
    if (p === '/api/memory' && req.method === 'PUT') {
      const b = await readBody(req);
      const text = String(b.text || '').replace(/\r\n/g, '\n');
      if (text.length > 8000) return json(res, 400, { error: `Too long: ${text.length} of 8000 characters. Every bot reads this, so keep it compact.` });
      fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
      const backups = path.join(DATA_DIR, 'backups'); fs.mkdirSync(backups, { recursive: true });
      if (fs.existsSync(MEMORY_FILE)) fs.copyFileSync(MEMORY_FILE, path.join(backups, `about-me-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`));
      fs.writeFileSync(MEMORY_FILE, text.endsWith('\n') ? text : text + '\n');
      return json(res, 200, { ok: true, updatedAt: Date.now() });
    }
    // ---------- manage the team ----------
    if (p.startsWith('/api/manage/')) {
      try {
        if (p === '/api/manage/bots' && req.method === 'GET') return json(res, 200, manage.listForManage(agents));
        if (p === '/api/manage/bots' && req.method === 'POST') { const bot = manage.createBot(await readBody(req)); broadcast('bots', {}); return json(res, 200, bot); }
        if (p === '/api/manage/schedule/pause' && req.method === 'POST') { const r = await manage.pauseAll(true); broadcast('bots', {}); return json(res, 200, r); }
        if (p === '/api/manage/schedule/resume' && req.method === 'POST') { const r = await manage.pauseAll(false); broadcast('bots', {}); return json(res, 200, r); }
        const mm = p.match(/^\/api\/manage\/bots\/([a-z0-9-]+)(?:\/(duplicate|schedule|clear))?$/);
        if (mm) {
          const [, id, action] = mm;
          const dropChats = () => {
            const mine = [...agents.values()].filter((a) => a.botId === id);
            for (const a of mine) { stopAgent(a); agents.delete(a.id); broadcast('removed', { id: a.id }); }
            save();
            return mine.length;
          };
          if (!action && req.method === 'PUT') { const bot = manage.updateBot(id, await readBody(req)); broadcast('bots', {}); return json(res, 200, bot); }
          if (action === 'duplicate' && req.method === 'POST') { const bot = manage.duplicateBot(id); broadcast('bots', {}); return json(res, 200, bot); }
          if (action === 'clear' && req.method === 'POST') return json(res, 200, { deletedChats: dropChats() });
          if (action === 'schedule' && req.method === 'PUT') {
            const b = await readBody(req);
            const entries = manage.setSchedule(id, b.entries || []);
            const applied = await manage.applySchedule();
            return json(res, 200, { entries, applied });
          }
          if (!action && req.method === 'DELETE') {
            const b = await readBody(req);
            const r = manage.deleteBot(id);
            const deletedChats = b.keepChats ? 0 : dropChats();
            const applied = r.removedTasks ? await manage.applySchedule() : null;
            broadcast('bots', {});
            return json(res, 200, { ...r, deletedChats, applied });
          }
        }
        return json(res, 404, { error: 'not found' });
      } catch (e) {
        if (e instanceof manage.ManageError) return json(res, 400, { error: e.message });
        throw e;
      }
    }
    if (p === '/api/bots') {
      const bots = loadBots().filter((b) => !b.disabled);
      const out = await Promise.all(bots.map(async (b) => ({
        id: b.id, name: b.name, avatar: b.avatar || { shape: 'round', feature: 'none' }, color: b.color || '#8b8b92', description: b.description || '', model: b.model || 'sonnet',
        suggestions: b.suggestions || [], requires: b.requires || null, online: await checkRequires(b), pinned: !!b.pinned,
      })));
      return json(res, 200, out);
    }
    if (p === '/api/agents' && req.method === 'GET') return json(res, 200, [...agents.values()].map(publicAgent));
    if (p === '/api/agents' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.prompt?.trim()) return json(res, 400, { error: 'prompt required' });
      if (b.botId && !getBot(b.botId)) return json(res, 404, { error: 'bot not found' });
      if (b.botId && getBot(b.botId).disabled) return json(res, 409, { error: `${getBot(b.botId).name} is turned off. Turn it on in Manage bots.` });
      if (b.parentId && !agents.has(b.parentId)) b.parentId = null;
      const a = createAgent(b);
      await startBotRun(a, b.prompt.trim());
      return json(res, 200, publicAgent(a));
    }
    const chat = p.match(/^\/api\/bots\/([a-z0-9-]+)\/chat$/);
    if (chat && req.method === 'POST') {
      const b = await readBody(req);
      try { return json(res, 200, publicAgent(await chatWithBot(chat[1], b.text, { newChat: b.newChat, model: b.model }))); }
      catch (e) { return json(res, e.status || 400, { error: e.message }); }
    }
    // ---------- inbox, uploads, files, settings ----------
    if (p === '/api/inbox' && req.method === 'GET') return json(res, 200, await extras.inbox({ agents, bots: loadBots().filter((x) => !x.disabled), today: life.today }));
    if (p === '/api/inbox/dismiss' && req.method === 'POST') { const b = await readBody(req); extras.dismiss(String(b.id || '')); return json(res, 200, { ok: true }); }
    if (p === '/api/upload' && req.method === 'POST') {
      const b = await readBody(req, 75e6);
      try { return json(res, 200, extras.saveUpload(b.name, Buffer.from(String(b.data || ''), 'base64'))); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/file' && req.method === 'GET') {
      // Only files inside agent-army/data (uploads, drafts, briefs...), never anything else on the PC.
      const f = path.resolve(String(url.searchParams.get('path') || ''));
      if (!f.toLowerCase().startsWith(DATA_DIR.toLowerCase() + path.sep) || /[\\/]secrets[\\/]/i.test(f) || !fs.existsSync(f)) return json(res, 404, { error: 'not found' });
      const ext = path.extname(f).toLowerCase();
      const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.ics': 'text/calendar' }[ext] || 'text/plain; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...(ext === '.ics' ? { 'Content-Disposition': `attachment; filename="${path.basename(f)}"` } : {}) });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === '/api/settings' && req.method === 'GET') return json(res, 200, { ...extras.publicSettings(), userName: CONFIG.userName || '' });
    if (p === '/api/settings' && req.method === 'PUT') {
      try { extras.updateSettings(await readBody(req)); return json(res, 200, extras.publicSettings()); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/settings/telegram/test' && req.method === 'POST') {
      try { return json(res, 200, await telegram.test()); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/today') return json(res, 200, await life.today(url.searchParams.has('fresh')));
    if (p === '/api/dossier/start' && req.method === 'POST') {
      life.ensureDossier().then(() => broadcast('dossier', { online: true })).catch((e) => broadcast('dossier', { online: false, error: e.message }));
      return json(res, 200, { ok: true, starting: true });
    }
    if (p === '/api/habits' && req.method === 'POST') {
      const b = await readBody(req);
      try { return json(res, 200, life.addHabit(b.habit, b.note)); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/commander' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.goal?.trim()) return json(res, 400, { error: 'goal required' });
      const a = createAgent({ name: b.name || `Commander: ${b.goal.slice(0, 40)}`, model: b.model || 'opus', permissionMode: b.permissionMode, role: 'commander', cwd: b.cwd, effort: b.effort });
      Object.assign(a, { phase: 'planning', workerModel: b.workerModel || 'sonnet', goal: b.goal, sharedCwd: !!b.sharedCwd });
      pushMessage(a, { role: 'user', kind: 'text', text: b.goal.trim() });
      enqueue(a, commanderPrompt(b.goal.trim(), Math.min(Math.max(Number(b.maxWorkers) || 4, 1), 12)), { silent: true });
      return json(res, 200, publicAgent(a));
    }
    const m = p.match(/^\/api\/agents\/([a-z0-9-]+)(?:\/(message|stop|messages))?$/);
    if (m) {
      const a = agents.get(m[1]);
      if (!a) return json(res, 404, { error: 'not found' });
      if (!m[2] && req.method === 'DELETE') {
        stopAgent(a);
        agents.delete(a.id);
        broadcast('removed', { id: a.id });
        save();
        return json(res, 200, { ok: true });
      }
      if (m[2] === 'messages') return json(res, 200, a.messages);
      if (!m[2] && req.method === 'GET') return json(res, 200, publicAgent(a));
      if (m[2] === 'stop' && req.method === 'POST') { stopAgent(a); return json(res, 200, { ok: true }); }
      if (m[2] === 'message' && req.method === 'POST') {
        const b = await readBody(req);
        if (!b.text?.trim()) return json(res, 400, { error: 'text required' });
        if (a.status === 'running' || a.status === 'queued') return json(res, 409, { error: 'agent is busy' });
        if (b.model) a.model = b.model;
        await startBotRun(a, b.text.trim());
        return json(res, 200, { ok: true });
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log(`Port ${PORT} already in use. Agent Army is probably already running.`); process.exit(0); }
  throw e;
});
server.listen(PORT, HOST, () => {
  console.log(`[${new Date().toLocaleString()}] started`);
  console.log(`\n  Agent Army running at http://localhost:${PORT}`);
  console.log(`  Claude Code: ${CLAUDE.cmd}`);
  console.log(`  Max parallel workers: ${MAX_PARALLEL}  (set MAX_PARALLEL to change)\n`);
  telegram.start(); // idle until a bot token is set in Settings
  // Bring Docker + Dossier up with the dashboard (after a reboot Docker Desktop doesn't start itself).
  if (CONFIG.autoStartDossier !== false) {
    life.ensureDossier((m) => console.log(`  ${m}`)).catch((e) => console.log(`  Dossier auto-start failed: ${e.message}`));
  }
});

function shutdown() {
  for (const a of agents.values()) if (procs.has(a.id)) stopAgent(a);
  clearTimeout(saveTimer);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ agents: [...agents.values()], usage }, null, 1));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
