// Phase 4 chaos tests. Stops and restarts containers while runs are mid-flight, and restores them afterwards.
// Run from the repo root: node tools/stress/chaos.js [group ...]   groups: ollama backend n8n state inactive malformed dupstorm
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { api, getJson, waitDone, rowsFor, record, results, sleep, WEBHOOK, BACKEND, emailOff } = require('./lib');

const dc = (...a) => { try { return execFileSync('docker', ['compose', ...a], { encoding: 'utf8', timeout: 180000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim(); } catch (e) { return 'ERR ' + (e.stderr || e.message).toString().slice(0, 300); } };
const ev = async (event, user_id, title_id, context = {}, extra = {}) => (await api('/api/events', { event, user_id, title_id, context, ...extra }));
const reset = async () => { await api('/api/admin/reset', {}); await emailOff(); };
const short = (r) => r ? `${r.stage}${r.reason ? ':' + r.reason : ''}${r.source ? ' [' + r.source + ']' : ''}` : 'none';
const up = async (url, ms = 90000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await sleep(1000); } return false; };
const execCounts = () => dc('exec', '-T', 'n8n', 'node', '-e', `const s=require("/usr/local/lib/node_modules/n8n/node_modules/sqlite3");const d=new s.Database("/home/node/.n8n/database.sqlite",s.OPEN_READONLY);d.all("select workflowId,status,count(*) n from execution_entity where workflowId='yakPipeline00001' group by status",(e,r)=>{console.log(JSON.stringify(r));d.close()})`);
const pipelineUp = async () => { const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null); return r && r.status === 200; };

