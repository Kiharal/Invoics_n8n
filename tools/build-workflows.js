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
// lock: which nudges collapse into one inside the lock window (null = never collapse; utility help always goes out).
const BRANCHES = {
  payment_failed:     { branch: 'B_payment',     delay_real_min: 1,   lane: 'template', kind: 'utility',   needs_title: true,  lock: null },
  unsupported_device: { branch: 'B_device',      delay_real_min: 0,   lane: 'template', kind: 'utility',   needs_title: true,  lock: null },
  preview_completed:  { branch: 'A_browse',      delay_real_min: 120, lane: 'ai',       kind: 'marketing', needs_title: true,  lock: 'user_title' },
  title_viewed:       { branch: 'A_browse',      delay_real_min: 120, lane: 'ai',       kind: 'marketing', needs_title: true,  lock: 'user_title' },
  auth_abandoned:     { branch: 'signup_rescue', delay_real_min: 20,  lane: 'template', kind: 'marketing', needs_title: true,  lock: 'user_title' },
  winback_due:        { branch: 'winback',       delay_real_min: 0,   lane: 'ai',       kind: 'marketing', needs_title: false, lock: 'user' },
};
const LOCK_REAL_MIN = 1440; // one nudge per lock key per 24 h, real time
// D4: the only place real time becomes demo time.
const compress = (realMin) => 5.1 * Math.log(1 + realMin);

const body = $('Event in').first().json.body || {};
const evt = { ...body, context: body.context && typeof body.context === 'object' ? body.context : {} };
const missing = ['event_id', 'event', 'user_id'].filter((k) => !evt[k]);
const cfg = BRANCHES[evt.event];
const demo = evt.demo_mode !== false;
let invalid = null;
if (missing.length) invalid = 'missing ' + missing.join(', ');
else if (!cfg) invalid = 'no branch handles ' + evt.event;
else if (cfg.needs_title && !evt.title_id) invalid = evt.event + ' needs a title_id';

const real = cfg ? cfg.delay_real_min : 0;
const wait_s = demo ? Number(compress(real).toFixed(1)) : real * 60;
const lock_ttl_s = demo ? Number(compress(LOCK_REAL_MIN).toFixed(1)) : LOCK_REAL_MIN * 60;
const lock_key = !cfg || !cfg.lock ? null
  : cfg.lock === 'user' ? cfg.branch + '|' + evt.user_id
  : cfg.branch + '|' + evt.user_id + '|' + evt.title_id;
