'use strict';
// Cashier screen.

const app = document.getElementById('app');
const S = {
  cashier: null,
  menu: null,          // { version, settings, stalls:[{id,name,color,items:[...]}] }
  items: new Map(),    // item id -> item with stall info
  stall: 'all',
  cart: [],            // [{ item_id, qty }] in the order items were added
  ref: null,           // unique reference for the cart being built (makes retries safe)
  tendered: null,      // cash received in cents, optional
  preorder: null,      // { id, code, total_cents } when the cart came from a phone pre-order
  busy: false,
  last: null,          // { order, change } of the order just settled
  online: true,
};
let stream = null;
let pollTimer = null;

const newRef = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));

// ---------- cart ----------
function saveCart() { localStorage.setItem('pos_cart', JSON.stringify({ cashier: S.cashier && S.cashier.id, cart: S.cart, ref: S.ref, preorder: S.preorder })); }
function restoreCart() {
  try {
    const c = JSON.parse(localStorage.getItem('pos_cart') || 'null');
    if (c && S.cashier && c.cashier === S.cashier.id && Array.isArray(c.cart)) { S.cart = c.cart; S.ref = c.ref; S.preorder = c.preorder || null; }
  } catch (e) { /* ignore a corrupt saved cart */ }
  if (!S.ref) S.ref = newRef();
}
function clearCart() { S.cart = []; S.ref = newRef(); S.tendered = null; S.preorder = null; saveCart(); }
// Let go of a pre-order this cashier opened but did not ring up, so another cashier can take it.
function releasePreorder() {
  if (S.preorder) api('POST', `/api/preorders/${S.preorder.id}/release`).catch(() => {});
}
const qtyOf = (id) => (S.cart.find((l) => l.item_id === id) || { qty: 0 }).qty;
function setQty(id, qty) {
  const line = S.cart.find((l) => l.item_id === id);
  if (qty <= 0) S.cart = S.cart.filter((l) => l.item_id !== id);
  else if (line) line.qty = Math.min(qty, 99);
  else S.cart.push({ item_id: id, qty: Math.min(qty, 99) });
  if (S.last) S.last = null;
  if (S.tendered != null && S.tendered < cartTotal()) S.tendered = null;
  saveCart();
  renderMenu(); renderCart();
}
const sellable = (it) => !!it && !!it.available;
const cartTotal = () => S.cart.reduce((sum, l) => sum + (sellable(S.items.get(l.item_id)) ? S.items.get(l.item_id).price_cents * l.qty : 0), 0);
const cartCount = () => S.cart.reduce((sum, l) => sum + l.qty, 0);
const cartBlocked = () => S.cart.some((l) => !sellable(S.items.get(l.item_id)));

// ---------- data ----------
async function loadMenu() {
  try {
    const m = await api('GET', '/api/menu');
    setOnline(true);
    if (S.menu && S.menu.version === m.version) return;
    S.menu = m;
    S.items = new Map();
    for (const st of m.stalls) for (const it of st.items) S.items.set(it.id, { ...it, stall_name: st.name, color: st.color });
    if (S.stall !== 'all' && !m.stalls.some((s) => s.id === S.stall)) S.stall = 'all';
    if (S.tendered != null && S.tendered < cartTotal()) S.tendered = null;
    document.title = m.settings.event_name + ' · POS';
    if (document.querySelector('.pos')) { renderHeader(); renderMenu(); renderCart(); }
  } catch (e) {
    if (e.status === 401) return signedOut();
    setOnline(false);
  }
}
function setOnline(v) {
  if (S.online === v) return;
  S.online = v;
  const dot = document.querySelector('.status');
  if (dot) { dot.classList.toggle('off', !v); dot.lastChild.textContent = v ? 'Connected' : 'Offline'; }
}
function startLive() {
  stopLive();
  stream = new EventSource('/api/events');
  stream.addEventListener('menu', loadMenu);
  stream.onopen = () => { setOnline(true); loadMenu(); };
  stream.onerror = () => setOnline(false);
  pollTimer = setInterval(loadMenu, 20000); // safety net if the live stream is blocked
}
function stopLive() { if (stream) stream.close(); stream = null; clearInterval(pollTimer); }
function signedOut() { stopLive(); S.cashier = null; S.menu = null; renderLogin(); }

