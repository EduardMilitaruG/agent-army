// Telegram bridge: talk to your bots from your phone and get the morning brief and alerts.
// Only chats paired with the code shown in Settings can use it; everyone else gets one line and nothing more.
// It uses Telegram's official Bot API (long polling): no public URL or open port on this PC.
const API = 'https://api.telegram.org';

function createTelegram({ extras, onChat, listBots, today, log = () => {} }) {
  let running = false; let offset = 0; let currentToken = '';
  const pendingNew = new Set(); // chats whose next message should start a new conversation

  const call = async (token, method, body) => {
    const r = await fetch(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 20000) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description || `Telegram ${method} failed (${r.status})`);
    return j.result;
  };
  const plain = (t) => String(t || '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^#+\s*/gm, '').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)');
  async function send(chatId, text) {
    const token = extras.getSettings().telegram.token; if (!token) return;
    const t = plain(text).trim() || '(empty)';
    for (let i = 0; i < t.length; i += 3900) await call(token, 'sendMessage', { chat_id: chatId, text: t.slice(i, i + 3900), disable_web_page_preview: true });
  }
  async function broadcast(text) {
    for (const c of extras.getSettings().telegram.chats) await send(c.id, text).catch((e) => log(`telegram send failed: ${e.message}`));
  }

  async function download(token, fileId, name) {
    const f = await call(token, 'getFile', { file_id: fileId });
    const r = await fetch(`${API}/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('could not download the file');
    return extras.saveUpload(name || f.file_path.split('/').pop(), Buffer.from(await r.arrayBuffer()));
  }

  const HELP = 'Talk to me like in the dashboard: your message goes to the Chief of Staff.\n\nTo talk to another bot, start with its id, e.g.\n/coach I trained 40 min\n/hobbies next Rubik step\n\n/bots: the team\n/today: your day in short\n/new: next message starts a fresh conversation\n\nYou can also send photos and files.';

  async function handle(token, msg) {
    const chat = msg.chat; const s = extras.getSettings();
    const text = String(msg.text || msg.caption || '').trim();
    const paired = s.telegram.chats.some((c) => String(c.id) === String(chat.id));
    if (!paired) {
      const m = text.match(/^\/start\s+(\d{6})$/);
      if (m && m[1] === s.telegram.pairCode) {
        extras.pairTelegramChat(chat.id, [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id));
        return send(chat.id, `Paired. This chat now talks to your Agent Army.\n\n${HELP}`);
      }
      return call(token, 'sendMessage', { chat_id: chat.id, text: 'This bot is private. Pair it from the Agent Army dashboard: Settings > Telegram.' }).catch(() => {});
    }
    if (text === '/help' || text === '/start') return send(chat.id, HELP);
    if (text === '/bots') return send(chat.id, (await listBots()).map((b) => `/${b.id}  ${b.name}: ${b.description}`).join('\n\n'));
    if (text === '/new') { pendingNew.add(chat.id); return send(chat.id, 'OK, your next message starts a new conversation.'); }
    if (text === '/today') {
      const t = await today(true); const j = t.jobs;
      return send(chat.id, [`Today ${t.date}`, j.online ? `Jobs: ${j.sentThisWeek.length}/5 sent this week, ${j.drafts.length} drafts to review${j.replies.length ? `, ${j.replies.length} replies` : ''}` : 'Dossier is off', `Study: streak ${t.study.streak}, drill today: ${t.study.doneToday ? 'done' : 'not yet'}`, `Training this week: ${t.habits.gymThisWeek}`, t.next[0] ? `Next run: ${new Date(t.next[0].at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} ${t.next[0].bot}` : ''].filter(Boolean).join('\n'));
    }
    // Route: "/coach ..." or "coach: ..." to that bot, otherwise the Chief of Staff.
    const bots = await listBots();
    let botId = 'chief'; let body = text;
    const m = text.match(/^\/?([a-z0-9-]+)[:\s]\s*([\s\S]*)$/i);
    if (m && bots.some((b) => b.id === m[1].toLowerCase()) && (text.startsWith('/') || text.includes(':'))) { botId = m[1].toLowerCase(); body = m[2].trim(); }
    if (!bots.some((b) => b.id === botId)) botId = bots[0]?.id;
    // Attachments
    const files = [];
    try {
      if (msg.photo?.length) files.push(await download(token, msg.photo[msg.photo.length - 1].file_id, `telegram-photo-${msg.message_id}.jpg`));
      if (msg.document) files.push(await download(token, msg.document.file_id, msg.document.file_name));
      if (msg.voice || msg.audio || msg.video) return send(chat.id, 'Voice notes and videos are not supported yet: please type it, or send the file as a document.');
    } catch (e) { return send(chat.id, `Could not take that file: ${e.message}`); }
    if (!body && !files.length) return send(chat.id, HELP);
    const full = [body || 'See the attached file.', ...files.map((f) => `[Attached file: ${f.path}]`)].join('\n\n');
    const newChat = pendingNew.delete(chat.id);
    try {
      const bot = bots.find((b) => b.id === botId);
      await call(token, 'sendChatAction', { chat_id: chat.id, action: 'typing' }).catch(() => {});
      await onChat(botId, full, { newChat, telegramChat: chat.id });
      if (botId !== 'chief') await send(chat.id, `Sent to ${bot.name}. I'll reply here when it answers.`);
    } catch (e) { await send(chat.id, e.message); }
  }

  async function loop() {
    while (running) {
      const token = extras.getSettings().telegram.token;
      if (!token) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      if (token !== currentToken) { currentToken = token; offset = 0; }
      try {
        const updates = await call(token, 'getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
        for (const u of updates) { offset = u.update_id + 1; if (u.message) await handle(token, u.message).catch((e) => log(`telegram: ${e.message}`)); }
      } catch (e) {
        log(`telegram poll: ${e.message}`);
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  }

  return {
    start() { if (!running) { running = true; loop(); } },
    send, broadcast,
    async test() {
      const s = extras.getSettings();
      if (!s.telegram.token) throw new Error('Add the bot token first.');
      const me = await call(s.telegram.token, 'getMe');
      if (s.telegram.chats.length) await broadcast('Test from Agent Army: Telegram works.');
      return { bot: `@${me.username}`, pairedChats: s.telegram.chats.length };
    },
  };
}

module.exports = { createTelegram };
