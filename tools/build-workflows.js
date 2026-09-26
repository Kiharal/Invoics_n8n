// Builds the importable n8n workflows into /workflows.
// Run: node tools/build-workflows.js
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'workflows');
const PIPELINE_ID = 'yakPipeline00001';
const WINBACK_ID = 'yakWinbackScan01';
const ERRORS_ID = 'yakErrorAlerts01';

let nid = 0;
const uid = () => `00000000-0000-4000-8000-${String(++nid).padStart(12, '0')}`;

const code = (name, x, y, jsCode) => ({
  id: uid(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [x, y],
  parameters: { jsCode },
});

// HTTP Request node. url and body are n8n expressions (without the leading "=").
const http = (name, x, y, { method = 'GET', url, body, timeout = 10000, continueOnFail = false, auth = true }) => {
  const parameters = {
    method, url: `=${url}`,
    options: { timeout },
  };
  if (auth) {
    parameters.sendHeaders = true;
    parameters.headerParameters = { parameters: [{ name: 'x-yak-key', value: "={{ $('Settings').first().json.yak_key }}" }] };
  }
  if (body) {
    parameters.sendBody = true;
    parameters.specifyBody = 'json';
    parameters.jsonBody = `=${body}`;
  }
  const node = { id: uid(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [x, y], parameters };
  if (continueOnFail) node.onError = 'continueRegularOutput';
  return node;
};

const ifTrue = (name, x, y, expr) => ({
  id: uid(), name, type: 'n8n-nodes-base.if', typeVersion: 2, position: [x, y],
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [{ id: uid(), leftValue: `={{ ${expr} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    options: {},
  },
});

const link = (conn, from, to, output = 0) => {
  conn[from] = conn[from] || { main: [] };
  while (conn[from].main.length <= output) conn[from].main.push([]);
  conn[from].main[output].push({ node: to, type: 'main', index: 0 });
};

// ---------------------------------------------------------------- settings
// One place for configuration. Reads container env vars when n8n allows it, else uses defaults.
const SETTINGS_CODE = `
const env = (k, d) => { try { return ($env && $env[k]) || d; } catch (e) { return d; } };
return [{ json: {
  backend_url: env('BACKEND_URL', 'http://backend:3000'),
  yak_key: env('YAK_KEY', ''),
  ollama_url: env('OLLAMA_URL', 'http://ollama:11434'),
  ollama_model: env('OLLAMA_MODEL', 'qwen2.5:7b'),
  whatsapp_min_kes: Number(env('WHATSAPP_MIN_KES', 149)),
  android_app_url: env('ANDROID_APP_URL', 'https://www.yakwetu.africa'),
} }];`;

// ---------------------------------------------------------------- pipeline code
const BRANCH_CONFIG = `
// D1: a branch is a trigger plus a config block. Delays are always in REAL minutes (D4).
const BRANCHES = {
  payment_failed:     { branch: 'B_payment',     delay_real_min: 1,   lane: 'template', kind: 'utility' },
  unsupported_device: { branch: 'B_device',      delay_real_min: 0,   lane: 'template', kind: 'utility' },
  preview_completed:  { branch: 'A_browse',      delay_real_min: 120, lane: 'ai',       kind: 'marketing' },
  title_viewed:       { branch: 'A_browse',      delay_real_min: 120, lane: 'ai',       kind: 'marketing' },
  auth_abandoned:     { branch: 'signup_rescue', delay_real_min: 20,  lane: 'template', kind: 'marketing' },
  winback_due:        { branch: 'winback',       delay_real_min: 0,   lane: 'ai',       kind: 'marketing' },
};
// D4: the only place real time becomes demo time.
const compress = (realMin) => 5.1 * Math.log(1 + realMin);

const evt = $('Event in').first().json.body || {};
const missing = ['event_id', 'event', 'user_id'].filter((k) => !evt[k]);
const cfg = BRANCHES[evt.event];
const demo = evt.demo_mode !== false;
let invalid = null;
if (missing.length) invalid = 'missing ' + missing.join(', ');
else if (!cfg) invalid = 'no branch handles ' + evt.event;

const real = cfg ? cfg.delay_real_min : 0;
const wait_s = demo ? Number(compress(real).toFixed(1)) : real * 60;
return [{ json: {
  evt, ...(cfg || {}), invalid, demo_mode: demo,
  real_delay_min: real, wait_s,
  nudge_id: 'n_' + Math.random().toString(36).slice(2, 10),
} }];`;

const ADMIT = `
const c = $('Branch config').first().json;
const human = (m) => m < 60 ? m + (m === 1 ? ' minute' : ' minutes') : m < 1440 ? (m / 60) + ' hours' : Math.round(m / 1440) + ' days';
const seen = $json.seen === true;
const base = { event_id: c.evt.event_id || null, nudge_id: c.nudge_id, branch: c.branch || null, user_id: c.evt.user_id || null, title_id: c.evt.title_id || null };
let log;
if (c.invalid) log = { ...base, stage: 'suppressed', at: 'admit', status: 'stop', reason: 'invalid_event', message: 'Rejected: ' + c.invalid };
else if (seen) log = { ...base, stage: 'duplicate', at: 'admit', status: 'stop', reason: 'duplicate_event', message: 'Already handled this event_id, ignored' };
else log = { ...base, stage: 'waiting', status: 'ok', real_delay_min: c.real_delay_min, demo_delay_s: c.wait_s,
  message: c.real_delay_min === 0 ? 'No wait for this branch' : 'Waiting ' + c.wait_s + ' s, standing in for ' + human(c.real_delay_min) + ', then re-checking' };
return [{ json: { proceed: !c.invalid && !seen, log } }];`;

const POLICY_GATE = `
// Runs AFTER the wait: re-check purchase, consent, pick channel and lane, prepare the message.
const s = $('Settings').first().json;
const c = $('Branch config').first().json;
const ctx = $json;                       // from GET /api/context
const u = ctx.user;
const evt = c.evt;
const title = ctx.title;
const LANG = { en: 'English', sw: 'Kiswahili', sheng: 'Sheng', luo: 'Dholuo' };

const link = (t, channel) => t.buy_url + '?utm_source=yak_engine&utm_medium=' + channel + '&utm_campaign=' + c.branch + '&nid=' + c.nudge_id;
const base = { event_id: evt.event_id, nudge_id: c.nudge_id, branch: c.branch, user_id: u.id, title_id: evt.title_id || null };
const stop = (reason, message) => [{ json: { proceed: false, log: { ...base, stage: 'suppressed', at: 'gate', status: 'stop', reason, message } } }];

// 1. Re-check purchase (T2)
if (ctx.purchased) return stop('already_purchased', u.name + ' already bought ' + title.name + '. Nothing sent.');

// 2. Channel rules (D6). Consent is read fresh from the backend, never from the event.
const k = u.consent;
function utilityChannel() { return k.whatsapp ? 'whatsapp' : k.sms ? 'sms' : k.email ? 'email' : null; }
function marketingChannel(priceKes) {
  if (k.whatsapp && priceKes >= s.whatsapp_min_kes) return 'whatsapp';
  if (k.email) return 'email';
  return null;
}
function signupChannel() { return k.email ? 'email' : k.whatsapp ? 'whatsapp' : null; }

// 3. Candidates for the AI lane (D5): rules pick, the model only chooses among these.
function candidates() {
  const owned = new Set(u.owned);
  const pool = ctx.catalog.filter((t) => !owned.has(t.id));
  const picked = [];
  const add = (list) => list.forEach((t) => { if (picked.length < 5 && !picked.find((p) => p.id === t.id)) picked.push(t); });
  if (title) {
    add(pool.filter((t) => t.id === title.id));
    if (title.series_id) add(pool.filter((t) => t.series_id === title.series_id).sort((a, b) => a.episode - b.episode));
    add(pool.filter((t) => t.genre === title.genre));
    add(pool.filter((t) => t.languages.some((l) => title.languages.includes(l))));
  } else {
    add(pool.filter((t) => t.genre === u.top_genre));
    add(pool.filter((t) => t.languages.includes(u.language)));
  }
  // Cost guard: if email is not allowed, only titles that justify a paid WhatsApp message remain.
  return k.email ? picked : picked.filter((t) => t.price_kes >= s.whatsapp_min_kes);
}

// 4. Templates (transactional lanes must be exact, D5)
const PAYMENT = {
  stk_timeout: (t) => 'Your M-Pesa prompt for ' + t.name + ' timed out before the PIN was entered. Nothing was charged. Tap BUY again and enter your PIN within 60 seconds.',
  wrong_pin: (t) => 'The M-Pesa PIN for ' + t.name + ' was not accepted. Nothing was charged. Tap BUY again and re-enter your PIN carefully.',
  insufficient_funds: (t) => 'Your M-Pesa balance was not enough for ' + t.name + ' (KES ' + t.price_kes + '). Nothing was charged. Top up, or pay by card, then tap BUY again.',
  card_declined: (t) => 'Your card was declined for ' + t.name + '. Nothing was charged. You can pay with M-Pesa instead: tap BUY and choose M-Pesa.',
};
const DEVICE = {
  android: (t, l) => 'YAKWETU plays on Android. Install the app to watch ' + t.name + ': ' + s.android_app_url + '\\nOr open this link in Chrome: ' + l,
  desktop_non_chrome: (t, l) => 'YAKWETU plays in Google Chrome. Open this link in Chrome to finish buying ' + t.name + ': ' + l,
  ios: (t, l) => 'YAKWETU does not play on iPhone or iPad yet. You are on the list and we will tell you when it does. Meanwhile ' + t.name + ' plays in Chrome on any laptop: ' + l,
};

let lane = c.lane, channel = null, delivery = null, ollama_body = null, fallback = null;

if (c.branch === 'B_payment' || c.branch === 'B_device') {
  channel = utilityChannel();
  if (!channel) return stop('no_consent', u.name + ' has no channel we may use. Nothing sent.');
  const l = link(title, channel);
  const text = c.branch === 'B_payment'
    ? (PAYMENT[evt.context.failure_reason] || PAYMENT.stk_timeout)(title) + '\\n' + l
    : (DEVICE[evt.context.platform] || DEVICE.desktop_non_chrome)(title, l);
  delivery = { subject: c.branch === 'B_payment' ? 'Your payment for ' + title.name + ' did not go through' : 'How to watch ' + title.name, message: text, source: 'template' };
} else if (c.branch === 'signup_rescue') {
  channel = signupChannel();
  if (!channel) return stop('no_consent', u.name + ' has no channel we may use. Nothing sent.');
  delivery = { subject: title.name + ' is waiting for you', message: 'Joining YAKWETU is free. ' + title.name + ' is waiting for you: ' + link(title, channel), source: 'template' };
} else {
  // AI lanes: A_browse, winback
  if (!k.email && !k.whatsapp) return stop('no_consent', u.name + ' has not agreed to marketing on any channel. Nothing sent.');
  const cands = candidates();
  if (!cands.length) return stop('below_whatsapp_price_floor', 'Only WhatsApp is allowed and no title clears the KES ' + s.whatsapp_min_kes + ' floor for a paid message. Nothing sent.');
  const f = cands[0];
  const fch = marketingChannel(f.price_kes);
  fallback = { title_id: f.id, channel: fch, subject: f.name + ' is waiting for you',
    message: 'Hi ' + u.name + ', ' + f.name + ' is still waiting for you on YAKWETU. Membership is free, you pay once with M-Pesa and own it forever.\\n' + link(f, fch) };
  const did = c.branch === 'winback' ? 'has not visited for 30 days. Favourite genre: ' + u.top_genre
    : 'watched the free preview of ' + title.name + ' and left without buying';
  ollama_body = {
    model: s.ollama_model, stream: false, format: 'json', options: { temperature: 0.2 },
    messages: [
      { role: 'system', content: 'You write one short purchase nudge for YAKWETU, a Kenyan film platform. Rules: choose exactly one title from CANDIDATES using its id. The only selling points you may use are: membership is free, there is no subscription, you pay once and own it forever, you can pay with M-Pesa. Never use urgency, scarcity, discounts or rental words. No links. At most 250 characters. Write in ' + (LANG[u.language] || 'English') + ' if you can do so naturally, otherwise English. Reply with JSON only: {"pick_title_id": "...", "reason": "...", "message": "..."}' },
      { role: 'user', content: 'Viewer: ' + u.name + ' ' + did + '.\\nCANDIDATES: ' + JSON.stringify(cands.map((t) => ({ id: t.id, name: t.name, genre: t.genre, languages: t.languages, price_kes: t.price_kes }))) },
    ],
  };
  return [{ json: { proceed: true, lane: 'ai', candidates: cands, ollama_body, fallback,
    log: { ...base, stage: 'checked', status: 'ok', message: (title ? 'Not bought yet. ' : '') + 'Consent checked. ' + cands.length + ' candidate titles sent to the AI lane.' } } }];
}

return [{ json: { proceed: true, lane: 'template',
  delivery: { ...base, channel, ...delivery },
  log: { ...base, stage: 'checked', status: 'ok', channel, message: (title && c.branch !== 'B_device' ? 'Not bought yet. ' : '') + 'Consent checked. Channel: ' + channel + ' (' + c.kind + ').' } } }];`;

const TEMPLATE_OUT = `return [{ json: $('Policy gate').first().json.delivery }];`;

const GUARDRAILS = `
// D5 guardrails. Anything wrong falls back to a fixed template, and the log says so.
const s = $('Settings').first().json;
const c = $('Branch config').first().json;
const g = $('Policy gate').first().json;
const u = $('Context').first().json.user;
const BANNED = /(limited|hurry|expires?|last chance|discount|% ?off|\\brent)/i;

let reason = null, out = null;
try {
  if ($json.error) throw new Error('model call failed');
  const raw = $json.message && $json.message.content;
  out = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const cand = g.candidates.find((t) => t.id === (out && out.pick_title_id));
  if (!cand) reason = 'pick_not_in_candidates';
  else if (!out.message || out.message.length > 300) reason = 'too_long_or_empty';
  else if (BANNED.test(out.message)) reason = 'banned_phrase';
  else {
    // Channel is a cost rule, not a model decision. The gate guarantees one of these is allowed.
    const channel = (u.consent.whatsapp && cand.price_kes >= s.whatsapp_min_kes) ? 'whatsapp' : 'email';
    const url = cand.buy_url + '?utm_source=yak_engine&utm_medium=' + channel + '&utm_campaign=' + c.branch + '&nid=' + c.nudge_id;
    return [{ json: { event_id: c.evt.event_id, nudge_id: c.nudge_id, branch: c.branch, user_id: u.id, title_id: cand.id,
      channel, subject: cand.name + ' is waiting for you', message: out.message.trim() + '\\n' + url, source: 'ai', source_reason: out.reason || null } }];
  }
} catch (e) { reason = 'unusable_output: ' + e.message; }

const f = g.fallback;
return [{ json: { event_id: c.evt.event_id, nudge_id: c.nudge_id, branch: c.branch, user_id: u.id, title_id: f.title_id,
  channel: f.channel, subject: f.subject, message: f.message, source: 'fallback', source_reason: reason } }];`;

// ---------------------------------------------------------------- pipeline workflow
function pipeline() {
  const conn = {};
  const nodes = [
    { id: uid(), name: 'Event in', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 300], webhookId: 'a1b2c3d4-0000-4000-8000-000000000001',
      parameters: { httpMethod: 'POST', path: 'yak/events', responseMode: 'onReceived', options: {} } },
    code('Settings', 220, 300, SETTINGS_CODE),
    code('Branch config', 440, 300, BRANCH_CONFIG),
    http('Drop duplicates', 660, 300, { method: 'POST', url: "{{ $('Settings').first().json.backend_url }}/api/dedupe",
      body: "{{ JSON.stringify({ event_id: $('Branch config').first().json.evt.event_id || ('invalid-' + $('Branch config').first().json.nudge_id) }) }}" }),
    code('Admit', 880, 300, ADMIT),
    http('Log admit', 1100, 300, { method: 'POST', url: "{{ $('Settings').first().json.backend_url }}/api/logs", body: "{{ JSON.stringify($('Admit').first().json.log) }}" }),
    ifTrue('Admitted?', 1320, 300, "$('Admit').first().json.proceed"),
    { id: uid(), name: 'Wait (compressed)', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [1540, 280], webhookId: 'a1b2c3d4-0000-4000-8000-000000000002',
      parameters: { amount: "={{ Math.max(0.1, $('Branch config').first().json.wait_s) }}", unit: 'seconds' } },
    http('Context', 1760, 280, { url: "{{ $('Settings').first().json.backend_url }}/api/context?user_id={{ encodeURIComponent($('Branch config').first().json.evt.user_id) }}&title_id={{ encodeURIComponent($('Branch config').first().json.evt.title_id || '') }}" }),
    code('Policy gate', 1980, 280, POLICY_GATE),
    http('Log decision', 2200, 280, { method: 'POST', url: "{{ $('Settings').first().json.backend_url }}/api/logs", body: "{{ JSON.stringify($('Policy gate').first().json.log) }}" }),
    ifTrue('Send?', 2420, 280, "$('Policy gate').first().json.proceed"),
    ifTrue('AI lane?', 2640, 260, "$('Policy gate').first().json.lane === 'ai'"),
    http('Ask the model', 2860, 160, { method: 'POST', url: "{{ $('Settings').first().json.ollama_url }}/api/chat",
      body: "{{ JSON.stringify($('Policy gate').first().json.ollama_body) }}", timeout: 20000, continueOnFail: true, auth: false }),
    code('Guardrails', 3080, 160, GUARDRAILS),
    code('Template message', 2860, 380, TEMPLATE_OUT),
    http('Deliver', 3300, 280, { method: 'POST', url: "{{ $('Settings').first().json.backend_url }}/api/deliver", body: '{{ JSON.stringify($json) }}', timeout: 20000 }),
  ];
  link(conn, 'Event in', 'Settings');
  link(conn, 'Settings', 'Branch config');
  link(conn, 'Branch config', 'Drop duplicates');
  link(conn, 'Drop duplicates', 'Admit');
  link(conn, 'Admit', 'Log admit');
  link(conn, 'Log admit', 'Admitted?');
  link(conn, 'Admitted?', 'Wait (compressed)', 0);
  link(conn, 'Wait (compressed)', 'Context');
  link(conn, 'Context', 'Policy gate');
  link(conn, 'Policy gate', 'Log decision');
  link(conn, 'Log decision', 'Send?');
  link(conn, 'Send?', 'AI lane?', 0);
  link(conn, 'AI lane?', 'Ask the model', 0);
  link(conn, 'AI lane?', 'Template message', 1);
  link(conn, 'Ask the model', 'Guardrails');
  link(conn, 'Guardrails', 'Deliver');
  link(conn, 'Template message', 'Deliver');
  return { id: PIPELINE_ID, name: 'yak-engine-pipeline', active: false, nodes, connections: conn,
    settings: { executionOrder: 'v1', errorWorkflow: ERRORS_ID }, pinData: {}, tags: [] };
}

// ---------------------------------------------------------------- win-back scan
function winback() {
  const conn = {};
  const nodes = [
    { id: uid(), name: 'Every 10 seconds', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 300],
      parameters: { rule: { interval: [{ field: 'seconds', secondsInterval: 10 }] } } },
    code('Settings', 220, 300, SETTINGS_CODE),
    http('Find inactive users', 440, 300, {
      // D4: the scan uses the same compression function on the 30-day threshold (43200 real minutes).
      url: "{{ $('Settings').first().json.backend_url }}/api/users-inactive?threshold_s={{ (5.1 * Math.log(1 + 43200)).toFixed(1) }}" }),
    code('To win-back events', 660, 300, `
const due = $input.all().map((i) => i.json).filter((j) => j && j.user_id);
return due.map((d) => ({ json: { event: 'winback_due', user_id: d.user_id, demo_mode: true, context: { idle_s: d.idle_s } } }));`),
    http('Push into pipeline', 880, 300, { method: 'POST', url: "{{ $('Settings').first().json.backend_url }}/api/events", body: '{{ JSON.stringify($json) }}' }),
  ];
  link(conn, 'Every 10 seconds', 'Settings');
  link(conn, 'Settings', 'Find inactive users');
  link(conn, 'Find inactive users', 'To win-back events');
  link(conn, 'To win-back events', 'Push into pipeline');
  return { id: WINBACK_ID, name: 'yak-winback-scan', active: false, nodes, connections: conn,
    settings: { executionOrder: 'v1', errorWorkflow: ERRORS_ID }, pinData: {}, tags: [] };
}

// ---------------------------------------------------------------- error alerts
function errors() {
  const conn = {};
  const nodes = [
    { id: uid(), name: 'On workflow error', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 300], parameters: {} },
    code('Settings', 220, 300, SETTINGS_CODE),
    http('Log the error', 440, 300, { method: 'POST', url: "{{ $('Settings').first().json.backend_url }}/api/logs",
      body: "{{ JSON.stringify({ stage: 'failed', status: 'error', reason: 'workflow_error', message: 'Workflow ' + $('On workflow error').first().json.workflow.name + ' failed at ' + (($('On workflow error').first().json.execution || {}).lastNodeExecuted || 'unknown node') + ': ' + ((($('On workflow error').first().json.execution || {}).error || {}).message || 'unknown error') }) }}" }),
  ];
  link(conn, 'On workflow error', 'Settings');
  link(conn, 'Settings', 'Log the error');
  return { id: ERRORS_ID, name: 'yak-error-alerts', active: false, nodes, connections: conn, settings: { executionOrder: 'v1' }, pinData: {}, tags: [] };
}

fs.mkdirSync(OUT, { recursive: true });
for (const wf of [errors(), pipeline(), winback()]) {
  fs.writeFileSync(path.join(OUT, `${wf.name}.json`), JSON.stringify(wf, null, 2));
  console.log('wrote', wf.name);
}