// ---------- login ----------
function renderLogin(message) {
  let pin = '';
  let sending = false;
  const dots = h('div', { class: 'pin-dots' }, Array.from({ length: 6 }, () => h('span')));
  const msg = h('div', { class: 'pin-msg' }, message || '');
  const paint = () => [...dots.children].forEach((d, i) => d.classList.toggle('on', i < pin.length));
  async function press(k) {
    if (sending) return;
    if (k === 'back') pin = pin.slice(0, -1);
    else if (k === 'clear') pin = '';
    else if (pin.length < 6) pin += k;
    msg.textContent = '';
    paint();
    if (pin.length === 6) {
      sending = true;
      try {
        const r = await api('POST', '/api/login', { pin });
        S.cashier = r.cashier;
        document.removeEventListener('keydown', onKey);
        return enter();
      } catch (e) {
        msg.textContent = e.message;
        pin = ''; paint();
      }
      sending = false;
    }
  }
  function onKey(e) {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('back');
    else if (e.key === 'Escape') press('clear');
  }
  document.addEventListener('keydown', onKey);
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];
  put(app, h('div', { class: 'login' },
    h('div', { class: 'login-card' },
      h('div', { class: 'diya' }, '🪔'),
      h('h1', {}, 'Food Stall POS'),
      h('p', { class: 'login-sub' }, 'Enter your 6-digit cashier PIN'),
      dots, msg,
      h('div', { class: 'pin-pad' }, keys.map((k) => h('button', { class: 'pin-key' + (k.length > 1 ? ' fn' : ''), onclick: () => press(k) }, k === 'back' ? '⌫' : k === 'clear' ? 'Clear' : k))))));
}

async function enter() {
  await loadMenu();
  if (!S.menu) return renderLogin('Could not load the menu. Check the connection and try again.');
  restoreCart();
  renderPos();
  startLive();
  Printer.onChange(renderPrinterButton);
  Printer.autoConnect();
}

// ---------- main screen ----------
function renderPos() {
  put(app, h('div', { class: 'pos' },
    h('header', { class: 'topbar' }),
    h('main', { class: 'menu-pane' }, h('nav', { class: 'tabs' }), h('div', { class: 'menu' })),
    h('aside', { class: 'cart' })));
  renderHeader(); renderMenu(); renderCart();
}

function renderHeader() {
  put(document.querySelector('.topbar'), 
    h('div', { class: 'brand' }, h('span', { class: 'diya-sm' }, '🪔'), h('strong', {}, S.menu.settings.event_name)),
    h('div', { class: 'status' + (S.online ? '' : ' off') }, h('i'), S.online ? 'Connected' : 'Offline'),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn small preorder-btn', onclick: preorderDialog }, 'Pre-order'),
    h('button', { class: 'btn small', onclick: refundDialog }, 'Refund'),
    h('button', { class: 'btn small', onclick: recentDialog }, 'Recent orders'),
    h('button', { class: 'btn small printer-btn', onclick: printerDialog }),
    h('div', { class: 'who' }, S.cashier.name),
    h('button', { class: 'btn small', onclick: logout }, 'Lock'));
  renderPrinterButton();
}

// The header button doubles as the printer status light.
function renderPrinterButton() {
  const btn = document.querySelector('.printer-btn');
  if (!btn) return;
  const usb = Printer.mode() === 'usb';
  const ready = usb && !!Printer.usbStatus();
  btn.classList.toggle('need', usb && !ready);
  put(btn, usb ? h('i', { class: ready ? 'ok' : '' }) : null, usb ? (ready ? 'Printer ready' : 'Connect printer') : 'Printer: dialog');
}

function renderMenu() {
  const tabs = document.querySelector('.tabs');
  const stalls = S.menu.stalls;
  put(tabs, 
    h('button', { class: 'tab' + (S.stall === 'all' ? ' on' : ''), onclick: () => { S.stall = 'all'; renderMenu(); } }, 'All stalls'),
    stalls.map((st) => h('button', { class: 'tab' + (S.stall === st.id ? ' on' : ''), style: { '--c': st.color }, onclick: () => { S.stall = st.id; renderMenu(); } },
      h('i', { style: { background: st.color } }), st.name)));

  const shown = S.stall === 'all' ? stalls : stalls.filter((s) => s.id === S.stall);
  const menu = document.querySelector('.menu');
  if (!stalls.length) return put(menu, h('p', { class: 'empty' }, 'No stalls are open yet. Add them in the admin.'));
  put(menu, shown.map((st) => h('section', { class: 'stall', style: { '--c': st.color } },
    h('h2', {}, st.name),
    st.items.length ? h('div', { class: 'grid' }, st.items.map((it) => {
      const n = qtyOf(it.id);
      return h('button', { class: 'item' + (it.available ? '' : ' out') + (n ? ' picked' : ''), disabled: !it.available, onclick: () => setQty(it.id, n + 1) },
        h('span', { class: 'item-name' }, it.name),
        h('span', { class: 'item-price num' }, it.available ? money(it.price_cents) : 'Sold out'),
        n ? h('span', { class: 'badge num' }, n) : null);
    })) : h('p', { class: 'empty' }, 'No items in this stall yet.'))));
}

