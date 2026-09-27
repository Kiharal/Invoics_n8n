// Yakwetu demo backend.
// Plays the part of Yakwetu's platform (catalog, users, purchases) and hosts the
// shared log store that n8n writes to and the live panel reads from.
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const env = process.env;
const PORT = Number(env.PORT || 3000);
const YAK_KEY = env.YAK_KEY || '';
const N8N_WEBHOOK_URL = env.N8N_WEBHOOK_URL || 'http://n8n:5678/webhook/yak/events';
const SITE = 'https://www.yakwetu.africa';

// D4: one compression function. Real minutes in, demo seconds out.
const compress = (realMin) => 5.1 * Math.log(1 + realMin);
const WINBACK_REAL_MIN = 43200; // 30 days

const catalog = require('./data/catalog.json').map((t) => ({ ...t, buy_url: `${SITE}/view/${t.view_id}` }));
const seedUsers = require('./data/users.json');

let state;
function resetState() {
  state = {
    users: seedUsers.map((u) => ({
      ...structuredClone(u),
      phone: env[u.phone_env] || '',
      last_active_at: Date.now(),
      winback: null, // { armed_at, fired }
    })),
    purchases: new Set(), // "user|title"
    seen: new Set(),
    logs: [],
    stats: { ios_waitlist: 0, desktop_non_chrome: 0, android: 0 },
    aiStubMode: 'good',
  };
  for (const u of state.users) for (const t of u.owned) state.purchases.add(`${u.id}|${t}`);
}
resetState();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/logs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'logs.html')));

const requireKey = (req, res, next) => {
  if (!YAK_KEY || req.get('x-yak-key') === YAK_KEY) return next();
  res.status(401).json({ error: 'missing or wrong x-yak-key' });
};
const userById = (id) => state.users.find((u) => u.id === id);
const titleById = (id) => catalog.find((t) => t.id === id);
const publicUser = (u) => {
  const { phone_env, ...rest } = u;
  return { ...rest, owned: [...state.purchases].filter((p) => p.startsWith(u.id + '|')).map((p) => p.split('|')[1]) };
};

