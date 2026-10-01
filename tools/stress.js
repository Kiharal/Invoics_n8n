// Stress and invariant test for the whole pipeline (n8n or tools/harness.js behind the backend).
// Fires overlapping scenarios, waits for every event to reach a terminal log row, then checks the rules
// in CLAUDE.md against what was actually sent.
//
//   BACKEND_URL=http://localhost:3000 WEBHOOK_URL=http://localhost:5678/webhook/yak/events node tools/stress.js
//
// WARNING: resets the backend state (logs, purchases, consent) at the start.
const BACKEND = process.env.BACKEND_URL || 'http://localhost:3000';
const WEBHOOK = process.env.WEBHOOK_URL || 'http://localhost:5678/webhook/yak/events';
const { KEY } = require('./stress/lib'); // env YAK_KEY, else the one in .env
const MIN_KES = Number(process.env.WHATSAPP_MIN_KES || 149);
const TIMEOUT_S = Number(process.env.STRESS_TIMEOUT_S || 180);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { 'Content-Type': 'application/json', 'x-yak-key': KEY };
async function api(path, body) {
  const r = await fetch(BACKEND + path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  return r.json().catch(() => ({}));
}
let n = 0;
const eid = (tag) => `stress-${tag}-${Date.now().toString(36)}-${++n}`;
const expected = new Map(); // event_id -> { tag, expect(rows) }
function fire(tag, evt, expect, { direct = false } = {}) {
  const event_id = evt.event_id || eid(tag);
  expected.set(event_id, { tag, expect });
  const body = { ...evt, event_id };
  if (!direct) return api('/api/events', body);
  // Straight to the webhook, as a misbehaving storefront would (the backend validates, n8n must too).
  return fetch(WEBHOOK, { method: 'POST', headers, body: JSON.stringify({ ts: new Date().toISOString(), demo_mode: true, ...body }) });
}
const directRaw = (body) => fetch(WEBHOOK, { method: 'POST', headers, body: JSON.stringify(body) });

const TERMINAL = new Set(['sent', 'suppressed', 'duplicate', 'failed']);
const PROMO = /(own it forever|membership is free|no subscription)/i;
const BANNED = /(limited|hurry|expires?|last chance|discount|% ?off|\brent|haraka|punguzo|\bofa\b|leo tu)/i;
const UTILITY = new Set(['B_payment', 'B_device']);

async function main() {
  const health = await api('/api/health');
  console.log('backend', BACKEND, JSON.stringify(health));
  await api('/api/admin/reset', {});
  await api('/api/admin/email', { live: false }); // don't burn the Mailtrap quota
  const catalog = await api('/api/catalog');
  const price = Object.fromEntries(catalog.map((t) => [t.id, t.price_kes]));
  const t0 = Date.now();

  const is = (stage, reason) => (rows) => rows.some((r) => r.stage === stage && (!reason || r.reason === reason));
  const sent = is('sent');

  // S1 burst: every branch, several users, all at once.
  const burst = [];
  // Payment rescue: two outcomes only. The message must name the method, and never guess the customer's own reason (PIN, balance).
  const payMsg = (want) => (rows) => rows.some((r) => r.stage === 'sent' && want.test(r.message) && !/PIN|balance|top up|timed out/i.test(r.message));
  for (const [method, reason, user, want] of [
    ['mpesa', 'not_completed', 'u_amina', /Your M-Pesa payment for .+ did not go through\. Nothing was charged\..*Bonga points or a card/],
    ['bonga', 'not_completed', 'u_brian', /Your Bonga points payment for .+ did not go through\..*M-Pesa or a card/],
    ['visa', 'card_declined', 'u_wanjiru', /Your Visa card was declined for .+\. Nothing was charged\..*another card/],
    ['mastercard', 'card_declined', 'u_kevo', null],
  ]) {
    burst.push(fire('pay-' + method, { event: 'payment_failed', user_id: user, title_id: 't_40_sticks', context: { payment_method: method, failure_reason: reason } },
      want ? payMsg(want) : is('suppressed', 'already_purchased')));
  }
  // M-Pesa cannot be "declined": a stray card_declined on a non-card method reads as not completed.
  burst.push(fire('pay-bonga-declined', { event: 'payment_failed', user_id: 'u_amina', title_id: 't_kizingo', context: { payment_method: 'bonga', failure_reason: 'card_declined' } },
    payMsg(/Your Bonga points payment for .+ did not go through/), { direct: true }));
  for (const platform of ['android', 'desktop_non_chrome', 'ios']) {
    burst.push(fire('device-' + platform, { event: 'unsupported_device', user_id: 'u_brian', title_id: 't_kizingo', context: { platform } }, sent));
  }
  burst.push(fire('browse-amina', { event: 'preview_completed', user_id: 'u_amina', title_id: 't_priest_is_dead', context: {} }, sent));
  burst.push(fire('browse-brian', { event: 'preview_completed', user_id: 'u_brian', title_id: 't_jonarobi', context: {} }, sent));
  burst.push(fire('browse-wanjiru', { event: 'preview_completed', user_id: 'u_wanjiru', title_id: 't_kutu', context: {} }, sent));
  burst.push(fire('browse-kevo', { event: 'title_viewed', user_id: 'u_kevo', title_id: 't_lost_in_tsavo', context: {} }, sent));
  burst.push(fire('browse-otieno', { event: 'preview_completed', user_id: 'u_otieno', title_id: 't_otis_janam', context: {} }, is('suppressed', 'no_consent')));
  burst.push(fire('signup-amina', { event: 'auth_abandoned', user_id: 'u_amina', title_id: 't_kienyeji', context: {} }, sent));
  burst.push(fire('winback-kevo', { event: 'winback_due', user_id: 'u_kevo', context: {} }, sent));

  // S2 collapse: preview and view of the same film -> one nudge, one "already_nudged".
  const collapseA = eid('collapse-a'), collapseB = eid('collapse-b');
  const oneOfTwo = (rows) => rows.some((r) => r.stage === 'sent' || (r.stage === 'suppressed' && r.reason === 'already_nudged'));
  burst.push(fire('collapse-a', { event_id: collapseA, event: 'preview_completed', user_id: 'u_brian', title_id: 't_lost_in_time', context: {} }, oneOfTwo));
  burst.push(fire('collapse-b', { event_id: collapseB, event: 'title_viewed', user_id: 'u_brian', title_id: 't_lost_in_time', context: {} }, oneOfTwo));

  // S3 same event_id twice at the same instant -> exactly one duplicate.
  const dupId = eid('dup');
  expected.set(dupId, { tag: 'dup-race', expect: (rows) => rows.filter((r) => r.stage === 'duplicate').length === 1 && rows.filter((r) => r.stage === 'sent').length === 1 });
  const dupBody = { event_id: dupId, event: 'payment_failed', user_id: 'u_amina', title_id: 't_why_u_hate', context: { payment_method: 'mpesa', failure_reason: 'not_completed' } };
  burst.push(api('/api/events', dupBody), api('/api/events', dupBody));

  // S4 purchase during the wait -> stopped at the gate.
  burst.push(fire('buy-during-wait', { event: 'preview_completed', user_id: 'u_amina', title_id: 't_family_meeting', context: {} }, is('suppressed', 'already_purchased')));

  // S6 malformed events straight to the webhook: every one must end in a logged stop, never a workflow error.
  burst.push(fire('bad-unknown-user', { event: 'payment_failed', user_id: 'u_nobody', title_id: 't_teka', context: { payment_method: 'mpesa', failure_reason: 'not_completed' } }, is('suppressed', 'no_context'), { direct: true }));
  burst.push(fire('bad-unknown-title', { event: 'payment_failed', user_id: 'u_amina', title_id: 't_nope', context: { payment_method: 'mpesa', failure_reason: 'not_completed' } }, is('suppressed', 'unknown_title'), { direct: true }));
  burst.push(fire('bad-no-title', { event: 'payment_failed', user_id: 'u_amina', context: {} }, is('suppressed', 'invalid_event'), { direct: true }));
  burst.push(fire('bad-unknown-event', { event: 'rocket_launched', user_id: 'u_amina' }, is('suppressed', 'invalid_event'), { direct: true }));
  burst.push(fire('bad-context-string', { event: 'payment_failed', user_id: 'u_brian', title_id: 't_teka', context: 'oops' }, sent, { direct: true }));
  burst.push(fire('bad-reason', { event: 'payment_failed', user_id: 'u_brian', title_id: 't_supastaz', context: { failure_reason: 'alien_bank' } }, sent, { direct: true }));
  burst.push(directRaw({ event: 'payment_failed', user_id: 'u_amina' })); // no event_id at all
  burst.push(directRaw({}));

  await Promise.all(burst);
  // S4 continued: buy during the 24.5 s browse wait.
  await sleep(5000);
  await api('/api/purchases', { user_id: 'u_amina', title_id: 't_family_meeting' });

  // Wait until every expected event has a terminal row.
  let logs = [];
  const byEvent = () => {
    const m = new Map();
    for (const l of logs) if (l.event_id) (m.get(l.event_id) || m.set(l.event_id, []).get(l.event_id)).push(l);
    return m;
  };
  while ((Date.now() - t0) / 1000 < TIMEOUT_S) {
    logs = await api('/api/logs');
    const m = byEvent();
    const pending = [...expected.keys()].filter((id) => !(m.get(id) || []).some((r) => TERMINAL.has(r.stage)));
    process.stdout.write(`\r${Math.round((Date.now() - t0) / 1000)}s: ${expected.size - pending.length}/${expected.size} events finished   `);
    if (!pending.length) break;
    await sleep(2000);
  }
  await sleep(1500);
  logs = await api('/api/logs');
  const m = byEvent();
  console.log('\n');

  // ---- per-scenario expectations
  const fails = [];
  for (const [id, { tag, expect }] of expected) {
    const rows = m.get(id) || [];
    const term = rows.filter((r) => TERMINAL.has(r.stage));
    if (!term.length) fails.push(`${tag}: never finished (stages: ${rows.map((r) => r.stage).join(' > ') || 'none'})`);
    else if (!expect(rows)) fails.push(`${tag}: unexpected outcome ${term.map((r) => r.stage + (r.reason ? ':' + r.reason : '')).join(', ')}`);
  }
  const collapse = [collapseA, collapseB].map((id) => m.get(id) || []);
  const collapseSent = collapse.filter((rows) => rows.some((r) => r.stage === 'sent')).length;
  if (collapseSent !== 1) fails.push(`collapse: expected exactly 1 nudge for preview+view of the same film, got ${collapseSent}`);
  const noIdStops = logs.filter((l) => !l.event_id && l.stage === 'suppressed' && l.reason === 'invalid_event').length;
  if (noIdStops < 2) fails.push(`events without event_id: expected 2 logged rejections, got ${noIdStops}`);

  // ---- global invariants over everything sent
  const users = Object.fromEntries((await api('/api/users')).map((u) => [u.id, u]));
  const sentRows = logs.filter((l) => l.stage === 'sent');
  for (const s of sentRows) {
    const who = `${s.branch}/${s.user_id}/${s.title_id}`;
    const body = String(s.message || '').split('\n').filter((line) => !/^https?:\/\//.test(line) && !line.includes('http')).join(' ');
    if (!users[s.user_id].consent[s.channel]) fails.push(`${who}: sent on ${s.channel} without consent`);
    if (!UTILITY.has(s.branch) && s.channel === 'whatsapp' && price[s.title_id] < MIN_KES) fails.push(`${who}: marketing WhatsApp below KES ${MIN_KES}`);
    if (UTILITY.has(s.branch) && PROMO.test(s.message)) fails.push(`${who}: utility message carries promotion`);
    if (BANNED.test(body)) fails.push(`${who}: banned phrase in "${body}"`);
    if (s.source === 'ai' && body.length > 300) fails.push(`${who}: AI text over 300 chars`);
    if (!/nid=n_/.test(s.message || '')) fails.push(`${who}: no tracked link`);
  }
  const workflowErrors = logs.filter((l) => l.reason === 'workflow_error' || l.reason === 'n8n_unreachable');
  for (const w of workflowErrors) fails.push(`workflow error: ${w.message}`);

  // ---- report
  const marketing = sentRows.filter((s) => s.source === 'ai' || s.source === 'fallback');
  console.log(`events: ${expected.size}  sent: ${sentRows.length}  suppressed: ${logs.filter((l) => l.stage === 'suppressed').length}  duplicates: ${logs.filter((l) => l.stage === 'duplicate').length}`);
  console.log(`AI lane: ${marketing.filter((s) => s.source === 'ai').length} written by the model, ${marketing.filter((s) => s.source === 'fallback').length} fallback`);
  for (const s of marketing) {
    console.log(`\n  [${s.source}] ${s.branch} -> ${s.user_id} via ${s.channel}, pitched ${s.title_id}${s.reason ? `\n    reason: ${s.reason}` : ''}`);
    console.log('    ' + String(s.message).split('\n')[0]);
  }
  const fired = new Map(logs.filter((l) => l.stage === 'fired').map((l) => [l.event_id, Date.parse(l.ts)]));
  const waits = new Map(logs.filter((l) => l.stage === 'waiting').map((l) => [l.event_id, l.demo_delay_s || 0]));
  const over = sentRows.filter((s) => fired.has(s.event_id)).map((s) => (Date.parse(s.ts) - fired.get(s.event_id)) / 1000 - (waits.get(s.event_id) || 0)).sort((a, b) => a - b);
  if (over.length) console.log(`\nprocessing time after the wait: p50 ${over[Math.floor(over.length / 2)].toFixed(1)} s, max ${over[over.length - 1].toFixed(1)} s`);

  console.log(fails.length ? `\nFAILED (${fails.length}):\n  - ${fails.join('\n  - ')}` : '\nALL CHECKS PASSED');
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
