// Phase 3 load generator. Fires events at /api/events and measures what the engine completes.
// Node 18+, no dependencies.
//
//   node tools/stress/load.js --rate 1 --duration 120 --mix payment:2,device:1,signup:1,browse:1
//   node tools/stress/load.js --burst 50 --mix payment:1,device:1,signup:1
//   node tools/stress/load.js --burst 30 --mix browse:1
//
// Options: --rate (events/s), --duration (s), --burst (fire N at once instead), --concurrency (max in-flight POSTs),
// --drain (s to wait for runs to finish after firing, default 180), --label, --no-reset.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { api, getJson, sleep, pct, TERMINAL } = require('./lib');

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => {
  const [k, ...v] = s.trim().split(/\s+/);
  return [k, v.length ? v.join(' ') : true];
}));
const rate = Number(args.rate || 1);
const duration = Number(args.duration || 60);
const burst = args.burst ? Number(args.burst) : 0;
const concurrency = Number(args.concurrency || 50);
const drainS = Number(args.drain || 180);
const label = args.label || (burst ? `burst-${burst}` : `steady-${rate}x${duration}`);
const mix = Object.fromEntries(String(args.mix || 'payment:1,device:1,signup:1,browse:1').split(',').map((x) => { const [k, w] = x.split(':'); return [k, Number(w || 1)]; }));

const USERS = ['u_amina', 'u_brian', 'u_wanjiru', 'u_kevo', 'u_otieno'];
let n = 0;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function makeEvent(kind, titles) {
  n++;
  const user_id = pick(USERS);
  const title_id = titles[n % titles.length];
  switch (kind) {
    case 'payment': return { event: 'payment_failed', user_id, title_id, context: { payment_method: pick(['mpesa', 'bonga', 'visa', 'mastercard']), failure_reason: 'not_completed' } };
    case 'device': return { event: 'unsupported_device', user_id, title_id, context: { platform: pick(['android', 'ios', 'desktop_non_chrome']) } };
    case 'signup': return { event: 'auth_abandoned', user_id, title_id, context: { ref: title_id } };
    case 'browse': return { event: pick(['preview_completed', 'title_viewed']), user_id, title_id, context: {} };
    default: throw new Error('unknown mix kind ' + kind);
  }
}
const kinds = Object.entries(mix).flatMap(([k, w]) => Array(w).fill(k));

function dockerStats() {
  try {
    return execSync('docker stats --no-stream --format "{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}"', { encoding: 'utf8', timeout: 20000 })
      .trim().split('\n').map((l) => { const [name, mem, cpu] = l.split('|'); return { name: name.replace('yakwetu-engagement-engine-', ''), mem: mem.split(' / ')[0], cpu }; });
  } catch (e) { return [{ error: e.message }]; }
}