// ---------- live log store ----------
const clients = new Set();
function addLog(row) {
  const entry = { id: state.logs.length + 1, ts: new Date().toISOString(), ...row };
  state.logs.push(entry);
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of clients) res.write(data);
  return entry;
}
app.post('/api/logs', requireKey, (req, res) => res.json(addLog(req.body || {})));
app.get('/api/logs', (req, res) => {
  const since = Number(req.query.since || 0);
  res.json(state.logs.filter((l) => l.id > since));
});
app.get('/api/logs/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(': connected\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

// ---------- platform data ----------
app.get('/api/catalog', (req, res) => res.json(catalog));
app.get('/api/users', (req, res) => res.json(state.users.map(publicUser)));
app.get('/api/users/:id', requireKey, (req, res) => {
  const u = userById(req.params.id);
  u ? res.json(publicUser(u)) : res.status(404).json({ error: 'unknown user' });
});
app.post('/api/users/:id/consent', (req, res) => {
  const u = userById(req.params.id);
  if (!u) return res.status(404).json({ error: 'unknown user' });
  Object.assign(u.consent, req.body || {});
  res.json(publicUser(u));
});

// One call n8n makes after the wait: who is this user, did they buy, and what can we pitch.
app.get('/api/context', requireKey, (req, res) => {
  const u = userById(req.query.user_id);
  if (!u) return res.status(404).json({ error: 'unknown user' });
  const title = req.query.title_id ? titleById(req.query.title_id) || null : null;
  res.json({
    user: publicUser(u),
    title,
    purchased: title ? state.purchases.has(`${u.id}|${title.id}`) : false,
    catalog,
  });
});

app.post('/api/purchases', (req, res) => {
  const { user_id, title_id, nid } = req.body || {};
  const u = userById(user_id);
  const t = titleById(title_id);
  if (!u || !t) return res.status(400).json({ error: 'unknown user or title' });
  state.purchases.add(`${u.id}|${t.id}`);
  u.last_active_at = Date.now();
  if (u.winback) u.winback = null;
  addLog({ stage: 'purchased', status: 'ok', user_id: u.id, title_id: t.id, nudge_id: nid || null,
    message: `${u.name} bought ${t.name} for KES ${t.price_kes}` });
  res.json({ ok: true });
});

app.post('/api/dedupe', requireKey, (req, res) => {
  const id = (req.body || {}).event_id;
  if (!id) return res.status(400).json({ error: 'event_id required' });
  const seen = state.seen.has(id);
  state.seen.add(id);
  res.json({ seen });
});

// ---------- win-back ----------
// The presenter "arms" a user. After compress(30 days) of real idle time, the n8n scan picks them up.
app.post('/api/users/:id/inactive', (req, res) => {
  const u = userById(req.params.id);
  if (!u) return res.status(404).json({ error: 'unknown user' });
  u.last_active_at = Date.now();
  u.winback = { armed_at: Date.now(), fired: false };
  addLog({ stage: 'inactive_armed', status: 'ok', branch: 'winback', user_id: u.id,
    real_delay_min: WINBACK_REAL_MIN, demo_delay_s: Number(compress(WINBACK_REAL_MIN).toFixed(1)),
    message: `${u.name} goes quiet. Win-back is due after 30 days of inactivity.` });
  res.json({ ok: true });
});
app.get('/api/users-inactive', requireKey, (req, res) => {
  const thresholdS = Number(req.query.threshold_s || compress(WINBACK_REAL_MIN));
  const due = state.users.filter((u) => u.winback && !u.winback.fired && (Date.now() - u.last_active_at) / 1000 >= thresholdS);
  for (const u of due) u.winback.fired = true;
  res.json(due.map((u) => ({ user_id: u.id, idle_s: Math.round((Date.now() - u.last_active_at) / 1000) })));
});

// ---------- events: storefront -> backend -> n8n ----------
app.post('/api/events', async (req, res) => {
  const b = req.body || {};
  const u = userById(b.user_id);
  if (!b.event || !u) return res.status(400).json({ error: 'event and a known user_id are required' });
  const evt = {
    event_id: b.event_id || crypto.randomUUID(),
    event: b.event,
    ts: new Date().toISOString(),
    user_id: u.id,
    title_id: b.title_id || null,
    context: b.context || {},
    demo_mode: b.demo_mode !== false,
  };
  if (evt.event !== 'winback_due') u.last_active_at = Date.now();
  if (evt.event === 'unsupported_device' && state.stats[platformKey(evt.context.platform)] !== undefined) {
    state.stats[platformKey(evt.context.platform)] += 1;
  }
  const t = evt.title_id ? titleById(evt.title_id) : null;
  addLog({ stage: 'fired', status: 'ok', event_id: evt.event_id, event: evt.event, user_id: u.id, title_id: evt.title_id,
    message: describeEvent(evt, u, t), replay: Boolean(b.event_id) });
  try {
    const r = await fetch(N8N_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evt) });
    if (!r.ok) throw new Error(`n8n answered ${r.status}`);
    res.json({ ok: true, event: evt });
  } catch (e) {
    addLog({ stage: 'failed', status: 'error', event_id: evt.event_id, user_id: u.id,
      reason: 'n8n_unreachable', message: `Could not reach n8n at ${N8N_WEBHOOK_URL}. Is the workflow active? (${e.message})` });
    res.status(502).json({ ok: false, error: e.message, event: evt });
  }
});
const platformKey = (p) => (p === 'ios' ? 'ios_waitlist' : p);
function describeEvent(evt, u, t) {
  const name = t ? t.name : 'a title';
  switch (evt.event) {
    case 'preview_completed': return `${u.name} watched the free preview of ${name} and left without buying`;
    case 'title_viewed': return `${u.name} viewed ${name} and left`;
    case 'payment_failed': return `${u.name}'s payment for ${name} failed (${evt.context.failure_reason})`;
    case 'unsupported_device': return `${u.name} tried to buy ${name} on an unsupported device (${evt.context.platform})`;
    case 'auth_abandoned': return `${u.name} hit the sign-in page from BUY on ${name} and left`;
    case 'winback_due': return `Scheduler found ${u.name} inactive past the win-back threshold`;
    default: return `${evt.event} for ${u.name}`;
  }
}

