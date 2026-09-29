let users = [], catalog = [], current = null, pendingTitle = null;

const me = () => users.find((u) => u.id === current);
const isIn = (id) => session.signed()[id] !== false;

async function load() {
  [users, catalog] = await Promise.all([api('/api/users'), api('/api/catalog')]);
  current = session.user() || users[0].id;
  if (!users.some((u) => u.id === current)) current = users[0].id;
  session.setUser(current);
  renderWho();
  renderGrid();
}

function renderWho() {
  const u = me();
  $('#whoAvatar').src = `/avatars/${u.id}.jpg`;
  $('#whoAvatar').alt = u.name;
  $('#whoName').textContent = u.name;
  $('#people').innerHTML = users.map((p) =>
    `<button class="person" aria-pressed="${p.id === current}" data-id="${p.id}"><img class="avatar" src="/avatars/${p.id}.jpg" alt=""><span>${p.name}<small>${p.language}</small></span></button>`
  ).join('');
  $('#consent').innerHTML = ['whatsapp', 'sms', 'email'].map((c) =>
    `<label><input type="checkbox" data-c="${c}" ${u.consent[c] ? 'checked' : ''}> ${CONSENT[c]}</label>`
  ).join('');
  $('#signedIn').checked = isIn(u.id);
  setListbox($('[data-listbox="device"]'), session.device(), true);
}

function renderGrid() {
  const u = me();
  $('#grid').innerHTML = catalog.map((t) => {
    const owned = u.owned.includes(t.id);
    return `<article class="tile">
      <div class="poster"><img src="/posters/${t.view_id}.jpg" alt="${escapeHtml(t.name)}"></div>
      <div class="meta"><strong>${escapeHtml(t.name)}</strong><b>KES ${t.price_kes}</b></div>
      <div class="actions">
        <button data-act="look" data-id="${t.id}" ${owned ? 'disabled' : ''}>${t.preview ? 'Preview' : 'View'}</button>
        ${owned ? '<button disabled class="owned">Owned</button>' : `<button class="buy" data-act="buy" data-id="${t.id}">Buy</button>`}
      </div></article>`;
  }).join('');
}

async function fire(event, title_id, context = {}) {
  await api('/api/events', { method: 'POST', body: { event, user_id: current, title_id, context } });
}

function openDialog(id) { $(id).showModal(); }
function closeDialog(id) { const d = $(id); if (d.open) d.close(); }

function openPlayer(t) {
  pendingTitle = t;
  $('#playerPoster').src = `/posters/${t.view_id}.jpg`;
  $('#playerTitle').textContent = t.name;
  $('#playerNote').textContent = t.preview
    ? 'This is the free preview. Leave when you have seen enough.'
    : 'This is the title page. Leave without buying.';
  $('#playerLeave').textContent = t.preview ? 'Leave preview' : 'Leave';
  openDialog('#player');
}

let ignoreGrid = false;
function leavePlayer() {
  const t = pendingTitle;
  pendingTitle = null;
  ignoreGrid = true;
  closeDialog('#player');
  setTimeout(() => { ignoreGrid = false; }, 280);
  if (!t) return;
  fire(t.preview ? 'preview_completed' : 'title_viewed', t.id, { seconds_watched: t.preview ? 90 : 0 });
}

function openSignIn(t) {
  pendingTitle = t;
  openDialog('#signin');
}

function openDeviceBlock(t) {
  pendingTitle = t;
  openDialog('#deviceBlock');
}

function openCheckout(t) {
  pendingTitle = t;
  $('#payPoster').src = `/posters/${t.view_id}.jpg`;
  $('#payTitle').textContent = t.name;
  $('#payPrice').textContent = `KES ${t.price_kes}`;
  openDialog('#checkout');
}

async function startBuy(t) {
  if (!isIn(current)) return openSignIn(t);
  if (session.device() !== 'supported') return openDeviceBlock(t);
  openCheckout(t);
}