function tenderOptions(total) {
  const out = new Set();
  for (const d of [1, 5, 10, 20, 50, 100]) { const v = Math.ceil(total / (d * 100)) * d * 100; if (v > total) out.add(v); }
  return [...out].sort((a, b) => a - b).slice(0, 4);
}

function renderCart() {
  const el = document.querySelector('.cart');
  if (!el) return;
  const total = cartTotal();
  const count = cartCount();
  const blocked = cartBlocked();

  const lines = S.cart.map((l) => {
    const it = S.items.get(l.item_id);
    const ok = sellable(it);
    return h('div', { class: 'line' + (ok ? '' : ' gone') },
      h('i', { class: 'line-dot', style: { background: it ? it.color : '#999' } }),
      h('div', { class: 'line-info' },
        h('div', { class: 'line-name' }, it ? it.name : 'Removed item'),
        h('div', { class: 'line-sub num' }, ok ? `${it.stall_name} · ${money(it.price_cents)} each` : 'No longer available. Remove it to continue.')),
      h('div', { class: 'stepper' },
        h('button', { 'aria-label': 'One less', disabled: !ok, onclick: () => setQty(l.item_id, l.qty - 1) }, '−'),
        h('span', { class: 'num' }, l.qty),
        h('button', { 'aria-label': 'One more', disabled: !ok, onclick: () => setQty(l.item_id, l.qty + 1) }, '+')),
      h('div', { class: 'line-total num' }, ok ? money(it.price_cents * l.qty) : '—'),
      h('button', { class: 'line-x', 'aria-label': 'Remove', title: 'Remove', onclick: () => setQty(l.item_id, 0) }, '×'));
  });

  let body;
  if (lines.length) body = lines;
  else if (S.last) {
    const o = S.last.order;
    const guest = o.kind === 'guest';
    body = h('div', { class: 'done' + (guest ? ' guest' : '') },
      h('div', { class: 'done-tick' }, '✓'),
      h('div', { class: 'done-title' }, guest ? `Guest service #${o.id} saved` : `Order #${o.id} saved`),
      o.preorder_code ? h('div', { class: 'done-sub' }, `From phone pre-order ${o.preorder_code}`) : null,
      h('div', { class: 'done-sub num' }, guest ? `${o.item_count} ticket${o.item_count === 1 ? '' : 's'} · no charge` : `${money(o.total_cents)} · ${o.item_count} ticket${o.item_count === 1 ? '' : 's'}`),
      S.last.change != null && h('div', { class: 'done-change num' }, 'Change due ', h('strong', {}, money(S.last.change))),
      h('button', { class: 'btn', onclick: () => Printer.print(o, S.menu.settings, true) }, 'Print tickets again'));
  } else body = h('p', { class: 'empty' }, 'Tap items to start an order.');

  const custom = h('input', {
    class: 'input num', inputMode: 'decimal', placeholder: 'Other $', 'aria-label': 'Other amount received',
    value: S.tendered != null && !tenderOptions(total).includes(S.tendered) && S.tendered !== total ? (S.tendered / 100).toFixed(2) : '',
    onchange: (e) => {
      const v = Math.round(parseFloat(e.target.value) * 100);
      if (!e.target.value.trim()) S.tendered = null;
      else if (!Number.isFinite(v) || v < total) { toast('Cash received is less than the total', 'error'); S.tendered = null; } else S.tendered = v;
      renderCart();
    },
  });
  const chip = (label, v) => h('button', { class: 'chip num' + (S.tendered === v ? ' on' : ''), onclick: () => { S.tendered = S.tendered === v ? null : v; renderCart(); } }, label);

  put(el, 
    h('div', { class: 'cart-head' }, h('h2', {}, 'Current order'),
      S.preorder ? h('span', { class: 'pre-tag num' }, `Pre-order ${S.preorder.code}`) : null,
      count ? h('button', { class: 'btn small danger', onclick: () => { releasePreorder(); clearCart(); renderMenu(); renderCart(); } }, 'Clear all') : null),
    S.preorder && count && total !== S.preorder.total_cents ? h('div', { class: 'pre-note num' }, `The phone showed ${money(S.preorder.total_cents)}. Charge the total below.`) : null,
    h('div', { class: 'lines' }, body),
    h('div', { class: 'cart-foot' },
      h('div', { class: 'total-row' }, h('span', {}, `Total · ${count} item${count === 1 ? '' : 's'}`), h('strong', { class: 'num' }, money(total))),
      count ? h('div', { class: 'tender' },
        h('span', { class: 'tender-label' }, 'Cash received'),
        h('div', { class: 'chips' }, chip('Exact', total), tenderOptions(total).map((v) => chip(money(v).replace('.00', ''), v)), custom)) : null,
      // Always shown once there is an order, so the buttons above never shift when a bill is tapped.
      count ? h('div', { class: 'change-row' + (S.tendered != null ? ' on' : '') }, h('span', {}, 'Change due'), h('strong', { class: 'num' }, S.tendered != null ? money(S.tendered - total) : '–')) : null,
      h('button', { class: 'settle', disabled: !count || blocked || S.busy, onclick: settle },
        S.busy ? 'Saving…' : blocked ? 'Remove unavailable items' : count ? `Cash collected · Print ${count} ticket${count === 1 ? '' : 's'}` : 'Cash collected'),
      count ? h('button', { class: 'btn guest-btn', disabled: blocked || S.busy, onclick: guestDialog }, 'Guest service (volunteer, no charge)') : null));
}