// ---------- delivery adapters (n8n decides the channel, this sends) ----------
let mailer = null;
if (env.SMTP_HOST) {
  mailer = nodemailer.createTransport({
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 2525),
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
}
async function sendEmail(u, subject, text) {
  if (!mailer) return { mode: 'simulated', detail: 'SMTP_HOST not set; message logged only' };
  const info = await mailer.sendMail({ from: env.MAIL_FROM || 'YAKWETU <nudges@demo.yakwetu.test>', to: u.email, subject, text });
  return { mode: 'live', detail: info.messageId };
}
async function sendWhatsApp(u, text) {
  if (!env.WA_TOKEN || !env.WA_PHONE_NUMBER_ID) return { mode: 'simulated', detail: 'WhatsApp credentials not set; message logged only' };
  if (!u.phone) return { mode: 'simulated', detail: `${u.phone_env} not set for this user` };
  const url = `https://graph.facebook.com/${env.WA_GRAPH_VERSION || 'v21.0'}/${env.WA_PHONE_NUMBER_ID}/messages`;
  // Free-form text works inside a 24h window (have the test phone message your test number first).
  // Set WA_TEMPLATE_NAME to send an approved template with the message as its single body parameter.
  const payload = env.WA_TEMPLATE_NAME
    ? { messaging_product: 'whatsapp', to: u.phone, type: 'template', template: { name: env.WA_TEMPLATE_NAME, language: { code: env.WA_TEMPLATE_LANG || 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text }] }] } }
    : { messaging_product: 'whatsapp', to: u.phone, type: 'text', text: { body: text, preview_url: true } };
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ? body.error.message : `WhatsApp API ${r.status}`);
  return { mode: 'live', detail: body.messages ? body.messages[0].id : 'accepted' };
}

app.post('/api/deliver', requireKey, async (req, res) => {
  const b = req.body || {};
  const u = userById(b.user_id);
  if (!u) return res.status(400).json({ error: 'unknown user' });
  const base = { event_id: b.event_id, nudge_id: b.nudge_id, branch: b.branch, user_id: u.id, title_id: b.title_id || null,
    channel: b.channel, source: b.source, message: b.message, reason: b.source_reason || null };
  try {
    let result;
    if (b.channel === 'email') result = await sendEmail(u, b.subject || 'YAKWETU', b.message);
    else if (b.channel === 'whatsapp') result = await sendWhatsApp(u, b.message);
    else if (b.channel === 'sms') result = { mode: 'logged', detail: 'SMS is logged, not sent, in the demo (D6)' };
    else return res.status(400).json({ error: 'unknown channel' });
    addLog({ ...base, stage: 'sent', status: 'ok', delivery: result.mode, detail: result.detail });
    res.json({ ok: true, ...result });
  } catch (e) {
    addLog({ ...base, stage: 'failed', status: 'error', delivery: 'failed', detail: e.message });
    res.json({ ok: false, error: e.message });
  }
});

// ---------- offline AI stub (for machines without Ollama, and for guardrail drills) ----------
app.post('/mock-ollama/api/chat', async (req, res) => {
  const text = ((req.body || {}).messages || []).map((m) => m.content).join('\n');
  const ids = [...text.matchAll(/"id":\s*"(t_[a-z0-9_]+)"/g)].map((m) => m[1]);
  const names = [...text.matchAll(/"name":\s*"([^"]+)"/g)].map((m) => m[1]);
  const pick = ids[0] || 'unknown';
  const name = names[0] || 'this film';
  const mode = state.aiStubMode;
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 25000));
  const message = mode === 'bad'
    ? `Hurry! Limited offer, 50% off ${name} expires tonight.`
    : `${name} is still waiting for you on YAKWETU. Membership is free, you pay once with M-Pesa and own it forever.`;
  res.json({ model: 'stub', message: { role: 'assistant', content: JSON.stringify({ pick_title_id: pick, reason: 'stub picked the first candidate', message }) }, done: true });
});
app.post('/api/admin/ai-stub-mode', (req, res) => {
  const mode = (req.body || {}).mode;
  if (!['good', 'bad', 'slow'].includes(mode)) return res.status(400).json({ error: 'mode must be good, bad or slow' });
  state.aiStubMode = mode;
  res.json({ mode });
});

// ---------- demo admin ----------
app.get('/api/stats', (req, res) => {
  const count = (stage) => state.logs.filter((l) => l.stage === stage).length;
  res.json({ ...state.stats, sent: count('sent'), suppressed: count('suppressed'), failed: count('failed'), purchased: count('purchased'), aiStubMode: state.aiStubMode });
});
app.post('/api/admin/reset', (req, res) => {
  resetState();
  for (const c of clients) c.write(`event: reset\ndata: {}\n\n`);
  res.json({ ok: true });
});
app.get('/api/health', (req, res) => res.json({ ok: true, n8n: N8N_WEBHOOK_URL, smtp: Boolean(mailer), whatsapp: Boolean(env.WA_TOKEN) }));

app.listen(PORT, () => console.log(`Yakwetu demo backend on :${PORT} (n8n webhook: ${N8N_WEBHOOK_URL})`));
