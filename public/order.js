'use strict';
// Phone order page. Customers pick food here, get a 4-digit code, then show
// the code at any cashier and pay cash. Nothing is a sale until they pay.

const app = document.getElementById('app');
const O = {
  menu: null,       // { event_name, open, stalls:[{id,name,color,items:[{id,name,price_cents}]}] }
  items: new Map(), // item id -> item with stall name
  cart: [],         // [{ item_id, qty }]
  ref: null,        // makes a double tap on Submit create one pre-order, not two
  view: 'menu',     // menu | review | code
  pending: null,    // the submitted pre-order: { code, ref, total_cents, item_count, lines, expires_at, status, order_id }
  busy: false,
};
let pollTimer = null;

const newRef = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: keep it in memory */ } },
};
const saveCart = () => store.set('po_cart', { cart: O.cart, ref: O.ref });
const qtyOf = (id) => (O.cart.find((l) => l.item_id === id) || { qty: 0 }).qty;
const cartCount = () => O.cart.reduce((s, l) => s + l.qty, 0);
const cartTotal = () => O.cart.reduce((s, l) => s + (O.items.has(l.item_id) ? O.items.get(l.item_id).price_cents * l.qty : 0), 0);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function setQty(id, qty) {
  const line = O.cart.find((l) => l.item_id === id);
  if (qty <= 0) O.cart = O.cart.filter((l) => l.item_id !== id);
  else if (line) line.qty = Math.min(qty, 30);
  else O.cart.push({ item_id: id, qty: 1 });
  O.ref = newRef(); // the cart changed, so a submit is a new pre-order
  saveCart();
  render();
}

// ---------- data ----------
async function loadMenu() {
  const m = await api('GET', '/api/public/menu');
  O.menu = m;
  O.items = new Map();
  for (const s of m.stalls) for (const it of s.items) O.items.set(it.id, { ...it, stall: s.name, color: s.color });
  document.title = m.event_name + ' · Order';
  // drop anything that sold out since it was added
  const gone = O.cart.filter((l) => !O.items.has(l.item_id));
  if (gone.length) {
    O.cart = O.cart.filter((l) => O.items.has(l.item_id));
    saveCart();
    toast(`${plural(gone.length, 'item')} sold out and ${gone.length === 1 ? 'was' : 'were'} removed from your order`, 'error');
  }
}

async function checkPending() {
  const p = O.pending;
  if (!p || p.status === 'paid') return;
  try {
    const { preorder } = await api('GET', `/api/public/preorders/${p.code}?ref=${encodeURIComponent(p.ref)}`);
    const before = p.status;
    Object.assign(p, { status: preorder.status, order_id: preorder.order_id });
    store.set('po_pending', p);
    if (before !== p.status && O.view === 'code') render();
  } catch (e) {
    if (e.status === 404) { p.status = 'expired'; store.set('po_pending', p); if (O.view === 'code') render(); }
  }
}
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) checkPending(); }, 10000);
}

// ---------- views ----------
function render() {
  if (O.view !== O.shown) { window.scrollTo(0, 0); O.shown = O.view; } // new screen starts at the top
  if (!O.menu) return put(app, h('div', { class: 'center' }, h('p', { class: 'muted' }, 'Loading the menu…')));
  if (O.view === 'code' && O.pending) return renderCode();
  if (O.view === 'review') return renderReview();
  renderMenu();
}

function header(sub) {
  return h('header', { class: 'head' }, h('div', { class: 'head-title' }, '🪔 ', O.menu.event_name), h('div', { class: 'head-sub' }, sub));
}

function stepper(it) {
  const n = qtyOf(it.id);
  if (!n) return h('button', { class: 'add', onclick: () => setQty(it.id, 1), 'aria-label': `Add ${it.name}` }, 'Add');
  return h('div', { class: 'step' },
    h('button', { 'aria-label': 'One less', onclick: () => setQty(it.id, n - 1) }, '−'),
    h('span', { class: 'num' }, n),
    h('button', { 'aria-label': 'One more', onclick: () => setQty(it.id, n + 1) }, '+'));
}

function renderMenu() {
  if (!O.menu.open) {
    return put(app, header(''), h('div', { class: 'closed' },
      h('h2', {}, 'Phone ordering is closed right now'),
      h('p', {}, 'Please order at any cashier.')));
  }
  if (!O.menu.stalls.length) return put(app, header(''), h('div', { class: 'closed' }, h('h2', {}, 'Nothing on the menu yet'), h('p', {}, 'Please check back in a few minutes.')));
  const count = cartCount();
  put(app,
    header('Order here, then pay cash at any cashier'),
    h('nav', { class: 'chips' }, O.menu.stalls.map((s) => h('a', { class: 'chip', href: `#stall-${s.id}` }, h('i', { style: { background: s.color } }), s.name))),
    h('main', { class: 'menu' + (count ? ' has-bar' : '') }, O.menu.stalls.map((s) => h('section', { class: 'stall', id: `stall-${s.id}`, style: { '--c': s.color } },
      h('h2', {}, s.name),
      s.items.map((it) => h('div', { class: 'row' + (qtyOf(it.id) ? ' picked' : '') },
        h('div', { class: 'row-info' }, h('div', { class: 'row-name' }, it.name), h('div', { class: 'row-price num' }, money(it.price_cents))),
        stepper(it)))))),
    count ? h('button', { class: 'bar', onclick: () => { O.view = 'review'; render(); } },
      h('span', {}, `View order · ${plural(count, 'item')}`), h('strong', { class: 'num' }, money(cartTotal()))) : null);
}