async function settle() {
  if (S.busy || !S.cart.length || cartBlocked()) return;
  const total = cartTotal();
  S.busy = true; renderCart();
  try {
    const { order } = await api('POST', '/api/orders', {
      client_ref: S.ref,
      lines: S.cart.map((l) => ({ item_id: l.item_id, qty: l.qty })),
      expected_total_cents: total,
      cash_tendered_cents: S.tendered,
      preorder_id: S.preorder ? S.preorder.id : undefined,
    });
    setOnline(true);
    S.last = { order, change: S.tendered != null ? S.tendered - order.total_cents : null };
    clearCart();
    S.busy = false;
    renderMenu(); renderCart();
    await Printer.print(order, S.menu.settings, false);
  } catch (e) {
    S.busy = false;
    if (e.status === 401) return signedOut();
    if (e.code === 'PREORDER_PAID' || e.code === 'PREORDER_NOT_FOUND') {
      clearCart();
      dialog('Do not take cash', h('p', { class: 'big-warn' }, e.message), []);
    } else if (e.code === 'PRICE_CHANGED' || e.code === 'ITEM_UNAVAILABLE') {
      S.menu.version = -1; // force a refresh
      await loadMenu();
      S.tendered = null;
      toast(e.code === 'PRICE_CHANGED' ? `Prices were updated. New total is ${money(cartTotal())}.` : 'An item just sold out. Remove it to continue.', 'error');
    } else {
      // The order reference stays the same, so pressing the button again is safe.
      if (e.status === 0) setOnline(false);
      toast(e.message + ' Nothing was lost. Press the button again.', 'error');
    }
    renderMenu(); renderCart();
  }
}