return [{ json: {
  evt, ...(cfg || {}), invalid, demo_mode: demo,
  real_delay_min: real, wait_s, lock_key, lock_ttl_s,
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
const evt = c.evt;
const base = { event_id: evt.event_id, nudge_id: c.nudge_id, branch: c.branch, user_id: evt.user_id, title_id: evt.title_id || null };
const stop = (reason, message) => [{ json: { proceed: false, log: { ...base, stage: 'suppressed', at: 'gate', status: 'stop', reason, message } } }];

// 0. The platform must know this viewer and title. A bad id stops here, logged, instead of failing the run.
if (ctx.error || !ctx.user) {
  const why = typeof ctx.error === 'string' ? ctx.error : (ctx.error && ctx.error.message) || 'unknown user';
  return stop('no_context', 'Could not load viewer ' + evt.user_id + ' from the platform (' + why + '). Nothing sent.');
}
const u = ctx.user;
const p = ctx.profile || { favourite_genre: u.top_genre, genre_counts: {}, owned_titles: [], recent: [] };
const title = ctx.title;
if (c.needs_title && !title) return stop('unknown_title', 'Title ' + evt.title_id + ' is not in the catalog. Nothing sent.');
const first = String(u.name).split(' ')[0];
const LANG = { en: 'English', sw: 'Kiswahili', sheng: 'Sheng', luo: 'Dholuo' };
const link = (t, channel) => t.buy_url + '?utm_source=yak_engine&utm_medium=' + channel + '&utm_campaign=' + c.branch + '&nid=' + c.nudge_id;

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

// 3. Candidates for the AI lane (D5): rules pick up to 5 and say WHY each fits this viewer.
//    The model only chooses among these and uses the reasons to personalise.
function candidates() {
  const owned = new Set(u.owned);
  const ownedT = p.owned_titles.map((o) => ctx.catalog.find((t) => t.id === o.id)).filter(Boolean);
  const pool = ctx.catalog.filter((t) => !owned.has(t.id));
  const picked = [];
  const add = (list, why) => list.forEach((t) => {
    const w = typeof why === 'function' ? why(t) : why;
    if (!w) return;
    const hit = picked.find((x) => x.id === t.id);
    if (hit) { if (!hit.why.includes(w)) hit.why.push(w); }
    else if (picked.length < 5) picked.push({ ...t, why: [w] });
  });
  // Labels like "new release" say nothing about why two films are alike, so they never count as similarity.
  const LABELS = ['new release', 'trending', 'short', 'series', 'kenyan favourite', 'internationally acclaimed'];
  const sharedTag = (a, b) => (a.tags || []).find((x) => !LABELS.includes(x) && (b.tags || []).includes(x));
  const sharedCast = (a, b) => (a.cast || []).find((x) => (b.cast || []).includes(x));
  const byOwnedCast = (t) => { for (const o of ownedT) { const a = sharedCast(t, o); if (a) return 'stars ' + a + ', who is also in ' + o.name + ' (they own it)'; } return null; };
  const byOwnedTag = (t) => { for (const o of ownedT) { const g = sharedTag(t, o); if (g) return 'has ' + g + ', like ' + o.name + ' (they own it)'; } return null; };
  const byLang = (t) => u.language !== 'en' && t.languages.includes(u.language) ? 'available in ' + LANG[u.language] + ', their language' : null;
  if (title) {
    add(pool.filter((t) => t.id === title.id), evt.event === 'preview_completed' ? 'they watched the free preview of this exact film' : 'they opened this exact film');
    if (title.series_id) add(pool.filter((t) => t.series_id === title.series_id).sort((a, b) => a.episode - b.episode), 'next episode of the series they looked at');
    add(pool.filter((t) => t.genre === title.genre), 'same genre (' + title.genre + ') as ' + title.name);
    add(pool, byOwnedCast);
    add(pool.filter((t) => t.id !== title.id), (t) => { const g = sharedTag(t, title); return g ? 'has ' + g + ', like ' + title.name : null; });
    add(pool, byOwnedTag);
    add(pool, byLang);
  } else {
    const n = p.genre_counts[p.favourite_genre] || 0;
    add(pool.filter((t) => t.genre === p.favourite_genre), n ? 'their favourite genre: they own ' + n + ' ' + p.favourite_genre + ' title' + (n === 1 ? '' : 's') : 'their favourite genre (' + p.favourite_genre + ')');
    add(pool, byOwnedCast);
    add(pool, byOwnedTag);
    add(pool, byLang);
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
  unknown: (t) => 'Your payment for ' + t.name + ' did not go through. Nothing was charged. Tap BUY to try again, with M-Pesa or a card.',
};
const DEVICE = {
  android: (t, l) => 'YAKWETU plays on Android. Install the app to watch ' + t.name + ': ' + s.android_app_url + '\\nOr open this link in Chrome: ' + l,
  desktop_non_chrome: (t, l) => 'YAKWETU plays in Google Chrome. Open this link in Chrome to finish buying ' + t.name + ': ' + l,
  ios: (t, l) => 'YAKWETU does not play on iPhone or iPad yet. You are on the list and we will tell you when it does. Meanwhile ' + t.name + ' plays in Chrome on any laptop: ' + l,
  unknown: (t, l) => 'YAKWETU plays in Google Chrome on Windows, macOS and Android. Open this link there to finish buying ' + t.name + ': ' + l,
};

// Fallback for the AI lane: still personal (name, the film, its story, why it fits), just not model-written.
const PITCH = ' Membership is free, pay once with M-Pesa and own it forever.';
const end = (name) => /[.!?]$/.test(name) ? name : name + '.';
function fallbackText(t) {
  // Lead with the strongest personal link the rules found: a shared actor beats a shared genre.
  const cast = t.why.map((w) => w.match(/^stars (.+), who is also in (.+) \\(they own it\\)$/)).find(Boolean);
  let open;
  if (title && t.id === title.id) open = first + ', you ' + (evt.event === 'preview_completed' ? 'watched the preview of ' : 'had a look at ') + end(t.name);
  else if (cast) open = first + ', ' + cast[1] + ' from ' + cast[2] + ' is back in ' + end(t.name);
  else if (title) open = first + ', you looked at ' + title.name + '. You might like ' + end(t.name);
  else if (p.owned_titles.length) open = first + ', you own ' + p.owned_titles[p.owned_titles.length - 1].name + ', so try ' + end(t.name);
  else open = first + ', try ' + end(t.name);
  let story = ' ' + (t.logline || '');
  const room = 290 - open.length - PITCH.length;
  if (story.length > room) story = story.slice(0, Math.max(0, room - 1)).replace(/\\s+\\S*$/, '') + '…';
  return open + story + PITCH;
}

function daypart() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Nairobi' }).format(new Date()));
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

let channel = null, delivery = null;
const out = (extra, log) => [{ json: { proceed: true, lock_key: c.lock_key, lock_ttl_s: c.lock_ttl_s, ...extra, log: { ...base, stage: 'checked', status: 'ok', ...log } } }];

if (c.branch === 'B_payment' || c.branch === 'B_device') {
  channel = utilityChannel();
  if (!channel) return stop('no_consent', u.name + ' has no channel we may use. Nothing sent.');
  const l = link(title, channel);
  const text = c.branch === 'B_payment'
    ? (PAYMENT[evt.context.failure_reason] || PAYMENT.unknown)(title) + '\\n' + l
    : (DEVICE[evt.context.platform] || DEVICE.unknown)(title, l);
  delivery = { subject: c.branch === 'B_payment' ? 'Your payment for ' + title.name + ' did not go through' : 'How to watch ' + title.name, message: text, source: 'template' };
} else if (c.branch === 'signup_rescue') {
  channel = signupChannel();
  if (!channel) return stop('no_consent', u.name + ' has no channel we may use. Nothing sent.');
  delivery = { subject: first + ', ' + title.name + ' is waiting for you', source: 'template',
    message: first + ', joining YAKWETU is free. ' + title.name + ' is waiting for you: ' + title.logline + '\\n' + link(title, channel) };
} else {
  // AI lanes: A_browse, winback
  if (!k.email && !k.whatsapp) return stop('no_consent', u.name + ' has not agreed to marketing on any channel. Nothing sent.');
  const cands = candidates();
  if (!cands.length) return stop('below_whatsapp_price_floor', 'Only WhatsApp is allowed and no title clears the KES ' + s.whatsapp_min_kes + ' floor for a paid message. Nothing sent.');
  const f = cands[0];
  const fch = marketingChannel(f.price_kes);
  const fallback = { title_id: f.id, channel: fch, subject: f.name + ', picked for ' + first, message: fallbackText(f) + '\\n' + link(f, fch) };

  const situation = c.branch === 'winback'
    ? first + ' has not opened YAKWETU for 30 days.'
    : evt.event === 'preview_completed' ? first + ' watched the free preview of ' + title.name + ' and left without buying.'
    : first + ' opened the page for ' + title.name + ' and left without buying.';
  const brief = {
    viewer: {
      first_name: first,
      writes_in: LANG[u.language] || 'English',
      favourite_genre: p.favourite_genre,
      // Genres ride along so the model does not guess what kind of film a referenced title is.
      owns: p.owned_titles.map((t) => t.name + ' (' + t.genre + ')'),
      recent_activity: p.recent.slice(0, 4).map((r) => {
        const t = ctx.catalog.find((x) => x.id === r.title_id);
        return r.text + (t ? ' (' + t.genre + ')' : '') + (r.days_ago ? ', ' + r.days_ago + ' days ago' : ', today');
      }),
    },
    situation,
    time_of_day: daypart(),
    candidates: cands.map((t) => ({ id: t.id, name: t.name, genre: t.genre, story: t.logline, starring: (t.cast || []).join(', '),
      runtime_min: t.runtime_min, price_kes: t.price_kes, why_for_viewer: t.why.join('; ') })),
  };
  // A 7B model writes poor Sheng (tested 28 Sep), so Sheng speakers get English with a Sheng greeting.
  const langRule = u.language === 'sheng' ? 'Write the message in warm, conversational Kenyan English, opening with a short Sheng greeting such as "Niaje".'
    : u.language === 'sw' ? 'Write the message in simple, natural Kiswahili.'
    : u.language === 'luo' ? 'Write the message in English, and you may open with a short Dholuo greeting.'
    : 'Write the message in warm, conversational Kenyan English.';
  const SYSTEM = [
    'You write ONE short personal message from YAKWETU, a Kenyan film platform, to one viewer.',
    'Step 1: pick the single candidate that fits this viewer best, using why_for_viewer, what they own and what they did recently.',
    'Step 2: write the message. It must:',
    '- start with the viewer first name;',
    '- name the chosen film exactly once, in capitals, exactly as written in "name";',
    '- use one concrete detail from its "story" (a character, place or situation) in your own words, as a hook;',
    '- connect the film to this viewer using why_for_viewer (for example the film they previewed, or a film they own);',
    '- end with at most ONE of these selling points: membership is free; no subscription; pay once and own it forever; pay with M-Pesa.',
    'Never: urgency or scarcity words, discounts, offers, renting, prices other than price_kes, facts not in the brief, links, hashtags, more than one emoji.',
    'You only know what the viewer DID (bought, previewed, opened), never how they felt: do not write loved, enjoyed or liked. You know nothing about the crew, awards, twists or the ending: never mention them.',
    'Only mention other films that appear in owns or recent_activity, and only with the genre given there.',
    'Avoid empty phrases like "is waiting for you", "don\\'t miss" or "check it out". Sound like a friend who knows films, not an advert.',
    'Keep it under 240 characters. Keep film names in English exactly as given. ' + langRule,
    'Reply with JSON only: {"pick_title_id": "<id from candidates>", "reason": "<one short sentence: why this film for this viewer>", "message": "<the message>"}',
  ].join('\\n');
  // One worked example. Its film is made up; the guardrails reject any message that repeats it.
  const EX_BRIEF = { viewer: { first_name: 'Zawadi', writes_in: 'English', favourite_genre: 'thriller', owns: ['NIGHT SHIFT (thriller)'], recent_activity: ['watched the preview of THE LAST MATATU (thriller), today'] },
    situation: 'Zawadi watched the free preview of THE LAST MATATU and left without buying.', time_of_day: 'evening',
    candidates: [{ id: 'x_last_matatu', name: 'THE LAST MATATU', genre: 'thriller', story: 'A matatu conductor finds a bag of stolen phones on the last trip of the night.', starring: 'Example Actor', runtime_min: 88, price_kes: 99, why_for_viewer: 'they watched the free preview of this exact film' }] };
  const EX_ANSWER = { pick_title_id: 'x_last_matatu', reason: 'She watched the whole preview, so the same film is the strongest pick.',
    message: 'Zawadi, you saw the preview of THE LAST MATATU. That bag of stolen phones is still on the last trip home, and the conductor has to decide who to trust. Pay once with M-Pesa and it is yours forever.' };

  const ollama_body = {
    // keep_alive holds the model in memory between nudges; num_predict bounds generation time.
    // format is a JSON schema: the model can only return an id that is in the candidate list.
    model: s.ollama_model, stream: false, keep_alive: '30m',
    options: { temperature: 0.2, num_predict: 320, num_ctx: 4096 },
    format: { type: 'object', required: ['pick_title_id', 'reason', 'message'], properties: {
      pick_title_id: { type: 'string', enum: cands.map((t) => t.id) }, reason: { type: 'string' }, message: { type: 'string' } } },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify(EX_BRIEF) },
      { role: 'assistant', content: JSON.stringify(EX_ANSWER) },
      { role: 'user', content: JSON.stringify(brief) },
    ],
  };
  return out({ lane: 'ai', candidates: cands, ollama_body, fallback, example_names: ['THE LAST MATATU', 'NIGHT SHIFT', 'Zawadi'], first_name: first,
      // Films the message may mention besides the pick: ones the viewer owns or recently touched.
      referable_ids: [...new Set([...p.owned_titles.map((t) => t.id), ...p.recent.map((r) => r.title_id)])] },
    { message: (title ? 'Not bought yet. ' : '') + 'Consent checked. ' + cands.length + ' candidate titles sent to the AI lane: ' + cands.map((t) => t.name).join(', ') + '.' });
}

return out({ lane: 'template', delivery: { ...base, channel, ...delivery } },
  { channel, message: (title && c.branch !== 'B_device' ? 'Not bought yet. ' : '') + 'Consent checked. Channel: ' + channel + ' (' + c.kind + ').' });`;

// One nudge per lock key inside the lock window (D4-compressed). Utility branches have no key.
const LOCK_CHECK = `
const g = $('Policy gate').first().json;
const c = $('Branch config').first().json;
if (g.proceed && $json.claimed === false) {
  return [{ json: { proceed: false, lane: g.lane, log: { ...g.log, stage: 'suppressed', at: 'lock', status: 'stop', reason: 'already_nudged',
    message: 'This viewer already got a ' + c.branch + ' nudge for this in the last 24 hours (demo: ' + c.lock_ttl_s + ' s). Nothing sent.' } } }];
}
return [{ json: { proceed: g.proceed, lane: g.lane, log: g.log } }];`;

const TEMPLATE_OUT = `return [{ json: $('Policy gate').first().json.delivery }];`;

// Built twice: the first pass may ask the model for one retry; the final pass (after the retry) falls back.
const guardrails = (final) => `
// D5 guardrails. A rejected message gets one retry with the reason; after that a personal template goes out, and the log says why.
const FINAL = ${final};
const s = $('Settings').first().json;
const c = $('Branch config').first().json;
const g = $('Policy gate').first().json;
const u = $('Context').first().json.user;
const BANNED = /(limited|hurry|expires?|last chance|discount|% ?off|\\brent|\\boffer|\\bdeal\\b|don'?t miss|haraka|punguzo|\\bofa\\b|leo tu)/i;
const URLISH = /(https?:\\/\\/|www\\.|\\.africa|\\.com\\b)/i;
// We know what viewers did, not how they felt about it.
const FEELINGS = /\\b(?:loved|enjoyed|liked|adored)\\b/i;
// Facts the brief never gives the model (crew, awards, endings): anything here was invented.
const UNKNOWN = /\\b(?:director|directed|producer|award|sequel|ending|twist|kept you|you seen|same team)\\b/i;
const GENERIC = /(check it out|is waiting for you|won'?t want to miss|don'?t miss|miss out)/i;
const catalog = $('Context').first().json.catalog;
const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const core = (name) => norm(name.replace(/\\s+Ep\\.\\s*\\d+$/i, ''));

function check(out) {
  const cand = g.candidates.find((t) => t.id === (out && out.pick_title_id));
  if (!cand) return { reason: 'pick_not_in_candidates' };
  const m = String(out.message || '').trim().replace(/[\\u2018\\u2019]/g, "'"); // curly apostrophes would dodge the checks
  if (!m || m.length > 300) return { reason: 'too_long_or_empty (' + m.length + ' chars)' };
  if (BANNED.test(m)) return { reason: 'banned_phrase: ' + m.match(BANNED)[0] };
  if (URLISH.test(m)) return { reason: 'contains_link' };
  const nm = ' ' + norm(m) + ' ';
  const pickCore = core(cand.name);
  if (!nm.includes(' ' + pickCore + ' ')) return { reason: 'does_not_name_the_film' };
  if (nm.split(' ' + pickCore + ' ').length > 2) return { reason: 'repeats_the_title' };
  const exact = cand.name.replace(/\\s+Ep\\.\\s*\\d+$/i, '');
  if (!m.includes(exact)) return { reason: 'title_not_written_exactly' };
  if (FEELINGS.test(m)) return { reason: 'claims_a_feeling: ' + m.match(FEELINGS)[0] };
  if (UNKNOWN.test(m)) return { reason: 'claims_unknown_fact: ' + m.match(UNKNOWN)[0] };
  if (GENERIC.test(m)) return { reason: 'generic_phrase: ' + m.match(GENERIC)[0] };
  // Other films: never another candidate; any other catalog title only if the viewer owns or recently touched it.
  const other = catalog.find((t) => core(t.name) !== pickCore && nm.includes(' ' + core(t.name) + ' ')
    && (g.candidates.some((x) => x.id === t.id) || !g.referable_ids.includes(t.id)));
  if (other) return { reason: 'names_another_title: ' + other.name };
  const leak = g.example_names.find((x) => nm.includes(' ' + norm(x) + ' '));
  if (leak) return { reason: 'copied_the_example: ' + leak };
  // Any KES amount must be the real price, or a figure from the film's own story (e.g. a prize).
  const nums = (x) => [...String(x).matchAll(/(?:kes|ksh|kshs|sh)\\.?\\s?(\\d[\\d,]*)/gi)].map((y) => Number(y[1].replace(/,/g, '')));
  const allowed = [cand.price_kes, ...nums(cand.logline || '')];
  if (nums(m).some((v) => !allowed.includes(v))) return { reason: 'wrong_price' };
  return { cand, message: m };
}

let reason = null, raw = null;
try {
  if ($json.error) {
    const e = $json.error;
    throw new Error('model call failed: ' + (typeof e === 'string' ? e : e.message || e.description || JSON.stringify(e)).slice(0, 160));
  }
  raw = $json.message && $json.message.content;
  if (!raw) throw new Error('empty model reply');
  const r = check(typeof raw === 'string' ? JSON.parse(raw) : raw);
  if (r.cand) {
    // Channel is a cost rule, not a model decision. The gate guarantees one of these is allowed.
    const channel = (u.consent.whatsapp && r.cand.price_kes >= s.whatsapp_min_kes) ? 'whatsapp' : 'email';
    const url = r.cand.buy_url + '?utm_source=yak_engine&utm_medium=' + channel + '&utm_campaign=' + c.branch + '&nid=' + c.nudge_id;
    const out = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
    return [{ json: { event_id: c.evt.event_id, nudge_id: c.nudge_id, branch: c.branch, user_id: u.id, title_id: r.cand.id,
      channel, subject: r.cand.name + ', picked for ' + g.first_name, message: r.message + '\\n' + url, source: 'ai',
      source_reason: (FINAL ? '2nd try (1st rejected: ' + $('Guardrails').first().json.first_reason + '). ' : '') + (out.reason || '') } }];
  }
  reason = r.reason;
} catch (e) { reason = 'unusable_output: ' + e.message; }

// One retry, with the rejection reason as feedback. Not after a failed call (a timeout would just double).
if (!FINAL && raw && !String(reason).includes('model call failed')) {
  const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return [{ json: { retry: true, first_reason: reason, retry_body: { ...g.ollama_body, messages: [...g.ollama_body.messages,
    { role: 'assistant', content },
    { role: 'user', content: 'Rejected: ' + reason + '. Write a new message for the same viewer that follows every rule. Same JSON format.' }] } } }];
}
if (FINAL) reason = 'rejected twice: ' + $('Guardrails').first().json.first_reason + ', then ' + reason;
const f = g.fallback;
return [{ json: { event_id: c.evt.event_id, nudge_id: c.nudge_id, branch: c.branch, user_id: u.id, title_id: f.title_id,
  channel: f.channel, subject: f.subject, message: f.message, source: 'fallback', source_reason: reason } }];`;

// Right before sending: did the viewer buy the pitched title (or the one they were looking at) meanwhile?
const FINAL_CHECK = `
const g = $('Policy gate').first().json;
const c = $('Branch config').first().json;
const d = g.lane !== 'ai' ? $('Template message').first().json
  : $('Guardrails').first().json.retry ? $('Guardrails (retry)').first().json : $('Guardrails').first().json;
const bought = $json.purchased || [];
if (bought.length) {
  return [{ json: { send: false, log: { event_id: d.event_id, nudge_id: d.nudge_id, branch: d.branch, user_id: d.user_id, title_id: d.title_id,
    stage: 'suppressed', at: 'final_check', status: 'stop', reason: 'purchased_before_send',
    message: 'Bought ' + bought.join(', ') + ' while the message was being prepared. Nothing sent.' } } }];
}
return [{ json: { send: true, delivery: d } }];`;

// ---------------------------------------------------------------- pipeline workflow
function pipeline() {
  const conn = {};
  const B = "$('Settings').first().json.backend_url";
  const nodes = [
    { id: uid(), name: 'Event in', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 300], webhookId: 'a1b2c3d4-0000-4000-8000-000000000001',
      parameters: { httpMethod: 'POST', path: 'yak/events', responseMode: 'onReceived', options: {} } },
    code('Settings', 220, 300, SETTINGS_CODE),
    code('Branch config', 440, 300, BRANCH_CONFIG),
    http('Drop duplicates', 660, 300, { method: 'POST', url: `{{ ${B} }}/api/dedupe`,
      body: "{{ JSON.stringify({ event_id: $('Branch config').first().json.evt.event_id || ('invalid-' + $('Branch config').first().json.nudge_id) }) }}" }),
    code('Admit', 880, 300, ADMIT),
    http('Log admit', 1100, 300, { method: 'POST', url: `{{ ${B} }}/api/logs`, body: "{{ JSON.stringify($('Admit').first().json.log) }}" }),
    ifTrue('Admitted?', 1320, 300, "$('Admit').first().json.proceed"),
    { id: uid(), name: 'Wait (compressed)', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [1540, 280], webhookId: 'a1b2c3d4-0000-4000-8000-000000000002',
      parameters: { amount: "={{ Math.max(0.1, $('Branch config').first().json.wait_s) }}", unit: 'seconds' } },
    http('Context', 1760, 280, { continueOnFail: true,
      url: `{{ ${B} }}/api/context?user_id={{ encodeURIComponent($('Branch config').first().json.evt.user_id) }}&title_id={{ encodeURIComponent($('Branch config').first().json.evt.title_id || '') }}` }),
    code('Policy gate', 1980, 280, POLICY_GATE),
    http('Nudge lock', 2200, 280, { method: 'POST', url: `{{ ${B} }}/api/locks`,
      body: "{{ JSON.stringify({ key: $('Policy gate').first().json.proceed ? ($('Policy gate').first().json.lock_key || null) : null, ttl_s: $('Policy gate').first().json.lock_ttl_s || 60 }) }}" }),
    code('Lock check', 2420, 280, LOCK_CHECK),
    http('Log decision', 2640, 280, { method: 'POST', url: `{{ ${B} }}/api/logs`, body: "{{ JSON.stringify($('Lock check').first().json.log) }}" }),
    ifTrue('Send?', 2860, 280, "$('Lock check').first().json.proceed"),
    ifTrue('AI lane?', 3080, 260, "$('Policy gate').first().json.lane === 'ai'"),
    http('Ask the model', 3300, 160, { method: 'POST', url: "{{ $('Settings').first().json.ollama_url }}/api/chat",
      body: "{{ JSON.stringify($('Policy gate').first().json.ollama_body) }}", timeout: 60000, continueOnFail: true, auth: false }),
    code('Guardrails', 3520, 160, guardrails(false)),
    ifTrue('Retry?', 3740, 160, '$json.retry === true'),
    http('Ask again', 3960, 40, { method: 'POST', url: "{{ $('Settings').first().json.ollama_url }}/api/chat",
      body: '{{ JSON.stringify($json.retry_body) }}', timeout: 60000, continueOnFail: true, auth: false }),
    code('Guardrails (retry)', 4180, 40, guardrails(true)),
    code('Template message', 3300, 380, TEMPLATE_OUT),
    http('Final re-check', 3740, 280, {
      url: `{{ ${B} }}/api/purchase-check?user_id={{ encodeURIComponent($json.user_id) }}&title_ids={{ encodeURIComponent([$json.title_id, $('Branch config').first().json.evt.title_id].filter(Boolean).join(',')) }}` }),
    code('Still unbought?', 3960, 280, FINAL_CHECK),
    ifTrue('Send now?', 4180, 280, '$json.send'),
    http('Deliver', 4400, 200, { method: 'POST', url: `{{ ${B} }}/api/deliver`, body: '{{ JSON.stringify($json.delivery) }}', timeout: 20000 }),
    http('Log late stop', 4400, 380, { method: 'POST', url: `{{ ${B} }}/api/logs`, body: '{{ JSON.stringify($json.log) }}' }),
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
  link(conn, 'Policy gate', 'Nudge lock');
  link(conn, 'Nudge lock', 'Lock check');
  link(conn, 'Lock check', 'Log decision');
  link(conn, 'Log decision', 'Send?');
  link(conn, 'Send?', 'AI lane?', 0);
  link(conn, 'AI lane?', 'Ask the model', 0);
  link(conn, 'AI lane?', 'Template message', 1);
  link(conn, 'Ask the model', 'Guardrails');
  link(conn, 'Guardrails', 'Retry?');
  link(conn, 'Retry?', 'Ask again', 0);
  link(conn, 'Retry?', 'Final re-check', 1);
  link(conn, 'Ask again', 'Guardrails (retry)');
  link(conn, 'Guardrails (retry)', 'Final re-check');
  link(conn, 'Template message', 'Final re-check');
  link(conn, 'Final re-check', 'Still unbought?');
  link(conn, 'Still unbought?', 'Send now?');
  link(conn, 'Send now?', 'Deliver', 0);
  link(conn, 'Send now?', 'Log late stop', 1);
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
