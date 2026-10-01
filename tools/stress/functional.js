// Phase 2 of the judge audit: every branch end to end through the real stack (backend -> n8n -> Ollama).
// Run: node tools/stress/functional.js   (BACKEND_URL defaults to http://localhost:3000). Resets demo state between groups.
const fs = require('fs');
const path = require('path');
const { api, getJson, waitDone, rowsFor, record, results, sleep, emailOff } = require('./lib');

const MIN_KES = Number(process.env.WHATSAPP_MIN_KES || 149);
const ev = async (event, user_id, title_id, context = {}, extra = {}) => {
  const r = await api('/api/events', { event, user_id, title_id, context, ...extra });
  return r.event ? r.event.event_id : null;
};
const reset = async () => { await api('/api/admin/reset', {}); await emailOff(); };
const terminal = (rows) => rows.find((r) => ['sent', 'suppressed', 'duplicate', 'failed'].includes(r.stage)) || {};
const short = (r) => r ? `${r.stage}${r.reason ? ':' + r.reason : ''}${r.channel ? ' via ' + r.channel : ''}${r.source ? ' [' + r.source + ']' : ''}` : 'none';
const secs = (a, b) => (Date.parse(b.ts) - Date.parse(a.ts)) / 1000;

async function main() {
  const catalog = await getJson('/api/catalog');
  const price = Object.fromEntries(catalog.map((t) => [t.id, t.price_kes]));

  // ---- G1 Payment rescue: each method and outcome
  await reset();
  const pay = [
    ['F1a', 'u_amina', 'mpesa', 'not_completed', 'whatsapp', /Your M-Pesa payment for .* did not go through/],
    ['F1b', 'u_brian', 'bonga', 'not_completed', 'email', /Your Bonga points payment/],
    ['F1c', 'u_kevo', 'visa', 'card_declined', 'whatsapp', /Your Visa card was declined/],
    ['F1d', 'u_amina', 'mastercard', 'card_declined', 'whatsapp', /Your Mastercard card was declined/],
  ];
  const payIds = [];
  for (const [id, u, m, reason] of pay) payIds.push(await ev('payment_failed', u, ['F1c', 'F1d'].includes(id) ? 't_teka' : 't_lost_in_time', { payment_method: m, failure_reason: reason }));
  let logs = await waitDone(payIds);
  pay.forEach(([id, u, m, reason, ch, re], i) => {
    const rows = rowsFor(logs, payIds[i]);
    const s = rows.find((r) => r.stage === 'sent');
    const w = rows.find((r) => r.stage === 'waiting'), c = rows.find((r) => r.stage === 'checked');
    const promo = s && /own it forever|membership is free|no subscription/i.test(s.message);
    record(id, `Payment rescue ${m} ${reason} (${u})`, `sent via ${ch}, template names method, no promotion, wait 3.5 s`,
      `${short(terminal(rows))}; wait ${w && c ? secs(w, c).toFixed(1) : '?'} s; promo=${promo}`,
      Boolean(s && s.channel === ch && re.test(s.message) && !promo), s ? s.message.split('\n')[0] : JSON.stringify(rows.map(short)));
  });

  // ---- G2 Device sub-case: each platform
  await reset();
  const plats = ['android', 'desktop_non_chrome', 'ios'];
  const devIds = [];
  for (const p of plats) devIds.push(await ev('unsupported_device', 'u_brian', 't_kizingo', { platform: p }));
  logs = await waitDone(devIds);
  const stats = await getJson('/api/stats');
  plats.forEach((p, i) => {
    const rows = rowsFor(logs, devIds[i]);
    const s = rows.find((r) => r.stage === 'sent');
    const f = rows.find((r) => r.stage === 'fired');
    const want = { android: /Install the app/, desktop_non_chrome: /Open this link in Chrome/, ios: /does not play on iPhone/ }[p];
    record('F2-' + p, `Device sub-case ${p}`, 'sent (email for Brian), platform-specific text, ~0 s wait',
      `${short(terminal(rows))}; fired->sent ${s && f ? secs(f, s).toFixed(1) : '?'} s`, Boolean(s && want.test(s.message)), s ? s.message.split('\n')[0] : '');
  });
  record('F2-counter', 'iOS demand counter', 'ios_waitlist=1, android=1, desktop_non_chrome=1',
    JSON.stringify({ ios: stats.ios_waitlist, android: stats.android, desktop: stats.desktop_non_chrome }),
    stats.ios_waitlist === 1 && stats.android === 1 && stats.desktop_non_chrome === 1, '/api/stats');

  // ---- G3 Browse recovery (real AI lane) + sign-up rescue + duplicate
  await reset();
  const bA = await ev('preview_completed', 'u_amina', 't_priest_is_dead');
  const bB = await ev('title_viewed', 'u_brian', 't_jonarobi');
  const bW = await ev('preview_completed', 'u_wanjiru', 't_kutu');
  const bO = await ev('preview_completed', 'u_otieno', 't_otis_janam');
  const sU = await ev('auth_abandoned', 'u_amina', 't_kienyeji', { ref: 't_kienyeji' });
  const dupBody = { event: 'payment_failed', user_id: 'u_brian', title_id: 't_teka', context: { payment_method: 'mpesa', failure_reason: 'not_completed' } };
  const d1 = await api('/api/events', dupBody);
  await api('/api/events', { ...dupBody, event_id: d1.event.event_id });
  logs = await waitDone([bA, bB, bW, bO, sU, d1.event.event_id], 180000);
  for (const [id, eid, who] of [['F3a', bA, 'Amina (all consent) THE PRIEST IS DEAD KES 199'], ['F3b', bB, 'Brian (email only) JONAROBI']]) {
    const rows = rowsFor(logs, eid);
    const s = rows.find((r) => r.stage === 'sent');
    const w = rows.find((r) => r.stage === 'waiting'), c = rows.find((r) => r.stage === 'checked');
    record(id, `Browse recovery, ${who}`, 'sent, source ai or fallback with reason, wait 24.5 s',
      `${short(terminal(rows))}; wait ${w && c ? secs(w, c).toFixed(1) : '?'} s; checked->sent ${c && s ? secs(c, s).toFixed(1) : '?'} s; reason=${s && s.reason}`,
      Boolean(s && (s.source === 'ai' || (s.source === 'fallback' && s.reason))), s ? s.message.split('\n')[0] : '');
  }
  {
    const rows = rowsFor(logs, bW);
    const t = terminal(rows);
    const okFloor = t.stage === 'sent' ? t.channel === 'whatsapp' && price[t.title_id] >= MIN_KES : t.reason === 'below_whatsapp_price_floor';
    record('F3c', 'Browse recovery, Wanjiru (WhatsApp only) previews KUTU KES 49', `WhatsApp pitch of a title >= KES ${MIN_KES}, or below_whatsapp_price_floor`,
      `${short(t)} title=${t.title_id} price=${price[t.title_id]}`, okFloor, t.message ? t.message.split('\n')[0] : '');
  }
  {
    const t = terminal(rowsFor(logs, bO));
    record('F3d', 'Browse recovery, Otieno (no consent)', 'suppressed no_consent', short(t), t.stage === 'suppressed' && t.reason === 'no_consent', t.message || '');
  }
  {
    const rows = rowsFor(logs, sU);
    const s = rows.find((r) => r.stage === 'sent');
    const w = rows.find((r) => r.stage === 'waiting'), c = rows.find((r) => r.stage === 'checked');
    record('F4', 'Sign-up rescue, Amina KIENYEJI', 'sent via email, "joining YAKWETU is free", wait 15.5 s',
      `${short(terminal(rows))}; wait ${w && c ? secs(w, c).toFixed(1) : '?'} s`, Boolean(s && s.channel === 'email' && /joining YAKWETU is free/.test(s.message)), s ? s.message.split('\n')[0] : '');
  }
  {
    const rows = rowsFor(logs, d1.event.event_id);
    record('F9', 'Duplicate event_id (sequential replay)', 'exactly 1 duplicate row, exactly 1 sent',
      `duplicates=${rows.filter((r) => r.stage === 'duplicate').length} sent=${rows.filter((r) => r.stage === 'sent').length}`,
      rows.filter((r) => r.stage === 'duplicate').length === 1 && rows.filter((r) => r.stage === 'sent').length === 1, rows.map(short).join(', '));
  }
  // Marketing price-floor invariant over every AI-lane send so far
  const mk = logs.filter((r) => r.stage === 'sent' && ['A_browse', 'winback'].includes(r.branch));
  // D6: marketing goes WhatsApp exactly when the viewer allows WhatsApp AND the pitched title is >= the floor.
  const users = Object.fromEntries((await getJson('/api/users')).map((u) => [u.id, u]));
  const bad = mk.filter((r) => (r.channel === 'whatsapp') !== (users[r.user_id].consent.whatsapp && price[r.title_id] >= MIN_KES));
  record('F7-floor', `Marketing WhatsApp iff consent and pick price >= ${MIN_KES}`, 'every marketing send follows the rule',
    mk.map((r) => `${r.user_id}:${r.title_id}(${price[r.title_id]})->${r.channel}`).join(' '), mk.length > 0 && !bad.length, 'sent rows, branch A_browse/winback');

  // ---- G4 Re-check: purchase during the wait
  await reset();
  const rc = await ev('preview_completed', 'u_brian', 't_lost_in_time');
  await sleep(4000);
  await api('/api/purchases', { user_id: 'u_brian', title_id: 't_lost_in_time' });
  logs = await waitDone([rc]);
  {
    const t = terminal(rowsFor(logs, rc));
    record('F5', 'Purchase during the 24.5 s wait stops the nudge', 'suppressed already_purchased at gate', short(t) + ' at ' + t.at, t.reason === 'already_purchased', t.message || '');
  }

  // ---- G5 Consent read after the wait
  await reset();
  const c1 = await ev('payment_failed', 'u_amina', 't_teka', { payment_method: 'mpesa', failure_reason: 'not_completed' });
  await sleep(800);
  await api('/api/users/u_amina/consent', { whatsapp: false });
  const c2 = await ev('payment_failed', 'u_kevo', 't_teka', { payment_method: 'mpesa', failure_reason: 'not_completed' });
  await sleep(800);
  await api('/api/users/u_kevo/consent', { whatsapp: false, email: false });
  logs = await waitDone([c1, c2]);
  {
    const t1 = terminal(rowsFor(logs, c1)), t2 = terminal(rowsFor(logs, c2));
    record('F6a', 'Consent flipped during wait (Amina WhatsApp off)', 'utility falls to SMS (logged)', short(t1), t1.stage === 'sent' && t1.channel === 'sms', t1.detail || '');
    record('F6b', 'All consent removed during wait (Kevo)', 'suppressed no_consent', short(t2), t2.reason === 'no_consent', t2.message || '');
  }

  // ---- G6 Win-back via the scheduled scan
  await reset();
  const armedAt = Date.now();
  await api('/api/users/u_kevo/inactive', {});
  let wb = null;
  for (let i = 0; i < 180 && !wb; i++) {
    await sleep(1000);
    logs = await getJson('/api/logs');
    wb = logs.find((r) => r.stage === 'fired' && r.event === 'winback_due');
  }
  if (wb) logs = await waitDone([wb.event_id], 120000);
  {
    const t = wb ? terminal(rowsFor(logs, wb.event_id)) : {};
    const lag = wb ? (Date.parse(wb.ts) - armedAt) / 1000 : null;
    record('F8', 'Win-back: Kevo armed, scan fires after compress(30 days)', 'winback_due fired at 54.5 s + up to 10 s scan interval, then sent',
      `fired after ${lag == null ? 'never' : lag.toFixed(1) + ' s'}; ${short(t)}`, Boolean(wb && lag >= 54 && lag <= 66 && t.stage === 'sent'), t.message ? t.message.split('\n')[0] : '');
  }

  // ---- G7 Guardrail drill on the real stack: the panel's AI switch now reaches n8n through the backend proxy
  for (const [id, mode, want] of [['F10b', 'bad', /banned_phrase/], ['F10s', 'slow', /model call failed/]]) {
    await reset();
    await api('/api/admin/ai-stub-mode', { mode });
    const e = await ev('preview_completed', 'u_amina', 't_priest_is_dead');
    logs = await waitDone([e], 150000);
    const s = rowsFor(logs, e).find((r) => r.stage === 'sent');
    record(id, `Panel AI switch "${mode}" on the Docker stack`, 'fallback sent, reason logged', s ? `${s.source} | ${s.reason}` : 'no send', Boolean(s && s.source === 'fallback' && want.test(s.reason)), '');
    await api('/api/admin/ai-stub-mode', { mode: 'good' });
  }

  // ---- G8 Attribution: buying the pitched title with the nudge id credits the nudge
  await reset();
  const at = await ev('payment_failed', 'u_amina', 't_teka', { payment_method: 'mpesa', failure_reason: 'not_completed' });
  logs = await waitDone([at]);
  const nudge = rowsFor(logs, at).find((r) => r.stage === 'sent');
  const buy = await api('/api/purchases', { user_id: 'u_amina', title_id: 't_teka', nid: nudge && nudge.nudge_id });
  const fakeBuy = await api('/api/purchases', { user_id: 'u_brian', title_id: 't_teka', nid: nudge && nudge.nudge_id });
  const st = await getJson('/api/stats');
  const fun = (await getJson('/api/funnel')).find((r) => r.branch === 'B_payment') || {};
  const csv = await (await fetch((process.env.BACKEND_URL || 'http://localhost:3000') + '/api/export.csv')).text();
  record('F13', 'Purchase via the nudge link is credited to the nudge', 'attributed=true, KES 49 on stats and funnel; a foreign nid is not credited; CSV export has the row',
    `attributed=${buy.attributed}, foreign nid attributed=${fakeBuy.attributed}, stats KES ${st.attributed_kes}, funnel B_payment purchases ${fun.purchases} KES ${fun.revenue_kes}, CSV lines ${csv.trim().split(/\r?\n/).length}`,
    buy.attributed === true && fakeBuy.attributed === false && st.attributed_kes === 49 && fun.revenue_kes === 49 && /purchased/.test(csv), '');

  // ---- G9 Consent evidence
  await api('/api/users/u_brian/consent', { whatsapp: true, source: 'functional-test' });
  const cr = (await getJson('/api/logs')).find((r) => r.stage === 'consent_changed' && r.user_id === 'u_brian');
  record('F14', 'Consent change is recorded as evidence', 'consent_changed row with before, after, source',
    cr ? `${cr.message}; before.whatsapp=${cr.before.whatsapp} after.whatsapp=${cr.after.whatsapp} source=${cr.source}` : 'no row', Boolean(cr && cr.before.whatsapp === false && cr.after.whatsapp === true), '');

  // ---- G3 Email round trip through the Mailtrap sandbox (HTTPS API)
  const health = await getJson('/api/health');
  if (health.email !== 'mailtrap-api') record('F12', 'Email lands in the Mailtrap sandbox', 'message in the inbox', 'email mode ' + health.email, null, 'MAILTRAP_API_TOKEN / MAILTRAP_TEST_INBOX_ID not set');
  else {
    await reset();
    await api('/api/admin/email', { live: true });
    const em = await ev('payment_failed', 'u_brian', 't_kizingo', { payment_method: 'bonga', failure_reason: 'not_completed' });
    logs = await waitDone([em]);
    const s = rowsFor(logs, em).find((r) => r.stage === 'sent' || r.stage === 'failed');
    const envTxt = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
    const g = (k) => ((envTxt.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1] || '').trim();
    let found = null;
    for (let i = 0; i < 10 && !found; i++) {
      await sleep(2000);
      const r = await fetch(`https://mailtrap.io/api/accounts/${g('MAILTRAP_ACCOUNT_ID')}/inboxes/${g('MAILTRAP_TEST_INBOX_ID')}/messages`, { headers: { 'Api-Token': g('MAILTRAP_API_TOKEN') } });
      const msgs = await r.json();
      found = Array.isArray(msgs) && msgs.find((m) => /KIZINGO/.test(m.subject) && m.to_email === 'brian@demo.yakwetu.test');
    }
    await emailOff();
    record('F12', 'Email lands in the Mailtrap sandbox', 'sent row delivery=live, message visible in the sandbox inbox',
      `${s && s.stage} delivery=${s && s.delivery} (${s && s.detail}); inbox: ${found ? '"' + found.subject + '" to ' + found.to_email : 'not found'}`, Boolean(s && s.delivery === 'live' && found), '');
  }

  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'functional.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.filter((r) => r.status === 'PASS').length}/${results.length} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