// ---------- phone pre-orders ----------
// The customer shows a 4-digit code from their phone. Typing it loads their
// items into the normal cart; then it is a normal sale (or Guest service).
function preorderDialog() {
  if (S.busy) return;
  const input = h('input', { class: 'input pre-input num', inputMode: 'numeric', maxLength: 5, placeholder: '4-digit code', autocomplete: 'off', 'aria-label': 'Pre-order code' });
  const out = h('div', { class: 'pre-out' });
  let busy = false;
  const ago = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? 'just now' : `${m} min ago`; };

  async function look(takeOver) {
    const code = input.value.replace(/\D/g, '');
    if (code.length < 4) { put(out, h('div', { class: 'refund-msg' }, 'Type the 4 digits from the customer’s phone.')); return; }
    if (busy) return;
    busy = true; put(out, h('p', { class: 'muted' }, 'Looking up…'));
    let r;
    try { r = await api('POST', '/api/preorders/claim', { code, take_over: !!takeOver }); } catch (e) {
      busy = false;
      if (e.status === 401) { close(); return signedOut(); }
      put(out, h('div', { class: 'refund-msg' }, e.message)); return;
    }
    busy = false;
    if (r.status === 'ok') return load(r.preorder);
    const msg = {
      not_found: [`No pre-order with code ${code}.`, 'Check the code on their phone, or ring the order up by hand.'],
      paid: [`Already paid. Order #${r.order_id} by ${r.paid_by}${r.paid_at ? ` at ${timeOf(r.paid_at)}` : ''}.`, 'Do not take cash again. If they lost their tickets, use Recent orders or ask the admin.'],
      expired: [`Code ${code} has expired.`, 'Ring the order up by hand.'],
      cancelled: [`The customer cancelled code ${code} on their phone.`, 'Ask them for their new code, or ring the order up by hand.'],
      claimed: [`${r.claimed_by} opened this pre-order ${ago(r.claimed_at)}.`, 'If that cashier is not serving this customer, take it over.'],
    }[r.status] || ['Something is wrong with this code.', ''];
    put(out, h('div', { class: 'pre-problem' + (r.status === 'paid' ? ' stop' : '') }, h('strong', {}, msg[0]), h('br'), h('span', {}, msg[1])),
      r.status === 'claimed' ? h('button', { class: 'btn', onclick: () => look(true) }, 'Take it over') : null);
    input.select();
  }

  function load(p) {
    // Release whatever pre-order was on screen before, then use this one.
    if (S.preorder && S.preorder.id !== p.id) releasePreorder();
    S.cart = p.lines.map((l) => ({ item_id: l.item_id, qty: l.qty }));
    S.ref = newRef();
    S.tendered = null;
    S.last = null;
    S.preorder = { id: p.id, code: p.code, total_cents: p.total_cents };
    saveCart();
    close();
    renderMenu(); renderCart();
    const missing = p.lines.filter((l) => !sellable(S.items.get(l.item_id)));
    toast(missing.length ? `Pre-order ${p.code} loaded. ${missing.length} item(s) sold out since: remove them.` : `Pre-order ${p.code} loaded. Take ${money(cartTotal())}.`, missing.length ? 'error' : 'ok');
  }

  const close = dialog('Pre-order from a phone', h('form', { class: 'pre', onsubmit: (e) => { e.preventDefault(); look(false); } },
    h('p', { class: 'muted' }, 'Type the code on the customer’s phone. Their items load into the order so you can take the cash.'),
    S.cart.length ? h('p', { class: 'pre-warn' }, 'This replaces the items in the current order.') : null,
    h('div', { class: 'pre-row' }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Load')),
    out), [], { sticky: true });
  setTimeout(() => input.focus(), 0);
}

// ---------- Guest service ----------
// A volunteer orders free food for guests. The cashier types the volunteer's
// phone number; if it is on the list the tickets print and no cash is taken.
function guestDialog() {
  if (S.busy || !S.cart.length || cartBlocked()) return;
  const count = cartCount();
  let state = 'ask';   // ask -> checking -> found | missing
  let phone = '';
  const input = h('input', { class: 'input guest-phone num', type: 'tel', inputMode: 'tel', placeholder: 'Volunteer phone number', autocomplete: 'off', 'aria-label': 'Volunteer phone number' });
  const out = h('div', { class: 'guest-out' });
  const digits = (v) => v.replace(/\D/g, '');
  input.addEventListener('input', () => { if (state !== 'ask') { state = 'ask'; paint(); } });

  async function check() {
    phone = input.value;
    if (digits(phone).length < 10) { state = 'ask'; paint('Type all 10 digits of the phone number.'); return; }
    state = 'checking'; paint();
    try {
      const r = await api('POST', '/api/guest/check', { phone });
      state = r.found ? 'found' : 'missing';
    } catch (e) {
      if (e.status === 401) { close(); return signedOut(); }
      state = 'ask'; paint(e.message); return;
    }
    paint();
  }

  async function go() {
    if (S.busy) return;
    S.busy = true; paint(); renderCart();
    try {
      const { order } = await api('POST', '/api/orders', {
        client_ref: S.ref,
        lines: S.cart.map((l) => ({ item_id: l.item_id, qty: l.qty })),
        expected_total_cents: cartTotal(),
        guest_phone: phone,
        preorder_id: S.preorder ? S.preorder.id : undefined,
      });
      setOnline(true);
      S.last = { order, change: null };
      clearCart();
      S.busy = false;
      close();
      renderMenu(); renderCart();
      await Printer.print(order, S.menu.settings, false);
    } catch (e) {
      S.busy = false;
      renderCart();
      if (e.status === 401) { close(); return signedOut(); }
      if (e.code === 'VOLUNTEER_NOT_FOUND') { state = 'missing'; paint(); return; }
      if (e.code === 'PREORDER_PAID' || e.code === 'PREORDER_NOT_FOUND') { close(); clearCart(); renderMenu(); renderCart(); dialog('Already done', h('p', { class: 'big-warn' }, e.message), []); return; }
      if (e.code === 'ITEM_UNAVAILABLE') {
        close();
        S.menu.version = -1; await loadMenu();
        toast('An item just sold out. Remove it to continue.', 'error');
        renderMenu(); renderCart();
        return;
      }
      if (e.status === 0) setOnline(false);
      paint(e.message + ' Nothing was lost. Press the button again.');
    }
  }

  function paint(problem) {
    input.disabled = S.busy;
    if (state === 'found') {
      put(out,
        h('div', { class: 'guest-found' }, h('span', { class: 'guest-tick' }, '✓'), 'Volunteer found'),
        h('button', { class: 'settle guest-go', disabled: S.busy, onclick: go }, S.busy ? 'Saving…' : `Print ${count} ticket${count === 1 ? '' : 's'} · no charge`),
        problem ? h('div', { class: 'refund-msg' }, problem) : null);
    } else if (state === 'missing') {
      put(out, h('div', { class: 'guest-missing' }, 'This number is not on the volunteer list.', h('br'), h('span', {}, 'Check the number, or charge it as a normal cash order.')));
    } else {
      put(out,
        problem ? h('div', { class: 'refund-msg' }, problem) : null,
        h('button', { class: 'btn primary guest-check', disabled: state === 'checking', onclick: check }, state === 'checking' ? 'Checking…' : 'Check number'));
    }
  }

  const close = dialog('Guest service', h('form', { class: 'guest', onsubmit: (e) => { e.preventDefault(); if (state === 'found') go(); else if (state !== 'checking') check(); } },
    h('p', { class: 'muted' }, `For volunteers ordering for guests. ${count} ticket${count === 1 ? '' : 's'} will print and no cash is collected.`),
    input, out), [], { sticky: true });
  paint();
  setTimeout(() => input.focus(), 0);
}

