const $ = (s, el = document) => el.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return r.json();
};
const STAGES = ['Event', 'Wait', 'Checks', 'Message', 'Delivery'];
const CONSENT = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };
const fmtReal = (m) => m == null ? '' : m === 0 ? 'no delay' : m < 60 ? `${m} min` : m < 1440 ? `${+(m / 60).toFixed(1)} h` : `${Math.round(m / 1440)} days`;
const labelChannel = (c) => ({ whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' }[c] || c);
const labelSource = (s) => ({ ai: 'Written by AI', fallback: 'AI rejected, fallback sent', template: 'Template' }[s] || s);
const branchName = (b) => ({ A_browse: 'Browse recovery', B_payment: 'Payment rescue', B_device: 'Device bridge', signup_rescue: 'Sign-up rescue', winback: 'Win-back' }[b] || b);
const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const timeOf = (ts) => {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};
const toastText = (s) => String(s || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();

const session = {
  user: () => sessionStorage.getItem('yak.user'),
  setUser: (id) => sessionStorage.setItem('yak.user', id),
  device: () => sessionStorage.getItem('yak.device') || 'supported',
  setDevice: (v) => sessionStorage.setItem('yak.device', v),
  signed: () => { try { return JSON.parse(sessionStorage.getItem('yak.signed') || '{}'); } catch { return {}; } },
  setSigned: (map) => sessionStorage.setItem('yak.signed', JSON.stringify(map)),
};

function bulbState(r) {
  const s = Object.fromEntries(STAGES.map((x) => [x, '']));
  for (const row of r.rows) {
    if (row.stage === 'fired') s.Event = 'done';
    if (row.stage === 'duplicate' || (row.stage === 'suppressed' && row.at === 'admit')) s.Wait = 'stop';
    if (row.stage === 'waiting') s.Wait = 'on';
    if (row.stage === 'checked') { s.Wait = 'done'; s.Checks = 'done'; }
    if (row.stage === 'suppressed' && (row.at === 'gate' || row.at === 'lock')) { s.Wait = 'done'; s.Checks = 'stop'; }
    // Bought while the message was being prepared: the final re-check stops delivery.
    if (row.stage === 'suppressed' && row.at === 'final_check') { s.Message = 'done'; s.Delivery = 'stop'; }
    if (row.stage === 'sent') { s.Message = 'done'; s.Delivery = 'done'; }
    if (row.stage === 'failed') s.Delivery = 'stop';
  }
  if (s.Checks === 'done' && !s.Delivery) s.Message = 'on';
  return s;
}

// A run with no decision this long after its wait ended was lost (e.g. n8n restarted mid-wait). Say so instead of "Waiting" forever.
const LOST_AFTER_S = 60;
function lostRun(r) {
  const w = r.rows.find((x) => x.stage === 'waiting');
  if (!w || r.rows.some((x) => ['sent', 'failed', 'suppressed', 'duplicate'].includes(x.stage))) return false;
  return Date.now() > Date.parse(w.ts) + ((w.demo_delay_s || 0) + LOST_AFTER_S) * 1000;
}

function runStatus(r) {
  if (r.rows.some((x) => x.stage === 'sent')) return 'sent';
  if (r.rows.some((x) => x.stage === 'failed')) return 'failed';
  if (r.rows.some((x) => x.stage === 'duplicate' || x.stage === 'suppressed')) return 'held';
  if (lostRun(r)) return 'lost';
  if (r.rows.some((x) => x.stage === 'waiting') && bulbState(r).Wait === 'on') return 'waiting';
  return 'open';
}

function ingestRow(row, runs, notes) {
  if (row.stage === 'purchased' || row.stage === 'inactive_armed' || !row.event_id) {
    notes.push(row);
    return 'n' + row.id;
  }
  const same = [...runs.entries()].filter(([, r]) => r.event_id === row.event_id);
  let key, target;
  if (row.stage === 'fired' || !same.length) {
    key = row.event_id + (row.replay ? '#' + row.id : '');
    target = { event_id: row.event_id, first: row.id, rows: [] };
    runs.set(key, target);
  } else {
    [key, target] = row.stage === 'duplicate' ? same[same.length - 1] : same[0];
  }
  target.rows.push(row);
  return key;
}

function closeListboxes() {
  document.querySelectorAll('.listbox-menu').forEach((el) => { el.hidden = true; });
  document.querySelectorAll('.listbox-btn').forEach((el) => el.setAttribute('aria-expanded', 'false'));
}

function pathHas(e, sel) {
  return e.composedPath().some((n) => n.nodeType === 1 && n.matches(sel));
}

function closeWho() {
  clearTimeout(closeWho.timer);
  closeWho.timer = null;
  document.querySelectorAll('.who-panel').forEach((el) => { el.hidden = true; });
  document.querySelectorAll('.who-btn').forEach((el) => el.setAttribute('aria-expanded', 'false'));
}

function stayWho() {
  clearTimeout(closeWho.timer);
  closeWho.timer = null;
}

function leaveWhoSoon() {
  if (![...document.querySelectorAll('.who-panel')].some((el) => !el.hidden)) return;
  clearTimeout(closeWho.timer);
  closeWho.timer = setTimeout(closeWho, 2000);
}

function closeMenus() {
  closeListboxes();
  closeWho();
}

function listboxValue(el) { return el.dataset.value; }

function setListbox(el, value, silent) {
  el.dataset.value = value;
  const label = $('.listbox-value', el);
  for (const opt of el.querySelectorAll('[data-value]')) {
    const on = opt.dataset.value === value;
    opt.setAttribute('aria-selected', on);
    if (on && label) label.textContent = opt.textContent.trim();
  }
  if (!silent) el.dispatchEvent(new Event('change', { bubbles: true }));
}

function bindListboxes(root = document) {
  root.querySelectorAll('[data-listbox]').forEach((box) => {
    const btn = $('.listbox-btn', box);
    const menu = $('.listbox-menu', box);
    setListbox(box, box.dataset.value || $('.listbox-menu [data-value]', box).dataset.value, true);
    btn.onclick = (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      closeListboxes();
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    };
    menu.onclick = (e) => {
      const opt = e.target.closest('[data-value]');
      if (!opt) return;
      setListbox(box, opt.dataset.value);
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    };
  });
}

// Funnel per branch: runs in, held back (by reason), sent (by channel), purchases credited to a nudge, revenue.
function drawFunnel(rows) {
  const host = $('#funnel');
  if (!host) return;
  const list = (o) => Object.entries(o).map(([k, v]) => `${escapeHtml(labelChannel(k).replace(/_/g, ' '))} ${v}`).join(', ') || '—';
  host.innerHTML = rows.length
    ? `<table><thead><tr><th>Branch</th><th>Runs</th><th>Held back</th><th>Sent</th><th>Bought from nudge</th><th>KES</th></tr></thead><tbody>`
      + rows.map((r) => `<tr><td>${escapeHtml(branchName(r.branch))}</td><td>${r.events}${r.duplicates ? ` (+${r.duplicates} dup)` : ''}</td><td>${list(r.suppressed)}</td><td>${list(r.sent)}${r.failed ? `, failed ${r.failed}` : ''}</td><td>${r.purchases}</td><td>${r.revenue_kes}</td></tr>`).join('')
      + '</tbody></table>'
    : '<p class="empty">No runs yet.</p>';
}

function LogBoard({ compact } = {}) {
  const runs = new Map();
  const notes = [];
  const shut = new Set();
  let users = [], catalog = [], filter = 'all', openKey = null;

  const userName = (id) => (users.find((u) => u.id === id) || {}).name || id || '—';
  const titleName = (id) => (catalog.find((t) => t.id === id) || {}).name || '';

  function noteStatus(n) {
    if (n.stage === 'purchased') return 'bought';
    if (n.stage === 'inactive_armed') return 'waiting';
    if (n.stage === 'consent_changed') return 'consent';
    return 'open';
  }

  function items() {
    const cards = [...runs.entries()].map(([key, r]) => {
      const fired = r.rows.find((x) => x.stage === 'fired') || r.rows[0];
      return {
        key, at: r.first, kind: 'run', r,
        status: runStatus(r),
        ts: fired.ts,
        branch: (r.rows.find((x) => x.branch) || {}).branch || '',
        user_id: fired.user_id,
        title_id: fired.title_id,
        label: fired.message || 'Event',
      };
    });
    const extra = notes.map((n) => ({
      key: 'n' + n.id, at: n.id, kind: 'note', n,
      status: noteStatus(n),
      ts: n.ts,
      branch: n.branch || '',
      user_id: n.user_id,
      title_id: n.title_id,
      label: n.message,
    }));
    return [...cards, ...extra].sort((a, b) => b.at - a.at);
  }

  function visible() {
    const all = items();
    return filter === 'all' ? all : all.filter((x) => x.status === filter || (filter === 'failed' && x.status === 'lost'));
  }

  function replayLast() {
    const fired = [...runs.values()].flatMap((r) => r.rows).filter((x) => x.stage === 'fired').sort((a, b) => b.id - a.id)[0];
    if (!fired) return;
    api('/api/events', { method: 'POST', body: { event: fired.event, event_id: fired.event_id, user_id: fired.user_id, title_id: fired.title_id } });
  }

  function rowHtml(item) {
    const st = item.status;
    const word = { sent: 'Sent', held: 'Held', failed: 'Failed', lost: 'Lost', waiting: 'Waiting', bought: 'Bought', consent: 'Consent', open: 'Open' }[st] || st;
    const extra = item.kind === 'run' && st === 'sent'
      ? ` · ${labelChannel((item.r.rows.find((x) => x.channel) || {}).channel)}`
      : item.kind === 'note' && item.n.attributed ? ` · KES ${item.n.revenue_kes} from nudge` : '';
    const text = titleName(item.title_id) || item.label;
    const who = userName(item.user_id);
    return `<button class="row" data-key="${escapeHtml(item.key)}" type="button" aria-expanded="${item.key === openKey}">
      <span class="status ${st}"><i class="dot ${st}"></i>${word}${extra}</span>
      <span class="t">${timeOf(item.ts)}</span>
      <span class="who">${escapeHtml(who)}</span>
      <span class="title">${escapeHtml(text)}</span>
    </button>`;
  }

  function runDetail(r) {
    const s = bulbState(r);
    const waiting = r.rows.find((x) => x.stage === 'waiting');
    const sent = r.rows.find((x) => x.stage === 'sent' || (x.stage === 'failed' && x.channel));
    const steps = r.rows.filter((x) => x.stage !== 'fired').map((x) => {
      const cls = ['suppressed', 'duplicate', 'failed'].includes(x.stage) ? 'stop' : 'ok';
      let text = x.message && x.stage !== 'sent' ? x.message : '';
      if (x.stage === 'sent') text = `Sent by ${labelChannel(x.channel)}${x.delivery === 'simulated' ? ' (simulated, no credentials set)' : x.delivery === 'logged' ? ' (logged only)' : ''}`;
      if (x.stage === 'failed' && x.channel) text = `Delivery by ${labelChannel(x.channel)} failed: ${x.detail}`;
      return text ? `<li class="${cls}">${escapeHtml(text)}</li>` : '';
    }).join('') + (lostRun(r) ? `<li class="stop">No decision ${LOST_AFTER_S} s after the wait ended: this run was lost (n8n restarted or the platform was down). Nothing was sent.</li>` : '');
    const clock = waiting && s.Wait === 'on' && !lostRun(r)
      ? `<div class="clock" data-end="${Date.parse(waiting.ts) + waiting.demo_delay_s * 1000}" data-real="${waiting.real_delay_min}"></div>`
      : '';
    const why = sent && sent.source === 'fallback' && sent.reason ? ` (${escapeHtml(sent.reason)})` : '';
    const msg = sent && sent.message
      ? `<div class="message"><span class="tag">${escapeHtml(labelSource(sent.source))}${why}</span>${escapeHtml(sent.message)}</div>`
      : '';
    return `<div class="bulbs">${STAGES.map((x) => `<div class="bulb ${s[x]}"><span class="bar"></span>${x}</div>`).join('')}</div>
      ${clock}<ul class="steps">${steps}</ul>${msg}`;
  }

  function noteDetail(n) {
    const clock = n.stage === 'inactive_armed'
      ? `<div class="clock" data-end="${Date.parse(n.ts) + n.demo_delay_s * 1000}" data-real="${n.real_delay_min}"></div>`
      : '';
    return `<p>${escapeHtml(n.message)}</p>${clock}`;
  }

  function tick() {
    document.querySelectorAll('.clock[data-end]').forEach((el) => {
      const left = Math.max(0, (Number(el.dataset.end) - Date.now()) / 1000);
      el.textContent = left > 0
        ? `${left.toFixed(1)} s left in the demo · ${fmtReal(Number(el.dataset.real))} real`
        : `Wait over · ${fmtReal(Number(el.dataset.real))} real`;
    });
  }

  function draw() {
    const list = visible();
    const host = $('#rows');
    host.innerHTML = list.length
      ? `<div class="thead"><span>Status</span><span>Time</span><span class="who">Who</span><span>Message</span></div>`
        + list.map((item) => {
          const open = item.key === openKey;
          return `<article class="entry${open ? ' open' : ''}">${rowHtml(item)}<div class="detail" ${open ? '' : 'hidden'}>${item.kind === 'run' ? runDetail(item.r) : noteDetail(item.n)}</div></article>`;
        }).join('')
      : '<p class="empty">Nothing yet.</p>';
    tick();
  }

  function follow(key) {
    if (!key || shut.has(key)) return;
    openKey = key;
  }

  function stillLive(item) {
    if (shut.has(item.key) || (item.status !== 'waiting' && item.status !== 'open')) return false;
    const row = item.kind === 'note' ? item.n : (item.r.rows.find((x) => x.stage === 'waiting') || item.r.rows[0]);
    if (!row || row.demo_delay_s == null) return item.status === 'open';
    return Date.now() < Date.parse(row.ts) + row.demo_delay_s * 1000;
  }

  function seedOpen() {
    if (openKey) return;
    const live = items().find(stillLive);
    if (live) openKey = live.key;
  }

  async function stats() {
    const st = await api('/api/stats');
    if ($('#stats')) $('#stats').innerHTML = `<b>${st.sent}</b>sent &nbsp; <b>${st.suppressed}</b>held &nbsp; <b>${st.purchased}</b>bought &nbsp; <b>KES ${st.attributed_kes || 0}</b>from nudges &nbsp; <b>${st.ios_waitlist}</b>iPhone`;
    if ($('#funnel')) drawFunnel(await api('/api/funnel'));
    const stub = $('[data-listbox="stub"]');
    if (stub) setListbox(stub, st.aiStubMode, true);
  }

  function bind() {
    $('#rows').onclick = (e) => {
      const b = e.target.closest('.row');
      if (!b) return;
      if (openKey === b.dataset.key) {
        shut.add(b.dataset.key);
        openKey = null;
      } else {
        shut.delete(b.dataset.key);
        openKey = b.dataset.key;
      }
      draw();
    };
    const filters = $('#filters');
    if (filters) filters.onclick = (e) => {
      const b = e.target.closest('button[data-filter]');
      if (!b) return;
      filter = b.dataset.filter;
      for (const x of filters.querySelectorAll('button')) x.setAttribute('aria-pressed', x === b);
      draw();
    };
    if ($('#replay')) $('#replay').onclick = replayLast;
    const stub = $('[data-listbox="stub"]');
    if (stub) stub.addEventListener('change', () => api('/api/admin/ai-stub-mode', { method: 'POST', body: { mode: listboxValue(stub) } }));
    if ($('#reset')) $('#reset').onclick = () => api('/api/admin/reset', { method: 'POST' });
    setInterval(tick, 100);
    // Status can change with no new row (a run is declared lost), so re-check every few seconds.
    let sig = '';
    setInterval(() => { const now = items().map((x) => x.status).join(); if (now !== sig) { sig = now; draw(); } }, 3000);
  }

  async function start(onRow) {
    [users, catalog] = await Promise.all([api('/api/users'), api('/api/catalog')]);
    (await api('/api/logs')).forEach((row) => ingestRow(row, runs, notes));
    seedOpen();
    bind();
    draw();
    stats();
    const es = new EventSource('/api/logs/stream');
    es.onmessage = (e) => {
      const row = JSON.parse(e.data);
      follow(ingestRow(row, runs, notes));
      draw();
      stats();
      if (onRow) onRow(row);
    };
    es.addEventListener('reset', () => {
      runs.clear();
      notes.length = 0;
      shut.clear();
      openKey = null;
      draw();
      stats();
    });
  }

  return { start, compact };
}

document.querySelectorAll('.who').forEach((el) => {
  el.addEventListener('pointerenter', stayWho);
  el.addEventListener('pointerleave', leaveWhoSoon);
});
document.addEventListener('click', (e) => {
  if (!pathHas(e, '.listbox')) closeListboxes();
  if (pathHas(e, '.who')) stayWho();
  else if (pathHas(e, 'button, a, input, label, select, .listbox, .tile, .row, dialog, .phone')) leaveWhoSoon();
  else closeWho();
});
