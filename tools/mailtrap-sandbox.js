// Creates (or reuses) the Mailtrap Email Sandbox for this project and writes its SMTP settings into .env.
// Reads MAILTRAP_API_TOKEN and MAILTRAP_ACCOUNT_ID from .env. Never prints secrets.
// Run: node tools/mailtrap-sandbox.js
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');
const PROJECT = 'yakwetu-engagement-engine';
const INBOX = 'yakwetu-demo';

const text = fs.readFileSync(ENV_FILE, 'utf8');
const env = Object.fromEntries(text.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const token = env.MAILTRAP_API_TOKEN, account = env.MAILTRAP_ACCOUNT_ID;
if (!token || !account) { console.error('MAILTRAP_API_TOKEN and MAILTRAP_ACCOUNT_ID must be set in .env'); process.exit(1); }

const api = async (method, p, body) => {
  const r = await fetch(`https://mailtrap.io/api/accounts/${account}${p}`, {
    method, headers: { 'Api-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
};

function setEnv(src, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(src) ? src.replace(re, `${key}=${value}`) : src.replace(/\s*$/, `\n${key}=${value}\n`);
}

(async () => {
  // Free plans allow one project: reuse ours if it exists, else create it, else put the inbox in the existing project.
  const projects = await api('GET', '/projects');
  let project = projects.find((p) => p.name === PROJECT) || projects.find((p) => (p.inboxes || []).some((i) => i.name === INBOX));
  if (!project) {
    try { project = await api('POST', '/projects', { project: { name: PROJECT } }); }
    catch (e) { if (!/limit/i.test(e.message) || !projects.length) throw e; project = projects[0]; console.log(`Project limit reached; using existing project "${project.name}".`); }
  }
  let inbox = (project.inboxes || []).find((i) => i.name === INBOX);
  if (!inbox) {
    try { inbox = await api('POST', `/projects/${project.id}/inboxes`, { inbox: { name: INBOX } }); }
    catch (e) { if (!/limit/i.test(e.message) || !(project.inboxes || []).length) throw e; inbox = project.inboxes[0]; console.log(`Sandbox limit reached; using existing sandbox "${inbox.name}".`); }
  }
  inbox = await api('GET', `/inboxes/${inbox.id}`);

  let out = text;
  out = setEnv(out, 'SMTP_HOST', inbox.domain || 'sandbox.smtp.mailtrap.io');
  out = setEnv(out, 'SMTP_PORT', String((inbox.smtp_ports || [2525]).includes(2525) ? 2525 : inbox.smtp_ports[0]));
  out = setEnv(out, 'SMTP_USER', inbox.username);
  out = setEnv(out, 'SMTP_PASS', inbox.password);
  out = setEnv(out, 'MAILTRAP_TEST_INBOX_ID', String(inbox.id));
  fs.writeFileSync(ENV_FILE, out);
  console.log(`Sandbox project "${project.name}" (id ${project.id}), inbox "${inbox.name}" (id ${inbox.id}) ready.`);
  console.log('Wrote SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAILTRAP_TEST_INBOX_ID to .env');
})().catch((e) => { console.error(e.message); process.exit(1); });