async function logout() {
  if (S.cart.length && !confirm('There is an order in progress. Lock the screen and discard it?')) return;
  releasePreorder();
  try { await api('POST', '/api/logout'); } catch (e) { /* signing out locally is enough */ }
  S.cart = []; S.ref = null; S.last = null; S.preorder = null; localStorage.removeItem('pos_cart');
  signedOut();
}

// ---------- dialogs ----------
async function recentDialog() {
  let orders = [];
  try { orders = (await api('GET', '/api/orders/recent')).orders; } catch (e) { return toast(e.message, 'error'); }
  dialog('Your recent orders', orders.length ? h('div', { class: 'recent' }, orders.map((o) =>
    h('div', { class: 'recent-row' + (o.voided_at ? ' void' : '') },
      h('div', {},
        h('strong', { class: 'num' }, o.kind === 'guest' ? `#${o.id} · Guest service` : `#${o.id} · ${money(o.total_cents)}`), ' ',
        o.preorder_code ? h('span', { class: 'pre-tag small num' }, `Pre-order ${o.preorder_code}`) : null, ' ', h('span', { class: 'muted' }, timeOf(o.created_at) + (o.voided_at ? ' · VOIDED' : '')),
        h('div', { class: 'muted' }, o.lines.map((l) => `${l.qty}× ${l.item_name}`).join(', ')),
        o.refunds.length ? h('div', { class: 'refund-note' }, `Refunded: ${o.refunds.map((r) => `${o.id}-${r.ticket_no} ${r.item_name}`).join(', ')}`) : null),
      // Reprints leave out refunded tickets, so they can't be used again.
      !o.voided_at && o.refunds.length < o.item_count && h('button', { class: 'btn small', onclick: () => Printer.print(o, S.menu.settings, true) }, 'Reprint')))) : h('p', { class: 'muted' }, 'No orders yet.'));
}

