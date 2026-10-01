// Shared helpers for the audit scripts in tools/stress/. Node 18+, no dependencies.
const BACKEND = process.env.BACKEND_URL || 'http://localhost:3000';
const WEBHOOK = process.env.WEBHOOK_URL || 'http://localhost:5678/webhook/yak/events';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// x-yak-key: from the environment, else from the repo's .env (the key n8n uses), so tests work with no extra setup.
function yakKey() {
  if (process.env.YAK_KEY !== undefined) return process.env.YAK_KEY;
  try { const m = require('fs').readFileSync(require('path').join(__dirname, '..', '..', '.env'), 'utf8').match(/^YAK_KEY=(.*)$/m); return m ? m[1].trim() : ''; } catch { return ''; }
}
const KEY = yakKey();
// Load and stress runs must not burn the Mailtrap quota: they switch real email off after each reset.
const emailOff = () => api('/api/admin/email', { live: false });

async function api(path, body, method) {
  const r = await fetch(BACKEND + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', 'x-yak-key': KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  try { return { status: r.status, ...JSON.parse(text) }; } catch { return { status: r.status, raw: text }; }
}
const getJson = async (path) => (await fetch(BACKEND + path)).json();

const TERMINAL = new Set(['sent', 'suppressed', 'duplicate', 'failed']);
const rowsFor = (logs, id) => logs.filter((l) => l.event_id === id);

// Poll the log until every id has a terminal row (or timeout). Returns the full log.
async function waitDone(ids, timeoutMs = 120000) {
  const t0 = Date.now();
  let logs = [];
  while (Date.now() - t0 < timeoutMs) {
    logs = await getJson('/api/logs');
    if (ids.every((id) => rowsFor(logs, id).some((r) => TERMINAL.has(r.stage)))) return logs;
    await sleep(500);
  }
  return logs;
}

const results = [];
function record(id, name, expected, actual, pass, evidence) {
  const status = pass === null ? 'BLOCKED' : pass ? 'PASS' : 'FAIL';
  results.push({ id, name, expected, actual, status, evidence });
  console.log(`[${status}] ${id} ${name}\n    expected: ${expected}\n    actual:   ${actual}`);
}

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

module.exports = { KEY, emailOff, BACKEND, WEBHOOK, sleep, api, getJson, waitDone, rowsFor, record, results, pct, TERMINAL };