async function main() {
  if (!args['no-reset']) await api('/api/admin/reset', {});
  await api('/api/admin/email', { live: false }); // don't burn the Mailtrap quota
  const titles = (await getJson('/api/catalog')).map((t) => t.id);
  const statsBefore = dockerStats();
  const fired = []; // { event_id, kind, t_post, status }
  let inflight = 0, postErrors = 0;
  const post = async (kind) => {
    while (inflight >= concurrency) await sleep(5);
    inflight++;
    const t = Date.now();
    try {
      const r = await api('/api/events', makeEvent(kind, titles));
      fired.push({ event_id: r.event && r.event.event_id, kind, t_post: t, http: r.status, ms: Date.now() - t });
      if (r.status !== 200) postErrors++;
    } catch (e) { postErrors++; fired.push({ kind, t_post: t, http: 'ERR ' + e.message }); }
    inflight--;
  };

  const t0 = Date.now();
  const peakStats = [];
  const statTimer = setInterval(() => peakStats.push({ t: (Date.now() - t0) / 1000, s: dockerStats() }), 15000);
  if (burst) {
    await Promise.all(Array.from({ length: burst }, (_, i) => post(kinds[i % kinds.length])));
  } else {
    const total = Math.round(rate * duration);
    const jobs = [];
    for (let i = 0; i < total; i++) {
      const due = t0 + (i / rate) * 1000;
      while (Date.now() < due) await sleep(Math.min(50, due - Date.now()));
      jobs.push(post(kinds[i % kinds.length]));
    }
    await Promise.all(jobs);
  }
  const fireSecs = (Date.now() - t0) / 1000;

  // Drain: wait until every fired event has a terminal row, or the drain budget runs out.
  const ids = fired.filter((f) => f.event_id).map((f) => f.event_id);
  let logs = [];
  const dEnd = Date.now() + drainS * 1000;
  while (Date.now() < dEnd) {
    logs = await getJson('/api/logs');
    const done = new Set(logs.filter((l) => TERMINAL.has(l.stage)).map((l) => l.event_id));
    if (ids.every((id) => done.has(id))) break;
    await sleep(2000);
  }
  clearInterval(statTimer);
  const statsAfter = dockerStats();

  const byId = new Map();
  for (const l of logs) { if (!l.event_id) continue; if (!byId.has(l.event_id)) byId.set(l.event_id, []); byId.get(l.event_id).push(l); }
  const outcome = {}, lat = { all: [] }, perKind = {};
  let ai = 0, fallback = 0, errors = 0, lost = 0;
  const fallbackReasons = {};
  for (const f of fired.filter((x) => x.event_id)) {
    const rows = byId.get(f.event_id) || [];
    const term = rows.find((r) => TERMINAL.has(r.stage));
    const key = term ? term.stage + (term.reason ? ':' + term.reason : '') : 'LOST (no terminal row)';
    outcome[key] = (outcome[key] || 0) + 1;
    perKind[f.kind] = perKind[f.kind] || { fired: 0, sent: 0, lat: [] };
    perKind[f.kind].fired++;
    if (!term) lost++;
    if (rows.some((r) => r.status === 'error')) errors++;
    const firedRow = rows.find((r) => r.stage === 'fired');
    const sent = rows.find((r) => r.stage === 'sent');
    if (sent && firedRow) {
      const s = (Date.parse(sent.ts) - Date.parse(firedRow.ts)) / 1000;
      lat.all.push(s); perKind[f.kind].lat.push(s); perKind[f.kind].sent++;
      if (sent.source === 'ai') ai++;
      if (sent.source === 'fallback') { fallback++; const r = String(sent.reason).split(':')[0]; fallbackReasons[r] = (fallbackReasons[r] || 0) + 1; }
    }
  }
  const workflowErrors = logs.filter((l) => l.reason === 'workflow_error').length;
  const report = {
    label, config: { rate, duration, burst, concurrency, mix },
    fired: fired.length, post_errors: postErrors, fire_seconds: Number(fireSecs.toFixed(1)),
    post_ms_p50: pct(fired.map((f) => f.ms).filter(Boolean), 50), post_ms_p95: pct(fired.map((f) => f.ms).filter(Boolean), 95),
    completed: fired.length - lost - postErrors, lost, outcome,
    fired_to_sent_s: { p50: pct(lat.all, 50), p95: pct(lat.all, 95), max: pct(lat.all, 100) },
    per_kind: Object.fromEntries(Object.entries(perKind).map(([k, v]) => [k, { fired: v.fired, sent: v.sent, p50: pct(v.lat, 50), p95: pct(v.lat, 95), max: pct(v.lat, 100) }])),
    ai, fallback, fallback_reasons: fallbackReasons, error_rows: errors, workflow_errors: workflowErrors,
    total_seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    docker_before: statsBefore, docker_during: peakStats, docker_after: statsAfter,
  };
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', `load-${label}.json`), JSON.stringify(report, null, 2));
  const { docker_before, docker_during, ...brief } = report;
  console.log(JSON.stringify(brief, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