const groups = {
  async ollama() {
    await reset();
    const e = await ev('preview_completed', 'u_amina', 't_priest_is_dead');
    await sleep(5000);
    const stop = dc('stop', 'ollama');
    const logs = await waitDone([e.event.event_id], 150000);
    const rows = rowsFor(logs, e.event.event_id);
    const s = rows.find((r) => r.stage === 'sent');
    record('C1', 'Ollama stopped during an AI-lane wait', 'fallback template sent, reason logged',
      short(s || rows[rows.length - 1]) + ' | ' + (s && s.reason), Boolean(s && s.source === 'fallback' && s.reason), `docker compose stop ollama -> ${stop.split('\n').pop()}`);
    dc('start', 'ollama');
    await up('http://localhost:11434/api/tags');
    const warm = await api('/api/admin/warm-ai', {});
    console.log('    ollama restarted, warm-up:', JSON.stringify(warm));
  },

  async backend() {
    await reset();
    const e = await ev('auth_abandoned', 'u_amina', 't_kienyeji', { ref: 't_kienyeji' });
    const id = e.event.event_id;
    await sleep(3000);
    const t0 = Date.now();
    dc('stop', 'backend');
    await sleep(8000);
    dc('start', 'backend');
    await up(BACKEND + '/api/health');
    const downFor = ((Date.now() - t0) / 1000).toFixed(1);
    await sleep(30000);
    const logs = await getJson('/api/logs');
    const rows = rowsFor(logs, id);
    record('C2', `Backend stopped mid-wait (sign-up rescue, 15.5 s wait), down ~${downFor} s, then restarted`,
      'run completes after restart; panel may lose earlier rows (in-memory)',
      `rows for event after restart: ${rows.map(short).join(', ') || 'none'}; total log rows: ${logs.length}`,
      rows.some((r) => r.stage === 'sent'), 'earlier fired/waiting rows are gone: in-memory log store was wiped by the restart');

    // Backend down at the moment the wait ends.
    await reset();
    const e2 = await ev('payment_failed', 'u_amina', 't_teka', { payment_method: 'mpesa', failure_reason: 'not_completed' });
    const before = execCounts();
    dc('stop', 'backend');
    await sleep(12000);
    dc('start', 'backend');
    await up(BACKEND + '/api/health');
    await sleep(5000);
    const logs2 = await getJson('/api/logs');
    record('C2b', 'Backend down when the 3.5 s payment wait ends', 'run lost or error logged somewhere visible',
      `log rows after restart: ${logs2.length} (${logs2.map(short).join(', ') || 'none'}); n8n pipeline executions before ${before} after ${execCounts()}`,
      false, 'the run errors inside n8n; the error workflow also posts to the (down) backend, so nothing reaches the panel');
    void e2;
  },

  async n8n() {
    await reset();
    const ids = [];
    for (const [evn, u, t] of [['preview_completed', 'u_amina', 't_priest_is_dead'], ['title_viewed', 'u_brian', 't_jonarobi'], ['auth_abandoned', 'u_kevo', 't_kienyeji'], ['auth_abandoned', 'u_amina', 't_teka']]) {
      ids.push((await ev(evn, u, t)).event.event_id);
    }
    await sleep(5000);
    const t0 = Date.now();
    dc('restart', 'n8n');
    const back = await up('http://localhost:5678/healthz', 120000);
    const restartS = ((Date.now() - t0) / 1000).toFixed(1);
    await sleep(60000);
    const logs = await getJson('/api/logs');
    const done = ids.filter((id) => rowsFor(logs, id).some((r) => ['sent', 'suppressed', 'failed'].includes(r.stage)));
    const stuck = ids.filter((id) => !done.includes(id));
    const webhookOk = await pipelineUp();
    record('C3', `n8n restarted while 4 runs sat in the Wait node (restart took ${restartS} s, healthz=${back})`, 'runs resume after restart',
      `${done.length}/4 finished, ${stuck.length} stuck at "waiting" forever; webhook accepts events after restart: ${webhookOk}`,
      stuck.length === 0, 'n8n keeps waits under 65 s in memory; a restart drops them. The panel shows them as "Waiting" with a finished countdown.');
  },

  async state() {
    await reset();
    await api('/api/users/u_amina/consent', { whatsapp: false });
    await api('/api/purchases', { user_id: 'u_brian', title_id: 't_teka' });
    const e = await ev('payment_failed', 'u_kevo', 't_teka', { payment_method: 'visa', failure_reason: 'card_declined' });
    await waitDone([e.event.event_id]);
    const beforeLogs = (await getJson('/api/logs')).length;
    dc('restart', 'backend');
    await up(BACKEND + '/api/health');
    const users = await getJson('/api/users');
    const amina = users.find((u) => u.id === 'u_amina'), brian = users.find((u) => u.id === 'u_brian');
    const afterLogs = (await getJson('/api/logs')).length;
    const replay = await api('/api/events', { event_id: e.event.event_id, event: 'payment_failed', user_id: 'u_kevo', title_id: 't_teka', context: { payment_method: 'visa', failure_reason: 'card_declined' } });
    const logs = await waitDone([replay.event.event_id]);
    const t = rowsFor(logs, e.event.event_id).find((r) => ['sent', 'duplicate'].includes(r.stage));
    record('C4', 'Backend restart: what state survives', 'documented: all state is in memory',
      `logs ${beforeLogs} -> ${afterLogs}; Amina whatsapp consent back to ${amina.consent.whatsapp}; Brian owns TEKA: ${brian.owned.includes('t_teka')}; replayed old event_id -> ${short(t)}`,
      false, 'consent changes, purchases, logs, dedupe set and nudge locks are lost; a replayed event is sent a second time');
  },

  async inactive() {
    await reset();
    const un = dc('exec', '-T', 'n8n', 'n8n', 'unpublish:workflow', '--id=yakPipeline00001');
    dc('restart', 'n8n');
    await up('http://localhost:5678/healthz', 120000);
    await sleep(3000);
    const r = await ev('payment_failed', 'u_amina', 't_teka', { payment_method: 'mpesa', failure_reason: 'not_completed' });
    const logs = await getJson('/api/logs');
    const f = logs.find((l) => l.reason === 'n8n_unreachable');
    record('C5', 'Pipeline workflow unpublished, event fired', 'backend answers 502 and logs failed:n8n_unreachable',
      `HTTP ${r.status}; row: ${f ? short(f) + ' - ' + f.message.slice(0, 90) : 'none'}`, Boolean(r.status === 502 && f), un.split('\n').pop());
    dc('exec', '-T', 'n8n', 'n8n', 'publish:workflow', '--id=yakPipeline00001');
    dc('restart', 'n8n');
    await up('http://localhost:5678/healthz', 120000);
    await sleep(3000);
    console.log('    pipeline republished, webhook ok:', await pipelineUp());
  },

  async malformed() {
    await reset();
    const big = 'x'.repeat(1024 * 1024);
    const viaBackend = [
      ['M1', 'missing event', { user_id: 'u_amina' }],
      ['M2', 'unknown user', { event: 'payment_failed', user_id: 'u_nobody', title_id: 't_teka' }],
      ['M3', 'unknown title', { event: 'payment_failed', user_id: 'u_amina', title_id: 't_nope' }],
      ['M4', 'user_id is a number', { event: 'payment_failed', user_id: 42, title_id: 't_teka' }],
      ['M5', 'context is a string', { event: 'payment_failed', user_id: 'u_brian', title_id: 't_teka', context: 'oops' }],
      ['M6', 'event is an array', { event: ['payment_failed'], user_id: 'u_brian', title_id: 't_teka' }],
      ['M7', 'unknown event name', { event: 'rocket_launched', user_id: 'u_brian', title_id: 't_teka' }],
      ['M8', '1 MB context field', { event: 'payment_failed', user_id: 'u_brian', title_id: 't_teka', context: { pad: big } }],
    ];
    for (const [id, name, body] of viaBackend) {
      const r = await fetch(BACKEND + '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const txt = (await r.text()).slice(0, 100);
      record(id, `Backend /api/events: ${name}`, 'rejected with 4xx, or handled and logged; never a crash', `HTTP ${r.status} ${txt}`, r.status < 500 || r.status === 502, '');
    }
    const raw = await fetch(BACKEND + '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    record('M9', 'Backend /api/events: invalid JSON', '400', `HTTP ${raw.status}`, raw.status === 400, '');
    await sleep(8000);
    const logs = await getJson('/api/logs');
    const m5 = logs.filter((l) => l.stage === 'sent' && l.user_id === 'u_brian').length;
    record('M10', 'Handled malformed events (string context, array event, unknown event, 1 MB pad)', 'each ends in a logged row, no workflow_error',
      `sent to Brian: ${m5}; suppressed: ${logs.filter((l) => l.stage === 'suppressed').map((l) => l.reason).join(',')}; workflow_error rows: ${logs.filter((l) => l.reason === 'workflow_error').length}`,
      !logs.some((l) => l.reason === 'workflow_error'), '');
    const mb2 = await fetch(BACKEND + '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'x', user_id: 'u_amina', pad: 'x'.repeat(2 * 1024 * 1024) }) });
    record('M11', 'Backend /api/events: 2 MB body', '413', `HTTP ${mb2.status}`, mb2.status === 413, 'express.json limit is 1mb');
    const direct = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_id: 'direct-1', event: 'payment_failed', user_id: 'u_amina', title_id: 't_teka', context: { payment_method: 'mpesa', failure_reason: 'not_completed' } }) });
    const dl = await waitDone(['direct-1']);
    record('M12', 'Event posted straight to the n8n webhook (no auth, bypassing the backend)', 'accepted by n8n; runs with no "fired" row',
      `HTTP ${direct.status}; rows: ${rowsFor(dl, 'direct-1').map(short).join(', ')}`, null, 'anyone who can reach :5678 can inject events');
  },

  async dupstorm() {
    await reset();
    const id = 'storm-' + Date.now();
    const body = { event_id: id, event: 'payment_failed', user_id: 'u_amina', title_id: 't_teka', context: { payment_method: 'mpesa', failure_reason: 'not_completed' } };
    await Promise.all(Array.from({ length: 20 }, () => api('/api/events', body)));
    await sleep(15000);
    const rows = rowsFor(await getJson('/api/logs'), id);
    const count = (s) => rows.filter((r) => r.stage === s).length;
    record('C8', 'Duplicate storm: same event_id x20 concurrently', 'exactly 1 sent, 19 duplicate',
      `fired=${count('fired')} duplicate=${count('duplicate')} sent=${count('sent')} waiting=${count('waiting')}`, count('sent') === 1 && count('duplicate') === 19, '');
  },
};

(async () => {
  const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(groups);
  for (const g of want) { console.log(`\n== ${g}`); await groups[g](); }
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  const file = path.join(__dirname, 'out', 'chaos.json');
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const merged = [...prev.filter((p) => !results.some((r) => r.id === p.id)), ...results];
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
