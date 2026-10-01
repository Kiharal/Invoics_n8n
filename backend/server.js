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

const DAY_MS = 86400000;
let state;
function resetState() {
  state = {
    users: seedUsers.map((u) => ({
      ...structuredClone(u),
      phone: env[u.phone_env] || '',
      last_active_at: Date.now(),
      winback: null, // { armed_at, fired }
      // Seed history: past purchases spread over the last few weeks, so the AI lane has something to talk about.
      activity: u.owned.map((t, i) => ({ event: 'purchased', title_id: t, at: Date.now() - (u.owned.length - i) * 9 * DAY_MS })),
    })),
    purchases: new Set(), // "user|title"
    seen: new Set(),
    tracked: new Set(), // event_ids already added to a user's activity
    locks: new Map(), // nudge lock key -> expiry (ms)
    logs: [],
    stats: { ios_waitlist: 0, desktop_non_chrome: 0, android: 0 },
    aiStubMode: 'good',
    emailLive: true, // load and stress tools switch this off so they don't burn the Mailtrap quota
  };
  for (const u of state.users) for (const t of u.owned) state.purchases.add(`${u.id}|${t}`);
}
const ACTIVITY_MAX = 20;
function track(u, event, title_id) {
  u.activity.push({ event, title_id: title_id || null, at: Date.now() });
  if (u.activity.length > ACTIVITY_MAX) u.activity.splice(0, u.activity.length - ACTIVITY_MAX);
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
const ownedIds = (u) => [...state.purchases].filter((p) => p.startsWith(u.id + '|')).map((p) => p.split('|')[1]);
const publicUser = (u) => {
  const { phone_env, activity, ...rest } = u;
  return { ...rest, owned: ownedIds(u) };
};
// What the engine knows about this viewer's taste. Facts only; n8n decides what to do with them.
function profile(u) {
  const owned = ownedIds(u).map(titleById).filter(Boolean);
  const genre_counts = {};
  for (const t of owned) genre_counts[t.genre] = (genre_counts[t.genre] || 0) + 1;
  const ranked = Object.entries(genre_counts).sort((a, b) => b[1] - a[1]);
  const VERB = { purchased: 'bought', preview_completed: 'watched the preview of', title_viewed: 'looked at',
    payment_failed: 'tried to pay for', unsupported_device: 'tried to buy', auth_abandoned: 'tried to buy' };
  const recent = u.activity.slice(-6).reverse().filter((a) => VERB[a.event] && titleById(a.title_id))
    .map((a) => ({ event: a.event, title_id: a.title_id, title: titleById(a.title_id).name, text: VERB[a.event] + ' ' + titleById(a.title_id).name, days_ago: Math.floor((Date.now() - a.at) / DAY_MS) }));
  return {
    favourite_genre: ranked.length ? ranked[0][0] : u.top_genre,
    genre_counts,
    owned_titles: owned.map((t) => ({ id: t.id, name: t.name, genre: t.genre, tags: t.tags || [] })),
    recent,
  };
}

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
// Consent changes are evidence: each one is logged with before, after and where it came from.
const CHANNELS = ['whatsapp', 'sms', 'email'];
app.post('/api/users/:id/consent', (req, res) => {
  const u = userById(req.params.id);
  if (!u) return res.status(404).json({ error: 'unknown user' });
  const b = req.body || {};
  const changes = CHANNELS.filter((c) => typeof b[c] === 'boolean' && b[c] !== u.consent[c]);
  const before = { ...u.consent };
  for (const c of changes) u.consent[c] = b[c];
  if (changes.length) {
    const label = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'email' };
    addLog({ stage: 'consent_changed', status: 'ok', user_id: u.id, before, after: { ...u.consent },
      source: typeof b.source === 'string' ? b.source.slice(0, 40) : 'storefront',
      message: `${u.name} ${changes.map((c) => (u.consent[c] ? 'opted in to ' : 'opted out of ') + label[c]).join(', ')}` });
  }
  res.json(publicUser(u));
});

// One call n8n makes after the wait: who is this user, did they buy, and what can we pitch.
app.get('/api/context', requireKey, (req, res) => {
  const u = userById(req.query.user_id);
  if (!u) return res.status(404).json({ error: 'unknown user' });
  const title = req.query.title_id ? titleById(req.query.title_id) || null : null;
  res.json({
    user: publicUser(u),
    profile: profile(u),
    title,
    purchased: title ? state.purchases.has(`${u.id}|${title.id}`) : false,
    catalog,
  });
});