function renderReview() {
  const count = cartCount();
  if (!count) { O.view = 'menu'; return renderMenu(); }
  const total = cartTotal();
  put(app,
    header('Check your order'),
    h('main', { class: 'review' },
      h('button', { class: 'back', onclick: () => { O.view = 'menu'; render(); } }, '‹ Add more food'),
      h('div', { class: 'lines' }, O.cart.map((l) => {
        const it = O.items.get(l.item_id);
        return h('div', { class: 'line' },
          h('i', { class: 'dot', style: { background: it.color } }),
          h('div', { class: 'row-info' }, h('div', { class: 'row-name' }, it.name), h('div', { class: 'row-price num' }, `${it.stall} · ${money(it.price_cents)} each`)),
          stepper(it),
          h('div', { class: 'line-total num' }, money(it.price_cents * l.qty)));
      })),
      h('div', { class: 'total' }, h('span', {}, `Total · ${plural(count, 'item')}`), h('strong', { class: 'num' }, money(total))),
      h('p', { class: 'note' }, `You will get a 4-digit code. Show it at any cashier and pay ${money(total)} in cash. Your food tickets print there.`),
      h('button', { class: 'submit', disabled: O.busy, onclick: submit }, O.busy ? 'Sending…' : 'Submit order')));
}

function renderCode() {
  const p = O.pending;
  const paid = p.status === 'paid';
  const dead = p.status === 'expired' || p.status === 'cancelled';
  put(app,
    header(paid ? 'Paid. Enjoy your food!' : 'Show this code at any cashier'),
    h('main', { class: 'code-view' },
      h('div', { class: 'code-card' + (paid ? ' paid' : dead ? ' dead' : '') },
        h('div', { class: 'code-label' }, paid ? 'Paid' : dead ? 'This code has expired' : 'Your order code'),
        h('div', { class: 'code num' }, p.code),
        paid ? h('div', { class: 'code-pay' }, `Order #${p.order_id}. Your tickets were printed at the cashier.`)
          : dead ? h('div', { class: 'code-pay' }, 'Please start a new order, or order at a cashier.')
            : h('div', { class: 'code-pay' }, 'Pay ', h('strong', { class: 'num' }, money(p.total_cents)), ' cash')),
      paid ? null : h('div', { class: 'lines small-lines' }, p.lines.map((l) => h('div', { class: 'line' },
        h('div', { class: 'row-info' }, h('div', { class: 'row-name' }, `${l.qty}× ${l.name}`), h('div', { class: 'row-price' }, l.stall_name)),
        h('div', { class: 'line-total num' }, money(l.price_cents * l.qty))))),
      !paid && !dead ? h('p', { class: 'note' }, 'Keep this screen open or take a screenshot. Prices are checked again at the cashier.') : null,
      h('button', { class: paid || dead ? 'submit' : 'again', onclick: startOver }, 'Start a new order')));
}

// ---------- actions ----------
async function submit() {
  if (O.busy || !O.cart.length) return;
  O.busy = true; render();
  try {
    const { preorder } = await api('POST', '/api/public/preorders', {
      client_ref: O.ref,
      lines: O.cart.map((l) => ({ item_id: l.item_id, qty: l.qty })),
      expected_total_cents: cartTotal(),
    });
    O.pending = { ...preorder, ref: O.ref };
    store.set('po_pending', O.pending);
    O.cart = []; O.ref = newRef(); saveCart();
    O.view = 'code';
    startPolling();
  } catch (e) {
    if (e.code === 'PRICE_CHANGED' || e.code === 'ITEM_UNAVAILABLE') {
      await loadMenu().catch(() => {});
      O.ref = newRef(); saveCart();
      toast(e.code === 'PRICE_CHANGED' ? `Prices were updated. Your new total is ${money(cartTotal())}.` : e.message, 'error');
    } else if (e.code === 'PREORDERS_CLOSED') {
      await loadMenu().catch(() => {});
      toast(e.message, 'error');
    } else {
      toast(e.message, 'error');
    }
  }
  O.busy = false;
  render();
}

function startOver() {
  const p = O.pending;
  const reset = () => {
    O.pending = null; store.set('po_pending', null);
    clearInterval(pollTimer);
    O.view = 'menu'; render();
  };
  if (!p || p.status !== 'open') return reset();
  dialog('Start a new order?', h('p', {}, `Code ${p.code} will stop working. Only do this if you have not paid yet.`), [
    { label: 'Yes, start over', class: 'primary', onclick: async (close) => {
      close();
      try { await api('POST', `/api/public/preorders/${p.code}/cancel`, { ref: p.ref }); } catch (e) { /* the code expires on its own */ }
      reset();
    } },
  ]);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) checkPending(); });

// ---------- start ----------
(async function boot() {
  const saved = store.get('po_cart');
  if (saved && Array.isArray(saved.cart)) { O.cart = saved.cart; O.ref = saved.ref; }
  if (!O.ref) O.ref = newRef();
  O.pending = store.get('po_pending');
  if (O.pending && O.pending.status !== 'paid' && O.pending.expires_at < Date.now()) O.pending.status = 'expired';
  // A paid code from an earlier visit is old news: start fresh.
  if (O.pending && O.pending.status === 'paid' && Date.now() - (O.pending.created_at || 0) > 3 * 3600 * 1000) { O.pending = null; store.set('po_pending', null); }
  if (O.pending) O.view = 'code';
  render();
  for (let i = 0; ; i++) {
    try { await loadMenu(); break; } catch (e) {
      put(app, h('div', { class: 'center' }, h('p', {}, 'Could not reach the menu. Check your internet connection.'), h('p', { class: 'muted' }, 'Trying again…')));
      await new Promise((r) => setTimeout(r, Math.min(2000 + i * 1000, 8000)));
    }
  }
  render();
  if (O.pending) { checkPending(); startPolling(); }
})();