// ---------- refunds ----------
// The customer hands back unused tickets. The cashier types each ticket code
// (e.g. 422-2), checks the list, gives the cash back and keeps the tickets.
function refundDialog() {
  const list = [];          // tickets looked up so far, in the order they were typed
  let ref = newRef();       // same reference on a retry, so a refund is never paid twice
  let busy = false;
  let done = null;          // result after a successful refund

  const input = h('input', { class: 'input refund-input num', placeholder: 'Ticket code, e.g. 422-2', autocomplete: 'off', inputMode: 'text', 'aria-label': 'Ticket code' });
  const msg = h('div', { class: 'refund-msg' });
  const listEl = h('div', { class: 'refund-list' });
  const foot = h('div', { class: 'refund-foot' });
  const body = h('div', { class: 'refund' },
    h('p', { class: 'muted' }, 'Type the code from each unused ticket and press Enter. Keep the paper tickets after refunding.'),
    h('form', { class: 'refund-add', onsubmit: (e) => { e.preventDefault(); add(); } }, input, h('button', { class: 'btn', type: 'submit' }, 'Add')),
    msg, listEl, foot);

  const okTickets = () => list.filter((t) => t.status === 'ok');
  const statusText = (t) => ({
    refunded: `Already refunded${t.refunded_by ? ` by ${t.refunded_by}` : ''}${t.refunded_at ? ` at ${timeOf(t.refunded_at)}` : ''}`,
    voided: 'This order was cancelled. No refund.',
    guest: 'Guest service ticket. Nothing was paid, so no refund.',
    not_found: 'No such ticket. Check the code.',
  }[t.status] || '');

  function paint() {
    if (done) {
      put(listEl);
      put(foot, h('div', { class: 'refund-done' },
        h('div', { class: 'done-tick' }, '✓'),
        h('div', { class: 'refund-done-title' }, 'Give back ', h('strong', { class: 'num' }, money(done.total_cents))),
        h('div', { class: 'muted' }, `${done.refunds.length} ticket${done.refunds.length === 1 ? '' : 's'} refunded: ${done.refunds.map((r) => `${r.order_id}-${r.ticket_no}`).join(', ')}`),
        h('div', { class: 'muted' }, 'Keep the paper tickets in the refund envelope.'),
        h('button', { class: 'btn', onclick: () => { done = null; list.length = 0; ref = newRef(); msg.textContent = ''; paint(); input.focus(); } }, 'Refund more tickets')));
      input.disabled = true;
      return;
    }
    input.disabled = false;
    put(listEl, list.length ? list.map((t, i) =>
      h('div', { class: 'refund-row' + (t.status === 'ok' ? '' : ' bad') },
        h('div', { class: 'refund-code num' }, t.code),
        h('div', { class: 'refund-info' },
          h('div', { class: 'line-name' }, t.item_name || '—'),
          h('div', { class: 'line-sub' }, t.status === 'ok' ? `${t.stall_name} · sold ${timeOf(t.sold_at)} by ${t.sold_by}` : statusText(t))),
        h('div', { class: 'line-total num' }, t.status === 'ok' ? money(t.amount_cents) : '—'),
        h('button', { class: 'line-x', 'aria-label': 'Remove', title: 'Remove', onclick: () => { list.splice(i, 1); ref = newRef(); paint(); input.focus(); } }, '×')))
      : h('p', { class: 'empty' }, 'No tickets added yet.'));
    const ok = okTickets();
    const total = ok.reduce((s, t) => s + t.amount_cents, 0);
    put(foot,
      h('div', { class: 'total-row' }, h('span', {}, `To give back · ${ok.length} ticket${ok.length === 1 ? '' : 's'}`), h('strong', { class: 'num' }, money(total))),
      list.length > ok.length ? h('div', { class: 'muted small' }, 'Tickets marked in red are not included.') : null,
      h('button', { class: 'settle refund-go', disabled: !ok.length || busy, onclick: submit },
        busy ? 'Saving…' : ok.length ? `Refund ${ok.length} ticket${ok.length === 1 ? '' : 's'} · give back ${money(total)}` : 'Refund'));
  }

  async function add() {
    const code = input.value.trim();
    if (!code) return;
    msg.textContent = '';
    try {
      const { ticket } = await api('GET', '/api/tickets/' + encodeURIComponent(code));
      if (list.some((t) => t.code === ticket.code)) { msg.textContent = `${ticket.code} is already in the list.`; input.select(); return; }
      list.push(ticket);
      ref = newRef();
      input.value = '';
      paint();
    } catch (e) {
      if (e.status === 401) return signedOut();
      msg.textContent = e.message;
      input.select();
    }
    input.focus();
  }

  async function submit() {
    const ok = okTickets();
    if (!ok.length || busy) return;
    busy = true; paint();
    try {
      done = await api('POST', '/api/refunds', { batch_ref: ref, tickets: ok.map((t) => ({ order_id: t.order_id, ticket_no: t.ticket_no })) });
      busy = false;
      toast(`Refund saved. Give back ${money(done.total_cents)}.`, 'ok');
    } catch (e) {
      busy = false;
      if (e.status === 401) return signedOut();
      if (e.code === 'TICKET_PROBLEM') {
        // Someone refunded one of these a moment ago: show which, refund nothing.
        for (const p of e.body.tickets || []) { const t = list.find((x) => x.code === p.code); if (t) Object.assign(t, p); }
        ref = newRef();
        msg.textContent = 'Nothing was refunded. Remove the tickets marked in red and try again.';
      } else {
        msg.textContent = e.message + ' Nothing was lost. Press the button again.';
      }
    }
    paint();
  }

  paint();
  dialog('Refund tickets', body, [], { sticky: true, wide: true });
  setTimeout(() => input.focus(), 0);
}