// Last-moment re-check, called right before delivery (the AI call can take seconds).
app.get('/api/purchase-check', requireKey, (req, res) => {
  const u = userById(req.query.user_id);
  if (!u) return res.status(404).json({ error: 'unknown user' });
  const ids = String(req.query.title_ids || '').split(',').filter(Boolean);
  res.json({ purchased: ids.filter((t) => state.purchases.has(`${u.id}|${t}`)) });
});

// Nudge lock: the first nudge for a key within ttl_s wins; later ones are suppressed by n8n.
// Stops "preview then view the same film" from producing two identical nudges.
app.post('/api/locks', requireKey, (req, res) => {
  const { key, ttl_s } = req.body || {};
  if (!key) return res.json({ claimed: true, key: null });
  const now = Date.now();
  const until = state.locks.get(key);
  if (until && until > now) return res.json({ claimed: false, key, retry_in_s: Math.ceil((until - now) / 1000) });
  state.locks.set(key, now + Math.max(1, Number(ttl_s) || 60) * 1000);
  res.json({ claimed: true, key });
});

// Attribution: a purchase that arrives with the nudge id from the message link (?nid=) is credited to that nudge,
// if the nudge was really sent to this viewer for this title. Last-click, no holdout: attributed revenue, not lift.
app.post('/api/purchases', (req, res) => {
  const { user_id, title_id, nid } = req.body || {};
  const u = userById(user_id);
  const t = titleById(title_id);
  if (!u || !t) return res.status(400).json({ error: 'unknown user or title' });
  const isNew = !state.purchases.has(`${u.id}|${t.id}`);
  if (isNew) track(u, 'purchased', t.id);
  state.purchases.add(`${u.id}|${t.id}`);
  u.last_active_at = Date.now();
  if (u.winback) u.winback = null;
  const nudge = nid ? state.logs.find((l) => l.stage === 'sent' && l.nudge_id === nid && l.user_id === u.id && l.title_id === t.id) : null;
  const credit = nudge && isNew && !state.logs.some((l) => l.stage === 'purchased' && l.nudge_id === nid);
  addLog({ stage: 'purchased', status: 'ok', user_id: u.id, title_id: t.id, nudge_id: credit ? nid : null,
    event_id: credit ? nudge.event_id : undefined, branch: credit ? nudge.branch : undefined, channel: credit ? nudge.channel : undefined,
    attributed: Boolean(credit), revenue_kes: isNew ? t.price_kes : 0,
    message: `${u.name} bought ${t.name} for KES ${t.price_kes}` + (credit ? ` from the ${nudge.channel} nudge (${nid})` : '') });
  res.json({ ok: true, attributed: Boolean(credit) });
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
  if (typeof b.event !== 'string') return res.status(400).json({ error: 'event must be a string' });
  if (b.event_id !== undefined && !/^[A-Za-z0-9._:-]{1,64}$/.test(String(b.event_id))) return res.status(400).json({ error: 'event_id must be 1-64 of A-Z a-z 0-9 . _ : -' });
  if (b.title_id && !titleById(b.title_id)) return res.status(400).json({ error: 'unknown title_id' });
  const evt = {
    event_id: b.event_id || crypto.randomUUID(),
    event: b.event,
    ts: new Date().toISOString(),
    user_id: u.id,
    title_id: b.title_id || null,
    context: b.context || {},
    demo_mode: b.demo_mode !== false,
  };
  if (evt.event !== 'winback_due') {
    u.last_active_at = Date.now();
    if (!state.tracked.has(evt.event_id)) track(u, evt.event, evt.title_id); // replays are not new activity
    state.tracked.add(evt.event_id);
  }
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
    case 'payment_failed': {
      const method = { mpesa: 'M-Pesa', bonga: 'Bonga points', visa: 'Visa', mastercard: 'Mastercard' }[evt.context.payment_method];
      if (evt.context.failure_reason === 'card_declined') return `${u.name}'s ${method ? method + ' ' : ''}card was declined for ${name}`;
      return `${u.name}'s ${method ? method + ' ' : ''}payment for ${name} did not complete`;
    }
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
// Mailtrap's Sandbox Sending API goes over HTTPS, so it works on networks that block outbound SMTP (most venue Wi-Fi).
const MAILTRAP_API = env.MAILTRAP_API_TOKEN && env.MAILTRAP_TEST_INBOX_ID;
const emailMode = () => (MAILTRAP_API ? 'mailtrap-api' : mailer ? 'smtp' : 'simulated');
async function sendEmail(u, subject, text) {
  if (!state.emailLive) return { mode: 'simulated', detail: 'email switched off for this test run (POST /api/admin/email)' };
  if (MAILTRAP_API) {
    const from = (env.MAIL_FROM || 'YAKWETU <nudges@demo.yakwetu.test>').match(/^(?:(.*)<)?\s*([^<>\s]+@[^<>\s]+)\s*>?$/) || [];
    const r = await fetch(`https://sandbox.api.mailtrap.io/api/send/${env.MAILTRAP_TEST_INBOX_ID}`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.MAILTRAP_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: { email: from[2] || 'nudges@demo.yakwetu.test', name: (from[1] || 'YAKWETU').trim() }, to: [{ email: u.email, name: u.name }],
        subject, text, category: 'yak-engine' }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.success === false) throw new Error('Mailtrap API ' + r.status + ': ' + JSON.stringify(body.errors || body).slice(0, 160));
    return { mode: 'live', detail: 'Mailtrap sandbox ' + ((body.message_ids || [])[0] || 'accepted') };
  }
  if (!mailer) return { mode: 'simulated', detail: 'no MAILTRAP_API_TOKEN/MAILTRAP_TEST_INBOX_ID or SMTP_HOST set; message logged only' };
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
  // Last line of defence: the adapter never sends on a channel the viewer has not consented to,
  // even if a workflow bug asks it to.
  if (!u.consent[b.channel]) {
    addLog({ ...base, stage: 'failed', status: 'error', delivery: 'refused', reason: 'no_consent_for_channel', detail: `${u.name} has not consented to ${b.channel}` });
    return res.json({ ok: false, error: 'no consent for channel' });
  }
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

// ---------- AI: proxy to the real model, or the stub for guardrail drills ----------
// n8n calls /ai/api/chat. "good" forwards to the real model (OLLAMA_URL); "bad" and "slow" answer from the stub,
// so the panel can force a guardrail rejection or a timeout on the real stack.
const REAL_MODEL = env.OLLAMA_URL && !env.OLLAMA_URL.includes('mock-ollama') && !env.OLLAMA_URL.includes('/ai') ? env.OLLAMA_URL : null;
app.post('/ai/api/chat', async (req, res) => {
  if (state.aiStubMode !== 'good' || !REAL_MODEL) return stubChat(req, res);
  try {
    const r = await fetch(`${REAL_MODEL}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}), signal: AbortSignal.timeout(120000) });
    res.status(r.status).type('application/json').send(await r.text());
  } catch (e) {
    res.status(502).json({ error: 'model unreachable: ' + e.message });
  }
});

// ---------- offline AI stub (for machines without Ollama, and for guardrail drills) ----------
app.post('/mock-ollama/api/chat', (req, res) => stubChat(req, res));
async function stubChat(req, res) {
  // The last message is the JSON brief built by the n8n Policy gate. The stub reuses its facts,
  // so offline demos still show a message tied to the viewer, but it is not a language model.
  const msgs = (req.body || {}).messages || [];
  // Newest brief wins; on a retry the last message is the rejection note, so skip anything that is not a brief.
  let brief = {};
  for (const m of [...msgs].reverse()) {
    try { const j = JSON.parse(m.content); if (m.role === 'user' && j.candidates) { brief = j; break; } } catch (e) { /* not a brief */ }
  }
  const c = (brief.candidates || [])[0] || { id: "unknown", name: "this film", story: "" };
  const first = (brief.viewer || {}).first_name || 'Hi';
  const mode = state.aiStubMode;
  // Longer than the pipeline's 25 s model timeout, so "Times out" really times out.
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 30000));
  if (res.headersSent || res.destroyed) return;
  const message = mode === 'bad'
    ? `Hurry! Limited offer, 50% off ${c.name} expires tonight.`
    : `${first}, ${c.name}: ${c.story} Pay once with M-Pesa and it's yours forever.`;
  res.json({ model: 'stub', message: { role: 'assistant', content: JSON.stringify({ pick_title_id: c.id, reason: 'stub picked the first candidate: ' + (c.why_for_viewer || ''), message }) }, done: true });
}
app.post('/api/admin/ai-stub-mode', (req, res) => {
  const mode = (req.body || {}).mode;
  if (!['good', 'bad', 'slow'].includes(mode)) return res.status(400).json({ error: 'mode must be good, bad or slow' });
  state.aiStubMode = mode;
  res.json({ mode });
});
app.post('/api/admin/email', (req, res) => {
  state.emailLive = (req.body || {}).live !== false;
  res.json({ live: state.emailLive, mode: emailMode() });
});

// ---------- demo admin ----------
const attributed = () => state.logs.filter((l) => l.stage === 'purchased' && l.attributed);
app.get('/api/stats', (req, res) => {
  const count = (stage) => state.logs.filter((l) => l.stage === stage).length;
  res.json({ ...state.stats, sent: count('sent'), suppressed: count('suppressed'), failed: count('failed'), purchased: count('purchased'),
    attributed: attributed().length, attributed_kes: attributed().reduce((s, l) => s + (l.revenue_kes || 0), 0), aiStubMode: state.aiStubMode });
});

// Funnel per branch and channel, straight from the log: what came in, what was held and why, what went out, what it earned.
app.get('/api/funnel', (req, res) => {
  const f = {};
  const row = (branch) => (f[branch] = f[branch] || { branch, events: 0, duplicates: 0, suppressed: {}, sent: {}, failed: 0, purchases: 0, revenue_kes: 0 });
  const runs = new Map();
  for (const l of state.logs) if (l.event_id && l.branch && !runs.has(l.event_id)) runs.set(l.event_id, l.branch);
  for (const b of runs.values()) row(b).events++;
  for (const l of state.logs) {
    if (!l.branch) continue;
    const r = row(l.branch);
    if (l.stage === 'duplicate') r.duplicates++;
    else if (l.stage === 'suppressed') r.suppressed[l.reason] = (r.suppressed[l.reason] || 0) + 1;
    else if (l.stage === 'sent') r.sent[l.channel] = (r.sent[l.channel] || 0) + 1;
    else if (l.stage === 'failed') r.failed++;
    else if (l.stage === 'purchased' && l.attributed) { r.purchases++; r.revenue_kes += l.revenue_kes || 0; }
  }
  res.json(Object.values(f));
});

// Every log row as CSV, for the client's spreadsheet or GA4 import.
app.get('/api/export.csv', (req, res) => {
  const cols = ['id', 'ts', 'stage', 'status', 'reason', 'branch', 'event_id', 'nudge_id', 'user_id', 'title_id', 'channel', 'source', 'delivery', 'attributed', 'revenue_kes', 'message'];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""') + '"' : s; };
  res.type('text/csv').attachment('yak-engine-log.csv').send([cols.join(','), ...state.logs.map((l) => cols.map((c) => esc(l[c])).join(','))].join('\n'));
});
app.post('/api/admin/reset', (req, res) => {
  resetState();
  for (const c of clients) c.write(`event: reset\ndata: {}\n\n`);
  res.json({ ok: true });
});
app.get('/api/health', (req, res) => res.json({ ok: true, n8n: N8N_WEBHOOK_URL, email: emailMode(), email_live: state.emailLive, smtp: Boolean(mailer), whatsapp: Boolean(env.WA_TOKEN), model: REAL_MODEL ? 'real' : 'stub', key_required: Boolean(YAK_KEY) }));

// Load the model into memory up front, so the first AI nudge on stage is not a cold start.
async function warmModel() {
  const url = env.OLLAMA_URL || '';
  if (!url || url.includes('mock-ollama')) return { ok: true, detail: 'stub in use, nothing to warm' };
  try {
    const r = await fetch(`${url}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.OLLAMA_MODEL || 'qwen2.5:7b', keep_alive: '30m' }), signal: AbortSignal.timeout(120000) });
    const body = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, detail: 'model loaded' } : { ok: false, detail: body.error || `Ollama answered ${r.status}` };
  } catch (e) { return { ok: false, detail: e.message }; }
}
app.post('/api/admin/warm-ai', async (req, res) => res.json(await warmModel()));

app.listen(PORT, () => {
  console.log(`Yakwetu demo backend on :${PORT} (n8n webhook: ${N8N_WEBHOOK_URL})`);
  warmModel().then((r) => console.log(`AI warm-up: ${r.ok ? 'ok' : 'FAILED'} (${r.detail})`));
});