async function pay() {
  const t = pendingTitle;
  const outcome = listboxValue($('[data-listbox="payment"]'));
  closeDialog('#checkout');
  if (!t) return;
  if (outcome === 'success') {
    await api('/api/purchases', { method: 'POST', body: { user_id: current, title_id: t.id } });
    await load();
  } else {
    await fire('payment_failed', t.id, { failure_reason: outcome, payment_method: listboxValue($('[data-listbox="method"]')) });
  }
}

// Only Visa and Mastercard can be declined; M-Pesa and Bonga points either complete or not.
function syncPaymentOutcomes() {
  const card = ['visa', 'mastercard'].includes(listboxValue($('[data-listbox="method"]')));
  const outcome = $('[data-listbox="payment"]');
  $('[data-value="card_declined"]', outcome).hidden = !card;
  if (!card && listboxValue(outcome) === 'card_declined') setListbox(outcome, 'not_completed', true);
}

function showToast(row) {
  const u = users.find((x) => x.id === row.user_id);
  const channel = row.channel || 'whatsapp';
  const phone = $('#phone');
  phone.className = `phone ${channel}`;
  $('#toastApp').textContent = labelChannel(channel);
  $('#toastWho').textContent = 'YAKWETU' + (u ? ` · ${u.name}` : '');
  $('#toastBody').textContent = toastText(row.message);
  const el = $('#toast');
  el.hidden = false;
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => { el.hidden = true; }, 8000);
}

$('#whoBtn').onclick = (e) => {
  e.stopPropagation();
  const panel = $('#whoPanel');
  const open = panel.hidden;
  closeListboxes();
  if (open) {
    stayWho();
    panel.hidden = false;
    $('#whoBtn').setAttribute('aria-expanded', 'true');
  } else {
    closeWho();
  }
};
$('#people').onclick = (e) => {
  const b = e.target.closest('.person');
  if (!b) return;
  e.stopPropagation();
  current = b.dataset.id;
  session.setUser(current);
  renderWho();
  renderGrid();
  stayWho();
};
$('#consent').onchange = async (e) => {
  const c = e.target.dataset.c;
  if (!c) return;
  await api(`/api/users/${current}/consent`, { method: 'POST', body: { [c]: e.target.checked } });
  await load();
  stayWho();
};
$('#signedIn').onchange = (e) => {
  const map = session.signed();
  map[current] = e.target.checked;
  session.setSigned(map);
};
$('[data-listbox="device"]').addEventListener('change', (e) => session.setDevice(listboxValue(e.currentTarget)));
$('[data-listbox="method"]').addEventListener('change', syncPaymentOutcomes);
$('#goQuiet').onclick = () => {
  api(`/api/users/${current}/inactive`, { method: 'POST' });
};
$('#grid').onclick = (e) => {
  if (ignoreGrid) return;
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const t = catalog.find((x) => x.id === b.dataset.id);
  if (b.dataset.act === 'look') openPlayer(t);
  else startBuy(t);
};
$('#playerLeave').onclick = leavePlayer;
$('#signLeave').onclick = () => { closeDialog('#signin'); fire('auth_abandoned', pendingTitle.id, { ref: pendingTitle.id }); };
$('#signIn').onclick = () => {
  const map = session.signed();
  map[current] = true;
  session.setSigned(map);
  renderWho();
  closeDialog('#signin');
  startBuy(pendingTitle);
};
$('#deviceClose').onclick = () => {
  closeDialog('#deviceBlock');
  fire('unsupported_device', pendingTitle.id, { platform: session.device() });
};
$('#payNow').onclick = pay;
$('#payCancel').onclick = () => closeDialog('#checkout');

(async function start() {
  bindListboxes();
  await load();
  const board = LogBoard({ compact: true });
  await board.start((row) => {
    if (row.stage === 'sent') showToast(row);
    if (row.stage === 'purchased' || row.stage === 'sent') load();
  });
})();
