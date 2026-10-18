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
  busy: false,
  last: null,          // { order, change } of the order just settled
  online: true,
};
let stream = null;
let pollTimer = null;

const newRef = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));

// ---------- cart ----------
function saveCart() { localStorage.setItem('pos_cart', JSON.stringify({ cashier: S.cashier && S.cashier.id, cart: S.cart, ref: S.ref })); }
function restoreCart() {
  try {
    const c = JSON.parse(localStorage.getItem('pos_cart') || 'null');
    if (c && S.cashier && c.cashier === S.cashier.id && Array.isArray(c.cart)) { S.cart = c.cart; S.ref = c.ref; }
  } catch (e) { /* ignore a corrupt saved cart */ }
  if (!S.ref) S.ref = newRef();
}
function clearCart() { S.cart = []; S.ref = newRef(); S.tendered = null; saveCart(); }
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
    body = h('div', { class: 'done' },
      h('div', { class: 'done-tick' }, '✓'),
      h('div', { class: 'done-title' }, `Order #${o.id} saved`),
      h('div', { class: 'done-sub num' }, `${money(o.total_cents)} · ${o.item_count} ticket${o.item_count === 1 ? '' : 's'}`),
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
      count ? h('button', { class: 'btn small danger', onclick: () => { clearCart(); renderMenu(); renderCart(); } }, 'Clear all') : null),
    h('div', { class: 'lines' }, body),
    h('div', { class: 'cart-foot' },
      h('div', { class: 'total-row' }, h('span', {}, `Total · ${count} item${count === 1 ? '' : 's'}`), h('strong', { class: 'num' }, money(total))),
      count ? h('div', { class: 'tender' },
        h('span', { class: 'tender-label' }, 'Cash received'),
        h('div', { class: 'chips' }, chip('Exact', total), tenderOptions(total).map((v) => chip(money(v).replace('.00', ''), v)), custom)) : null,
      // Always shown once there is an order, so the buttons above never shift when a bill is tapped.
      count ? h('div', { class: 'change-row' + (S.tendered != null ? ' on' : '') }, h('span', {}, 'Change due'), h('strong', { class: 'num' }, S.tendered != null ? money(S.tendered - total) : '–')) : null,
      h('button', { class: 'settle', disabled: !count || blocked || S.busy, onclick: settle },
        S.busy ? 'Saving…' : blocked ? 'Remove unavailable items' : count ? `Cash collected · Print ${count} ticket${count === 1 ? '' : 's'}` : 'Cash collected')));
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
    if (e.code === 'PRICE_CHANGED' || e.code === 'ITEM_UNAVAILABLE') {
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

async function logout() {
  if (S.cart.length && !confirm('There is an order in progress. Lock the screen and discard it?')) return;
  try { await api('POST', '/api/logout'); } catch (e) { /* signing out locally is enough */ }
  S.cart = []; S.ref = null; S.last = null; localStorage.removeItem('pos_cart');
  signedOut();
}

// ---------- dialogs ----------
async function recentDialog() {
  let orders = [];
  try { orders = (await api('GET', '/api/orders/recent')).orders; } catch (e) { return toast(e.message, 'error'); }
  dialog('Your recent orders', orders.length ? h('div', { class: 'recent' }, orders.map((o) =>
    h('div', { class: 'recent-row' + (o.voided_at ? ' void' : '') },
      h('div', {},
        h('strong', { class: 'num' }, `#${o.id} · ${money(o.total_cents)}`), ' ', h('span', { class: 'muted' }, timeOf(o.created_at) + (o.voided_at ? ' · VOIDED' : '')),
        h('div', { class: 'muted' }, o.lines.map((l) => `${l.qty}× ${l.item_name}`).join(', '))),
      !o.voided_at && h('button', { class: 'btn small', onclick: () => Printer.print(o, S.menu.settings, true) }, 'Reprint')))) : h('p', { class: 'muted' }, 'No orders yet.'));
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