function printerDialog() {
  const status = h('p', { class: 'printer-status' });
  const details = h('pre', { class: 'printer-details' });
  const say = (text, kind) => { status.textContent = text; status.className = 'printer-status ' + (kind || ''); };
  const paint = () => say(Printer.mode() === 'usb'
    ? (Printer.usbStatus() ? `Connected: ${Printer.usbStatus()}` : 'No receipt printer connected yet. Plug it in and press Connect USB printer.')
    : 'Tickets open in the browser print dialog.', Printer.mode() === 'usb' && Printer.usbStatus() ? 'ok' : '');
  const refresh = async () => { details.textContent = await Printer.diagnostics(S.menu.settings); };
  const syncRadios = () => document.querySelectorAll('input[name=pm]').forEach((r, i) => { r.checked = (i === 0) === (Printer.mode() === 'usb'); });
  const radio = (value, label, note) => h('label', { class: 'radio' },
    h('input', { type: 'radio', name: 'pm', checked: Printer.mode() === value, disabled: value === 'usb' && !Printer.usbSupported(), onchange: () => { Printer.setMode(value); paint(); refresh(); } }),
    h('span', {}, h('strong', {}, label), h('br'), h('span', { class: 'muted' }, note)));
  const sample = () => ({ id: 0, created_at: Date.now(), cashier_name: S.cashier.name, lines: [{ stall_name: 'Test Stall', item_name: 'Test Ticket', unit_price_cents: 0, qty: 2 }] });

  const connect = async () => {
    try { const name = await Printer.connectUsb(); Printer.setMode('usb'); syncRadios(); say(`Connected: ${name}`, 'ok'); } catch (e) { say(Printer.explain(e), 'bad'); }
    refresh();
  };
  // In USB mode the test never falls back to the dialog, so a failure shows its real cause.
  const test = async () => {
    if (Printer.mode() !== 'usb') { Printer.print(sample(), S.menu.settings, false); return; }
    try {
      const bytes = await Printer.printUsbOnly(sample(), S.menu.settings);
      say(`Sent 2 test tickets (${bytes} bytes). You should have two separate tickets. If they came out as one strip, change the cut command below and test again.`, 'ok');
    } catch (e) { say(Printer.explain(), 'bad'); }
    refresh();
  };
  const cutSelect = h('select', { class: 'input', onchange: (e) => { Printer.setCut(e.target.value); refresh(); } },
    Object.entries(Printer.CUTS).map(([k, c]) => h('option', { value: k, selected: Printer.cut() === k }, c.label)));
  const copy = async () => {
    await refresh();
    try { await navigator.clipboard.writeText(details.textContent); toast('Details copied', 'ok'); } catch (e) { toast('Select the text and copy it by hand', 'error'); }
  };

  paint(); refresh();
  dialog('Printer', h('div', { class: 'printer' },
    radio('usb', 'Direct USB receipt printer (default)', Printer.usbSupported() ? 'Tickets go straight to the receipt printer with a cut after each one. No print dialog and no driver needed.' : 'Not available here. Needs Chrome or Edge, on the https site or localhost.'),
    radio('browser', 'Browser print dialog', 'Works with any printer set up on this Mac.'),
    status,
    h('details', { class: 'trouble' }, h('summary', {}, 'Troubleshooting'),
      h('label', { class: 'field' }, 'Cut command (direct USB only)', cutSelect),
      h('p', { class: 'muted' }, 'If something is not working, press Copy details and send the text to whoever is helping.'),
      details,
      h('button', { class: 'btn small', onclick: copy }, 'Copy details'))),
  [
    { label: 'Connect USB printer', onclick: connect },
    { label: 'Print a test ticket', class: 'primary', onclick: test },
  ]);
}

// ---------- start ----------
(async function boot() {
  try {
    S.cashier = (await api('GET', '/api/me')).cashier;
    await enter();
  } catch (e) {
    renderLogin(e.status === 0 ? e.message : '');
  }
})();
