'use strict';
// Admin: live dashboard, orders, menu, cashiers, settings.

const app = document.getElementById('app');
const PALETTE = ['#c2410c', '#b91c1c', '#a16207', '#15803d', '#0e7490', '#1d4ed8', '#6d28d9', '#be185d', '#475569'];
const A = {
  tab: location.hash.slice(1) || 'dashboard',
  catalog: null,
  range: 'today',
  itemSort: 'sales_cents',
  interval: localStorage.getItem('admin_interval') === '30' ? 30 : 15, // minutes per bar when looking at a single day
  orders: { range: 'today', cashier_id: '', search: '', kind: '', volunteer: null, offset: 0 },
  guests: { range: 'today' },
  live: false,
  defaultPassword: false,
};
let stream = null;
let refreshTimer = null;
let pollTimer = null;

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

// "Today" and date ranges use this browser's clock, so the dashboard matches the wall clock at the event.
function rangeMs(r) {
  if (r === 'all') return { from: 0, to: 8640000000000000, bucket: 60 };
  const d = r === 'today' ? new Date() : new Date(r + 'T00:00:00');
  d.setHours(0, 0, 0, 0);
  const next = new Date(d); next.setDate(next.getDate() + 1);
  return { from: d.getTime(), to: next.getTime(), bucket: 15 };
}
function rangePicker(value, onchange) {
  const isDate = value !== 'today' && value !== 'all';
  const date = h('input', { type: 'date', class: 'input', value: isDate ? value : '', 'aria-label': 'Pick a date', onchange: (e) => e.target.value && onchange(e.target.value) });
  return h('div', { class: 'range' },
    h('button', { class: 'seg' + (value === 'today' ? ' on' : ''), onclick: () => onchange('today') }, 'Today'),
    h('button', { class: 'seg' + (value === 'all' ? ' on' : ''), onclick: () => onchange('all') }, 'All time'),
    date);
}

async function call(method, url, body) {
  try { return await api(method, url, body); } catch (e) {
    if (e.status === 401) { stopLive(); renderLogin(); }
    throw e;
  }
}
const guard = (fn) => async (...args) => { try { return await fn(...args); } catch (e) { if (e.status !== 401) toast(e.message, 'error'); } };

// ---------- login ----------
function renderLogin() {
  const pw = h('input', { type: 'password', class: 'input', placeholder: 'Admin password', autofocus: true });
  const msg = h('div', { class: 'login-msg' });
  const submit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/admin/login', { password: pw.value }); start(); } catch (err) { msg.textContent = err.message; pw.select(); }
  };
  put(app, h('div', { class: 'login' }, h('form', { class: 'login-card', onsubmit: submit },
    h('h1', {}, 'Food Stall POS Admin'), pw, msg, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'),
    h('a', { href: '/', class: 'muted' }, 'Go to the cashier screen'))));
}

// ---------- shell ----------
const TABS = [['dashboard', 'Live dashboard'], ['orders', 'Orders'], ['menu', 'Menu'], ['cashiers', 'Cashiers'], ['guests', 'Guest service'], ['settings', 'Settings']];
function renderShell() {
  put(app, h('div', { class: 'admin' },
    h('header', { class: 'topbar' },
      h('strong', { class: 'brand' }, '🪔 ', A.catalog.settings.event_name, h('span', { class: 'tag' }, 'Admin')),
      h('nav', {}, TABS.map(([id, label]) => h('button', { class: 'navtab' + (A.tab === id ? ' on' : ''), onclick: () => go(id) }, label))),
      h('div', { class: 'spacer' }),
      h('a', { class: 'btn small', href: '/', target: '_blank' }, 'Cashier screen'),
      h('button', { class: 'btn small', onclick: async () => { await api('POST', '/api/admin/logout').catch(() => {}); stopLive(); renderLogin(); } }, 'Sign out')),
    A.defaultPassword ? h('div', { class: 'warn' }, 'This server is using the built-in development password. Set ADMIN_PASSWORD before hosting it.') : null,
    h('main', { id: 'view' })));
  renderTab();
}
function go(tab) { A.tab = tab; location.hash = tab; renderShell(); }
const view = () => document.getElementById('view');
function renderTab() {
  ({ dashboard: renderDashboard, orders: renderOrders, menu: renderMenu, cashiers: renderCashiers, guests: renderGuests, settings: renderSettings }[A.tab] || renderDashboard)();
}
async function loadCatalog() { A.catalog = await call('GET', '/api/admin/catalog'); }

// ---------- live ----------
function startLive() {
  stopLive();
  stream = new EventSource('/api/admin/events');
  const bump = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (A.tab === 'dashboard') refreshDashboard(); else if (A.tab === 'guests') refreshGuests(); }, 400); };
  stream.addEventListener('order', bump);
  stream.onopen = () => { A.live = true; paintLive(); bump(); };
  stream.onerror = () => { A.live = false; paintLive(); };
  pollTimer = setInterval(() => { if (A.tab === 'dashboard') refreshDashboard(); }, 15000);
}
function stopLive() { if (stream) stream.close(); stream = null; clearInterval(pollTimer); clearTimeout(refreshTimer); }
function paintLive() {
  const el = document.querySelector('.live');
  if (el) { el.classList.toggle('off', !A.live); el.lastChild.textContent = A.live ? 'Live' : 'Reconnecting…'; }
}

// ---------- dashboard ----------
function renderDashboard() {
  put(view(), 
    h('div', { class: 'bar' },
      h('h1', {}, 'Sales'),
      h('div', { class: 'live' + (A.live ? '' : ' off') }, h('i'), A.live ? 'Live' : 'Reconnecting…'),
      h('span', { class: 'muted', id: 'updated' }),
      h('div', { class: 'spacer' }),
      rangePicker(A.range, (r) => { A.range = r; renderDashboard(); })),
    h('div', { id: 'dash' }, h('p', { class: 'muted' }, 'Loading…')));
  refreshDashboard();
}

let dashSeq = 0;
async function refreshDashboard() {
  const seq = ++dashSeq;
  const r = rangeMs(A.range);
  let rep;
  try {
    const bucket = A.range === 'all' ? r.bucket : A.interval;
    rep = await call('GET', `/api/admin/report?from=${r.from}&to=${r.to}&bucket=${bucket}`);
    // "All time" across many days: switch from hourly to daily bars
    if (rep.timeline.length && (rep.timeline[rep.timeline.length - 1].t - rep.timeline[0].t) / rep.bucket_ms > 200) {
      rep = await call('GET', `/api/admin/report?from=${r.from}&to=${r.to}&bucket=1440`);
    }
  } catch (e) { return; }
  if (seq !== dashSeq || A.tab !== 'dashboard') return;
  const root = document.getElementById('dash');
  if (!root) return;
  document.getElementById('updated').textContent = 'Updated ' + new Date(rep.generated_at).toLocaleTimeString();

  const t = rep.totals;
  const tile = (label, value, sub, cls) => h('div', { class: 'tile ' + (cls || '') }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value num' }, value), h('div', { class: 'tile-sub num' }, sub || ' '));
  const tiles = h('div', { class: 'tiles' },
    tile('Net sales', money(t.net_cents), t.refunds_cents ? `${money(t.sales_cents)} sales − ${money(t.refunds_cents)} refunds` : rep.voided.orders ? `${rep.voided.orders} voided (${money(rep.voided.sales_cents)}) not counted` : 'Cash collected', 'hero'),
    tile('Orders', t.orders.toLocaleString(), t.orders ? `Average ${money(Math.round(t.sales_cents / t.orders))}` : 'Customers served'),
    tile('Tickets sold', t.net_items.toLocaleString(), t.orders ? (t.items / t.orders).toFixed(1) + ' per order' : ''),
    tile('Refunds', money(t.refunds_cents), `${t.refunded_tickets} ticket${t.refunded_tickets === 1 ? '' : 's'}`, t.refunds_cents ? 'warn' : ''),
    tile('Last 15 minutes', money(rep.last15.sales_cents), `${rep.last15.orders} order${rep.last15.orders === 1 ? '' : 's'}`),
    tile('Guest service', `${rep.guest.tickets.toLocaleString()} free`, rep.guest.orders ? `${rep.guest.orders} order${rep.guest.orders === 1 ? '' : 's'} · ${money(rep.guest.value_cents)} menu value` : 'Not in sales totals', 'guest'));

  put(root, tiles,
    h('div', { class: 'cols' },
      card('Sales over time', { 1440: 'Per day', 60: 'Per hour' }[rep.bucket_ms / 60000] || `Per ${rep.bucket_ms / 60000} minutes`, timelineChart(rep),
        A.range === 'all' ? null : h('div', { class: 'range' }, [15, 30].map((m) =>
          h('button', { class: 'seg' + (A.interval === m ? ' on' : ''), onclick: () => { A.interval = m; localStorage.setItem('admin_interval', m); refreshDashboard(); } }, `${m} min`)))),
      card('Sales by stall', null, stallBars(rep))),
    h('div', { class: 'cols' },
      card('Items', 'Best sellers first. Items with no sales are listed at the bottom.', itemsTable(rep),
        h('div', { class: 'range' },
          h('button', { class: 'seg' + (A.itemSort === 'sales_cents' ? ' on' : ''), onclick: () => { A.itemSort = 'sales_cents'; refreshDashboard(); } }, 'By sales'),
          h('button', { class: 'seg' + (A.itemSort === 'qty' ? ' on' : ''), onclick: () => { A.itemSort = 'qty'; refreshDashboard(); } }, 'By quantity'))),
      h('div', { class: 'stack' },
        card('Cashiers', 'Cash each drawer should hold: sales minus refunds paid out. Guest service orders take no cash.', cashierTable(rep)),
        rep.guest.byVolunteer.length ? card('Guest service by volunteer', null, volunteerFeed(rep), h('button', { class: 'btn small', onclick: () => go('guests') }, 'Details')) : null,
        rep.recentRefunds.length ? card('Latest refunds', null, refundList(rep)) : null,
        card('Latest orders', null, recentList(rep)))));
}

function card(title, sub, body, actions) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, title), sub ? h('p', { class: 'muted small' }, sub) : null), actions || null),
    body);
}

function niceStep(max, ticks) {
  const raw = max / ticks;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function timelineChart(rep) {
  if (!rep.timeline.length) return h('p', { class: 'empty' }, 'No sales in this period yet.');
  const step = rep.bucket_ms;
  const first = rep.timeline[0].t;
  const nowBucket = Math.floor(Date.now() / step) * step;
  const lastData = rep.timeline[rep.timeline.length - 1].t;
  const last = A.range === 'today' ? Math.max(lastData, nowBucket) : lastData;
  const byT = new Map(rep.timeline.map((b) => [b.t, b]));
  const buckets = [];
  for (let t = first; t <= last; t += step) buckets.push(byT.get(t) || { t, orders: 0, sales_cents: 0 });

  const W = 760; const H = 230; const L = 52; const R = 8; const T = 12; const B = 26;
  const pw = W - L - R; const ph = H - T - B;
  const max = Math.max(...buckets.map((b) => b.sales_cents), 100) / 100;
  const stepY = niceStep(max, 4);
  const top = Math.ceil(max / stepY) * stepY;
  const y = (dollars) => T + ph - (dollars / top) * ph;
  const slot = pw / buckets.length;
  const bw = Math.max(Math.min(slot - 2, 46), 1);
  const daily = step === 86400000;
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));
  const label = (t) => (daily ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : timeOf(t));

  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Sales over time' });
  for (let v = 0; v <= top + 1e-9; v += stepY) {
    g.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'gridline' }),
      svg('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, '$' + (v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : Math.round(v))));
  }
  buckets.forEach((b, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    const v = b.sales_cents / 100;
    const bh = Math.max(ph - (y(v) - T), b.sales_cents ? 2 : 0);
    g.append(svg('rect', { x, y: T + ph - bh, width: bw, height: bh, rx: Math.min(3, bw / 2), class: 'bar-rect' },
      svg('title', {}, `${label(b.t)}: ${money(b.sales_cents)} · ${b.orders} order${b.orders === 1 ? '' : 's'}`)));
    if (i % labelEvery === 0) g.append(svg('text', { x: L + i * slot + slot / 2, y: H - 8, 'text-anchor': 'middle', class: 'tick' }, label(b.t)));
  });
  const peak = buckets.reduce((a, b) => (b.sales_cents > a.sales_cents ? b : a));
  return h('div', {}, g, h('p', { class: 'muted small' }, `Busiest: ${label(peak.t)} with ${money(peak.sales_cents)} from ${peak.orders} order${peak.orders === 1 ? '' : 's'}. Hover a bar for details.`));
}

function stallBars(rep) {
  if (!rep.byStall.length) return h('p', { class: 'empty' }, 'No sales in this period yet.');
  const max = Math.max(...rep.byStall.map((s) => s.sales_cents), 1);
  const total = rep.totals.net_cents || 1;
  return h('div', { class: 'hbars' }, rep.byStall.map((s) => h('div', { class: 'hbar' },
    h('div', { class: 'hbar-top' }, h('span', { class: 'hbar-name' }, h('i', { style: { background: s.color } }), s.name),
      h('span', { class: 'num' }, h('strong', {}, money(s.sales_cents)), h('span', { class: 'muted' }, ` · ${Math.round((s.sales_cents / total) * 100)}%`))),
    h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: (s.sales_cents / max) * 100 + '%', background: s.color } })),
    h('div', { class: 'muted small num' }, `${s.qty.toLocaleString()} tickets${s.refunded ? ` · ${s.refunded} refunded` : ''}${s.guest_qty ? ` · ${s.guest_qty} guest service` : ''}`))));
}

function itemsTable(rep) {
  if (!rep.byItem.length) return h('p', { class: 'empty' }, 'No items on the menu yet.');
  const key = A.itemSort;
  const rows = [...rep.byItem].sort((a, b) => b[key] - a[key] || b.sales_cents - a.sales_cents);
  const max = Math.max(...rows.map((r) => r[key]), 1);
  const active = (r) => r.qty > 0 || r.refunded || r.guest_qty;
  let rank = 0;
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', { class: 'r' }, '#'), h('th', {}, 'Item'), h('th', {}, 'Stall'), h('th', { class: 'barcol' }, ''), h('th', { class: 'r' }, 'Sold'), h('th', { class: 'r' }, 'Sales'))),
    h('tbody', {}, rows.map((r) => h('tr', { class: active(r) ? '' : 'zero' },
      h('td', { class: 'r muted num' }, active(r) ? ++rank : '–'),
      h('td', {}, h('strong', {}, r.name)),
      h('td', {}, h('span', { class: 'stallchip' }, h('i', { style: { background: r.color } }), r.stall)),
      h('td', { class: 'barcol' }, h('div', { class: 'track thin' }, h('div', { class: 'fill', style: { width: Math.max(0, r[key] / max) * 100 + '%', background: r.color } }))),
      h('td', { class: 'r num' }, r.qty.toLocaleString(), r.refunded ? h('div', { class: 'refunded-small' }, `${r.refunded} refunded`) : null,
        r.guest_qty ? h('div', { class: 'guest-small' }, `+${r.guest_qty} guest`) : null),
      h('td', { class: 'r num' }, active(r) ? money(r.sales_cents) : 'No sales yet'))))));
}

function cashierTable(rep) {
  if (!rep.byCashier.length) return h('p', { class: 'empty' }, 'No sales in this period yet.');
  return h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Cashier'), h('th', { class: 'r' }, 'Orders'), h('th', { class: 'r' }, 'Sales'), h('th', { class: 'r' }, 'Refunds'), h('th', { class: 'r' }, 'In drawer'))),
    h('tbody', {}, rep.byCashier.map((c) => h('tr', {},
      h('td', {}, h('strong', {}, c.name), h('div', { class: 'muted small num' }, `last ${timeOf(c.last_at)}`)),
      h('td', { class: 'r num' }, c.orders, c.guest_orders ? h('div', { class: 'guest-small' }, `+${c.guest_orders} guest`) : null),
      h('td', { class: 'r num' }, money(c.sales_cents)),
      h('td', { class: 'r num' + (c.refunds_cents ? ' neg' : ' muted') }, c.refunds_cents ? `−${money(c.refunds_cents)}` : '–'),
      h('td', { class: 'r num' }, h('strong', {}, money(c.cash_cents)))))));
}

function refundList(rep) {
  return h('div', { class: 'feed' }, rep.recentRefunds.map((r) => h('div', { class: 'feed-row' },
    h('div', { class: 'feed-main' }, h('strong', { class: 'num' }, `${r.order_id}-${r.ticket_no}`), h('span', { class: 'muted num' }, ` ${timeOf(r.created_at)} · ${r.cashier_name}`),
      h('div', { class: 'muted small clip' }, `${r.item_name} · ${r.stall_name}`)),
    h('strong', { class: 'num neg' }, `−${money(r.amount_cents)}`))));
}

function recentList(rep) {
  if (!rep.recent.length) return h('p', { class: 'empty' }, 'No orders yet.');
  return h('div', { class: 'feed' }, rep.recent.map((o) => h('div', { class: 'feed-row' + (o.voided_at ? ' void' : '') },
    h('div', { class: 'feed-main' }, h('strong', { class: 'num' }, `#${o.id}`), h('span', { class: 'muted num' }, ` ${timeOf(o.created_at)} · ${o.cashier_name}${o.voided_at ? ' · VOIDED' : ''}`),
      o.kind === 'guest' ? h('div', { class: 'guest-small' }, `Guest service · ${o.volunteer_name}`) : null,
      h('div', { class: 'muted small clip' }, o.summary),
      o.refunded ? h('div', { class: 'refunded-small' }, `${o.refunded} ticket${o.refunded === 1 ? '' : 's'} refunded`) : null),
    o.kind === 'guest' ? h('span', { class: 'guest-free' }, 'No charge') : h('strong', { class: 'num' }, money(o.total_cents)))));
}

function volunteerFeed(rep) {
  return h('div', { class: 'feed' }, rep.guest.byVolunteer.slice(0, 8).map((v) => h('div', { class: 'feed-row' },
    h('div', { class: 'feed-main' }, h('strong', {}, v.name || fmtPhone(v.phone)), h('span', { class: 'muted num' }, ` last ${timeOf(v.last_at)}`),
      h('div', { class: 'muted small' }, `${v.orders} order${v.orders === 1 ? '' : 's'} · ${money(v.value_cents)} menu value`)),
    h('strong', { class: 'num' }, `${v.tickets} ticket${v.tickets === 1 ? '' : 's'}`))));
}

// ---------- orders ----------
async function renderOrders() {
  const f = A.orders;
  const r = rangeMs(f.range);
  const params = new URLSearchParams({ from: r.from, to: r.to, limit: 50, offset: f.offset });
  if (f.cashier_id) params.set('cashier_id', f.cashier_id);
  if (f.search) params.set('search', f.search);
  if (f.kind) params.set('kind', f.kind);
  if (f.volunteer) params.set('volunteer_id', f.volunteer.id);
  let data;
  try { data = await call('GET', '/api/admin/orders?' + params); } catch (e) { return; }
  if (A.tab !== 'orders') return;
  const reset = (patch) => { Object.assign(f, patch, { offset: 0 }); renderOrders(); };
  const exportUrl = `/api/admin/export.csv?from=${r.from}&to=${r.to}`;

  put(view(), 
    h('div', { class: 'bar' }, h('h1', {}, 'Orders'), h('span', { class: 'muted' }, `${data.total.toLocaleString()} in this period`), h('div', { class: 'spacer' }),
      h('input', { class: 'input', style: { width: '130px' }, placeholder: 'Order #', inputMode: 'numeric', value: f.search, onchange: (e) => reset({ search: e.target.value.replace(/\D/g, '') }) }),
      f.volunteer ? h('button', { class: 'btn small filter-chip', title: 'Show all orders', onclick: () => reset({ volunteer: null }) }, `Volunteer: ${f.volunteer.label}  ×`) : null,
      h('select', { class: 'input', 'aria-label': 'Order type', onchange: (e) => reset({ kind: e.target.value }) },
        [['', 'All orders'], ['sale', 'Cash sales'], ['guest', 'Guest service']].map(([v, l]) => h('option', { value: v, selected: f.kind === v }, l))),
      h('select', { class: 'input', onchange: (e) => reset({ cashier_id: e.target.value }) },
        h('option', { value: '' }, 'All cashiers'), A.catalog.cashiers.map((c) => h('option', { value: c.id, selected: String(c.id) === String(f.cashier_id) }, c.name))),
      rangePicker(f.range, (v) => reset({ range: v })),
      h('a', { class: 'btn', href: exportUrl }, 'Export CSV')),
    h('section', { class: 'card' }, data.rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Order'), h('th', {}, 'Time'), h('th', {}, 'Cashier'), h('th', {}, 'Items'), h('th', { class: 'r' }, 'Total'), h('th', {}, ''))),
      h('tbody', {}, data.rows.map((o) => h('tr', { class: o.voided_at ? 'voided' : '' },
        h('td', { class: 'num' }, h('strong', {}, '#' + o.id)),
        h('td', { class: 'num' }, new Date(o.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })),
        h('td', {}, o.cashier_name),
        h('td', { class: 'muted' }, o.kind === 'guest' ? h('div', { class: 'guest-small' }, `Guest service · ${o.volunteer_name}`) : null, o.summary,
          o.voided_at ? h('div', { class: 'voidnote' }, 'Voided' + (o.void_reason ? ': ' + o.void_reason : '')) : null,
          o.refunded ? h('div', { class: 'refunded-small' }, `${o.refunded} ticket${o.refunded === 1 ? '' : 's'} refunded (${money(o.refunded_cents)})`) : null),
        h('td', { class: 'r num' }, o.kind === 'guest' ? [h('span', { class: 'guest-free' }, 'No charge'), h('div', { class: 'muted small' }, `${money(o.total_cents)} value`)] : h('strong', {}, money(o.total_cents))),
        h('td', { class: 'r nowrap' }, o.voided_at
          ? h('button', { class: 'btn small', onclick: guard(async () => { await call('POST', `/api/admin/orders/${o.id}/restore`); renderOrders(); }) }, 'Restore')
          : [
            o.kind !== 'guest' && o.refunded < o.item_count ? h('button', { class: 'btn small', onclick: () => adminRefundDialog(o.id) }, 'Refund') : null, ' ',
            !o.refunded ? h('button', { class: 'btn small danger', onclick: guard(async () => {
              const reason = prompt(o.kind === 'guest' ? `Void Guest service order #${o.id}? It will be removed from the volunteer's totals.\n\nReason (optional):` : `Void order #${o.id} (${money(o.total_cents)})? It will be removed from sales totals.\n\nReason (optional):`, '');
              if (reason === null) return;
              await call('POST', `/api/admin/orders/${o.id}/void`, { reason }); renderOrders();
            }) }, 'Void') : null,
          ])))))) : h('p', { class: 'empty' }, 'No orders match.'),
    h('div', { class: 'pager' },
      h('button', { class: 'btn small', disabled: f.offset === 0, onclick: () => { f.offset = Math.max(0, f.offset - 50); renderOrders(); } }, 'Newer'),
      h('span', { class: 'muted num' }, data.total ? `${f.offset + 1}–${Math.min(f.offset + 50, data.total)} of ${data.total}` : ''),
      h('button', { class: 'btn small', disabled: f.offset + 50 >= data.total, onclick: () => { f.offset += 50; renderOrders(); } }, 'Older'))));
}

// Refund tickets from an order without the paper ticket (lost ticket, a
// cashier mistake). Recorded as "Admin" so it doesn't count against a drawer.
async function adminRefundDialog(orderId) {
  let order;
  try { order = (await call('GET', `/api/admin/orders/${orderId}`)).order; } catch (e) { return toast(e.message, 'error'); }
  const done = new Map(order.refunds.map((r) => [r.ticket_no, r]));
  const tickets = [];
  for (const l of order.lines) for (let i = 0; i < l.qty; i++) tickets.push({ n: tickets.length + 1, item: l.item_name, stall: l.stall_name, price: l.unit_price_cents });
  const picked = new Set();
  const totalEl = h('strong', { class: 'num' });
  const paint = () => { const t = tickets.filter((x) => picked.has(x.n)).reduce((s, x) => s + x.price, 0); totalEl.textContent = money(t); };
  const reason = h('input', { class: 'input', placeholder: 'Reason, e.g. lost ticket', maxLength: 200 });
  const ref = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  paint();
  dialog(`Refund from order #${order.id}`, h('div', { class: 'admin-refund' },
    h('p', { class: 'muted' }, 'Use this when the customer does not have the ticket. It is recorded as an Admin refund, so give the cash from the admin float, not a cashier drawer.'),
    h('div', { class: 'ticket-picks' }, tickets.map((t) => {
      const r = done.get(t.n);
      return h('label', { class: 'ticket-pick' + (r ? ' done' : '') },
        h('input', { type: 'checkbox', disabled: !!r, onchange: (e) => { e.target.checked ? picked.add(t.n) : picked.delete(t.n); paint(); } }),
        h('span', { class: 'num pick-code' }, `${order.id}-${t.n}`),
        h('span', { class: 'pick-item' }, t.item, h('span', { class: 'muted small' }, ` · ${t.stall}`)),
        h('span', { class: 'num' }, r ? `Refunded by ${r.cashier_name}` : money(t.price)));
    })),
    h('label', { class: 'field', style: { marginTop: '10px' } }, 'Reason', reason),
    h('div', { class: 'total-line' }, 'To give back ', totalEl)),
  [{ label: 'Refund selected', class: 'primary', onclick: guard(async (close) => {
    if (!picked.size) return toast('Tick the tickets to refund', 'error');
    const r = await call('POST', `/api/admin/orders/${order.id}/refund`, { batch_ref: ref, ticket_nos: [...picked], reason: reason.value });
    toast(`Refunded ${r.refunds.length} ticket(s). Give back ${money(r.total_cents)}.`, 'ok');
    close(); renderOrders();
  }) }], { wide: true });
}

// ---------- menu ----------
const toCents = (s) => { const v = Math.round(parseFloat(String(s).replace(/[$,\s]/g, '')) * 100); return Number.isFinite(v) && v >= 0 ? v : null; };
async function reloadMenu() { await loadCatalog(); if (A.tab === 'menu') renderMenu(); }
function move(list, id, dir) {
  const ids = list.map((x) => x.id);
  const i = ids.indexOf(id); const j = i + dir;
  if (j < 0 || j >= ids.length) return null;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return ids;
}
function toggle(checked, label, onchange) {
  return h('label', { class: 'switch', title: label }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), h('span', { class: 'slider' }), h('span', { class: 'switch-label' }, label));
}

function renderMenu() {
  const stalls = A.catalog.stalls;
  const newStall = h('input', { class: 'input', placeholder: 'New stall name', maxLength: 40 });
  const addStall = guard(async (e) => {
    e.preventDefault();
    await call('POST', '/api/admin/stalls', { name: newStall.value, color: PALETTE[stalls.length % PALETTE.length] });
    toast('Stall added', 'ok'); reloadMenu();
  });

  put(view(), 
    h('div', { class: 'bar' }, h('h1', {}, 'Menu'), h('span', { class: 'muted' }, 'Changes reach every cashier screen within a second or two.'), h('div', { class: 'spacer' }),
      h('form', { class: 'inline', onsubmit: addStall }, newStall, h('button', { class: 'btn primary' }, 'Add stall'))),
    stalls.length ? stalls.map((st, si) => stallCard(st, si, stalls)) : h('p', { class: 'empty' }, 'No stalls yet. Add the first one above.'));
}

function stallCard(st, si, stalls) {
  const save = (patch, msg) => guard(async () => { await call('PATCH', `/api/admin/stalls/${st.id}`, patch); Object.assign(st, patch); toast(msg || 'Saved', 'ok'); })();
  const name = h('input', { class: 'input stall-name', value: st.name, maxLength: 40, 'aria-label': 'Stall name', onchange: (e) => save({ name: e.target.value }) });
  const swatches = h('div', { class: 'swatches' }, PALETTE.map((c) => h('button', { class: 'swatch' + (c === st.color ? ' on' : ''), style: { background: c }, title: 'Stall color', 'aria-label': 'Color ' + c,
    onclick: async () => { await save({ color: c }); renderMenu(); } })));

  const newName = h('input', { class: 'input', placeholder: 'New item name', maxLength: 40 });
  const newPrice = h('input', { class: 'input price', placeholder: '0.00', inputMode: 'decimal' });
  const addItem = guard(async (e) => {
    e.preventDefault();
    const cents = toCents(newPrice.value);
    if (cents === null) return toast('Enter a price like 5 or 5.50', 'error');
    await call('POST', '/api/admin/items', { stall_id: st.id, name: newName.value, price_cents: cents });
    toast('Item added', 'ok'); await reloadMenu();
    const again = document.querySelector(`[data-stall="${st.id}"] .add-item input`); if (again) again.focus();
  });

  return h('section', { class: 'card stall-card' + (st.active ? '' : ' closed'), 'data-stall': st.id, style: { '--c': st.color } },
    h('div', { class: 'stall-head' },
      name, swatches, h('div', { class: 'spacer' }),
      toggle(!!st.active, st.active ? 'Open' : 'Closed', async (v) => { await save({ active: v }, v ? 'Stall opened' : 'Stall closed'); renderMenu(); }),
      h('button', { class: 'btn small', disabled: si === 0, title: 'Move up', onclick: guard(async () => { await call('POST', '/api/admin/stalls/reorder', { ids: move(stalls, st.id, -1) }); reloadMenu(); }) }, '↑'),
      h('button', { class: 'btn small', disabled: si === stalls.length - 1, title: 'Move down', onclick: guard(async () => { await call('POST', '/api/admin/stalls/reorder', { ids: move(stalls, st.id, 1) }); reloadMenu(); }) }, '↓'),
      h('button', { class: 'btn small danger', onclick: guard(async () => { if (!confirm(`Delete the stall "${st.name}" and its ${st.items.length} item(s)? Past sales stay in the reports.`)) return; await call('DELETE', `/api/admin/stalls/${st.id}`); reloadMenu(); }) }, 'Delete')),
    h('table', { class: 'table items' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Price'), h('th', {}, 'On the menu'), h('th', {}, ''))),
      h('tbody', {}, st.items.map((it, ii) => itemRow(it, ii, st)))),
    h('form', { class: 'inline add-item', onsubmit: addItem }, newName, h('span', { class: 'dollar' }, '$'), newPrice, h('button', { class: 'btn' }, 'Add item')));
}

function itemRow(it, ii, st) {
  const save = (patch, msg) => guard(async () => { await call('PATCH', `/api/admin/items/${it.id}`, patch); Object.assign(it, patch); toast(msg || 'Saved', 'ok'); })();
  const price = h('input', { class: 'input price', value: (it.price_cents / 100).toFixed(2), inputMode: 'decimal', 'aria-label': 'Price', onchange: async (e) => {
    const cents = toCents(e.target.value);
    if (cents === null) { toast('Enter a price like 5 or 5.50', 'error'); e.target.value = (it.price_cents / 100).toFixed(2); return; }
    await save({ price_cents: cents }, `${it.name} is now ${money(cents)}`);
    e.target.value = (it.price_cents / 100).toFixed(2);
  } });
  return h('tr', { class: it.available ? '' : 'off' },
    h('td', {}, h('input', { class: 'input', value: it.name, maxLength: 40, 'aria-label': 'Item name', onchange: (e) => save({ name: e.target.value }) })),
    h('td', {}, h('span', { class: 'dollar' }, '$'), price),
    h('td', {}, toggle(!!it.available, it.available ? 'Available' : 'Sold out', async (v) => { await save({ available: v }, v ? `${it.name} is back on` : `${it.name} marked sold out`); renderMenu(); })),
    h('td', { class: 'r nowrap' },
      h('button', { class: 'btn small', disabled: ii === 0, title: 'Move up', onclick: guard(async () => { await call('POST', '/api/admin/items/reorder', { ids: move(st.items, it.id, -1) }); reloadMenu(); }) }, '↑'), ' ',
      h('button', { class: 'btn small', disabled: ii === st.items.length - 1, title: 'Move down', onclick: guard(async () => { await call('POST', '/api/admin/items/reorder', { ids: move(st.items, it.id, 1) }); reloadMenu(); }) }, '↓'), ' ',
      h('button', { class: 'btn small danger', onclick: guard(async () => { if (!confirm(`Delete "${it.name}"? Past sales stay in the reports.`)) return; await call('DELETE', `/api/admin/items/${it.id}`); reloadMenu(); }) }, 'Delete')));
}

// ---------- cashiers ----------
const randomPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
function renderCashiers() {
  const name = h('input', { class: 'input', placeholder: 'Cashier name', maxLength: 40 });
  const pin = h('input', { class: 'input pin num', placeholder: '6-digit PIN', maxLength: 6, inputMode: 'numeric' });
  const reload = async () => { await loadCatalog(); if (A.tab === 'cashiers') renderCashiers(); };
  const add = guard(async (e) => {
    e.preventDefault();
    await call('POST', '/api/admin/cashiers', { name: name.value, pin: pin.value });
    toast(`${name.value.trim()} added with PIN ${pin.value}`, 'ok'); reload();
  });
  const list = A.catalog.cashiers;
  put(view(), 
    h('div', { class: 'bar' }, h('h1', {}, 'Cashiers'), h('span', { class: 'muted' }, 'Each cashier signs in with their own 6-digit PIN.')),
    h('section', { class: 'card' },
      h('form', { class: 'inline', onsubmit: add }, name, pin, h('button', { class: 'btn', type: 'button', onclick: () => { pin.value = randomPin(); } }, 'Random PIN'), h('button', { class: 'btn primary' }, 'Add cashier')),
      h('p', { class: 'muted small', style: { marginTop: '8px' } }, 'PINs are not shown again after saving. Write it down for the cashier, or set a new one later.')),
    h('section', { class: 'card' }, list.length ? h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Can sign in'), h('th', {}, ''))),
      h('tbody', {}, list.map((c) => h('tr', { class: c.active ? '' : 'off' },
        h('td', {}, h('input', { class: 'input', value: c.name, maxLength: 40, 'aria-label': 'Cashier name', onchange: guard(async (e) => { await call('PATCH', `/api/admin/cashiers/${c.id}`, { name: e.target.value }); toast('Saved', 'ok'); }) })),
        h('td', {}, toggle(!!c.active, c.active ? 'Active' : 'Blocked', guard(async (v) => { await call('PATCH', `/api/admin/cashiers/${c.id}`, { active: v }); toast(v ? `${c.name} can sign in` : `${c.name} is signed out and blocked`, 'ok'); reload(); }))),
        h('td', { class: 'r nowrap' },
          h('button', { class: 'btn small', onclick: guard(async () => {
            const p = prompt(`New 6-digit PIN for ${c.name}:`, randomPin());
            if (p === null) return;
            await call('PATCH', `/api/admin/cashiers/${c.id}`, { pin: p.trim() }); toast(`${c.name}'s PIN is now ${p.trim()}`, 'ok');
          }) }, 'Set new PIN'), ' ',
          h('button', { class: 'btn small danger', onclick: guard(async () => { if (!confirm(`Remove ${c.name}? Their past sales stay in the reports.`)) return; await call('DELETE', `/api/admin/cashiers/${c.id}`); reload(); }) }, 'Remove')))))) : h('p', { class: 'empty' }, 'No cashiers yet. Add one above so they can sign in.')));
}

// ---------- Guest service ----------
// Volunteers listed here can order free food for guests at any cashier by
// giving their phone number. The cashier only sees "Volunteer found".
const fmtPhone = (d) => (d && d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d || '');
function renderGuests() {
  const g = A.guests;
  const name = h('input', { class: 'input', placeholder: 'Name (optional)', maxLength: 60 });
  const phone = h('input', { class: 'input num', placeholder: 'Phone number', inputMode: 'tel', maxLength: 30 });
  const add = guard(async (e) => {
    e.preventDefault();
    await call('POST', '/api/admin/volunteers', { name: name.value, phone: phone.value });
    toast('Volunteer added', 'ok');
    name.value = ''; phone.value = ''; name.focus();
    refreshGuests();
  });
  put(view(),
    h('div', { class: 'bar' }, h('h1', {}, 'Guest service'),
      h('span', { class: 'muted' }, 'Volunteers on this list can get free tickets for guests by giving their phone number at any cashier.'),
      h('div', { class: 'spacer' }),
      rangePicker(g.range, (r) => { g.range = r; renderGuests(); })),
    h('section', { class: 'card' },
      h('form', { class: 'inline', onsubmit: add }, name, phone, h('button', { class: 'btn primary' }, 'Add volunteer'),
        h('div', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', onclick: pasteVolunteers }, 'Paste a list')),
      h('p', { class: 'muted small', style: { marginTop: '8px' } }, 'Any format works: 555-123-4567, (555) 123 4567, +1 5551234567. Only the last 10 digits are matched.')),
    h('div', { id: 'guests' }, h('p', { class: 'muted' }, 'Loading…')));
  refreshGuests();
}

let guestSeq = 0;
async function refreshGuests() {
  const seq = ++guestSeq;
  const r = rangeMs(A.guests.range);
  let list;
  try { list = (await call('GET', `/api/admin/volunteers?from=${r.from}&to=${r.to}`)).volunteers; } catch (e) { return; }
  const root = document.getElementById('guests');
  if (seq !== guestSeq || A.tab !== 'guests' || !root) return;
  const sum = list.reduce((a, v) => ({ orders: a.orders + v.orders, tickets: a.tickets + v.tickets, value: a.value + v.value_cents }), { orders: 0, tickets: 0, value: 0 });
  const rangeLabel = A.guests.range === 'today' ? 'today' : A.guests.range === 'all' ? 'all time' : new Date(A.guests.range + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
  const save = (v, patch, msg) => guard(async () => { await call('PATCH', `/api/admin/volunteers/${v.id}`, patch); toast(msg || 'Saved', 'ok'); refreshGuests(); })();
  const showOrders = (v) => { Object.assign(A.orders, { range: A.guests.range, kind: 'guest', volunteer: { id: v.id, label: v.name || fmtPhone(v.phone) }, cashier_id: '', search: '', offset: 0 }); go('orders'); };

  put(root,
    h('div', { class: 'tiles guest-tiles' },
      h('div', { class: 'tile guest' }, h('div', { class: 'tile-label' }, `Free tickets ${rangeLabel}`), h('div', { class: 'tile-value num' }, sum.tickets.toLocaleString()), h('div', { class: 'tile-sub' }, 'Not counted in sales')),
      h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, 'Guest service orders'), h('div', { class: 'tile-value num' }, sum.orders.toLocaleString()), h('div', { class: 'tile-sub' }, ' ')),
      h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, 'Menu value given'), h('div', { class: 'tile-value num' }, money(sum.value)), h('div', { class: 'tile-sub' }, 'At menu prices')),
      h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, 'Volunteers on the list'), h('div', { class: 'tile-value num' }, list.length), h('div', { class: 'tile-sub' }, `${list.filter((v) => v.active).length} allowed`))),
    h('section', { class: 'card' }, list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table volunteers' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Phone'), h('th', {}, 'Allowed'), h('th', { class: 'r' }, 'Orders'), h('th', { class: 'r' }, 'Tickets'), h('th', { class: 'r' }, 'Value'), h('th', {}, 'Last order'), h('th', {}, ''))),
      h('tbody', {}, list.map((v) => h('tr', { class: (v.active ? '' : 'off') + (v.orders ? '' : ' zero') },
        h('td', {}, h('input', { class: 'input', value: v.name, placeholder: 'No name', maxLength: 60, 'aria-label': 'Name', onchange: (e) => save(v, { name: e.target.value }) })),
        h('td', {}, h('input', { class: 'input num phone', value: fmtPhone(v.phone), maxLength: 30, inputMode: 'tel', 'aria-label': 'Phone', onchange: (e) => save(v, { phone: e.target.value }, 'Phone number updated') })),
        h('td', {}, toggle(!!v.active, v.active ? 'Allowed' : 'Off', (on) => save(v, { active: on }, on ? 'Volunteer allowed' : 'Volunteer switched off'))),
        h('td', { class: 'r num' }, v.orders),
        h('td', { class: 'r num' }, h('strong', {}, v.tickets)),
        h('td', { class: 'r num' }, money(v.value_cents)),
        h('td', { class: 'num muted' }, v.last_at ? new Date(v.last_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–'),
        h('td', { class: 'r nowrap' },
          h('button', { class: 'btn small', disabled: !v.orders, onclick: () => showOrders(v) }, 'Orders'), ' ',
          h('button', { class: 'btn small danger', onclick: guard(async () => {
            if (!confirm(`Remove ${v.name || fmtPhone(v.phone)} from the list? Their past orders stay in the reports.`)) return;
            await call('DELETE', `/api/admin/volunteers/${v.id}`); refreshGuests();
          }) }, 'Remove'))))))) : h('p', { class: 'empty' }, 'No volunteers yet. Add them above, or paste a list.')));
}

function pasteVolunteers() {
  const area = h('textarea', { class: 'input paste-area', rows: 10, placeholder: 'One volunteer per line, for example:\nRamesh Patel, 555-123-4567\nPriya Shah  (555) 987 6543\n5551112222' });
  dialog('Paste a list of volunteers', h('div', {},
    h('p', { class: 'muted' }, 'One per line: a name and a phone number, or just the phone number. Copy straight from a spreadsheet works too. Numbers already on the list are skipped.'),
    area),
  [{ label: 'Add these', class: 'primary', onclick: guard(async (close) => {
    const r = await call('POST', '/api/admin/volunteers/bulk', { text: area.value });
    close();
    refreshGuests();
    if (!r.skipped.length) return toast(`Added ${r.added} volunteer${r.added === 1 ? '' : 's'}`, 'ok');
    dialog(`Added ${r.added}, skipped ${r.skipped.length}`, h('div', { class: 'skipped' }, r.skipped.map((x) => h('div', { class: 'skip-row' }, h('span', { class: 'clip' }, x.line), h('span', { class: 'muted small' }, x.reason)))));
  }) }], { wide: true });
  setTimeout(() => area.focus(), 0);
}

// ---------- settings ----------
function renderSettings() {
  const s = A.catalog.settings;
  const eventName = h('input', { class: 'input', value: s.event_name, maxLength: 60 });
  const footer = h('input', { class: 'input', value: s.receipt_footer, maxLength: 60 });
  const paper = h('select', { class: 'input' }, h('option', { value: '80', selected: s.paper_width === '80' }, '80 mm (standard)'), h('option', { value: '58', selected: s.paper_width === '58' }, '58 mm (narrow)'));
  const showPrice = h('input', { type: 'checkbox', checked: s.show_price_on_ticket === '1' });
  const save = guard(async (e) => {
    e.preventDefault();
    A.catalog.settings = await call('PUT', '/api/admin/settings', { event_name: eventName.value, receipt_footer: footer.value, paper_width: paper.value, show_price_on_ticket: showPrice.checked });
    toast('Settings saved', 'ok'); renderShell();
  });
  const confirmBox = h('input', { class: 'input', placeholder: 'Type RESET', style: { width: '140px' } });
  put(view(), 
    h('div', { class: 'bar' }, h('h1', {}, 'Settings')),
    h('section', { class: 'card narrow' }, h('h2', {}, 'Event and tickets'),
      h('form', { class: 'form', onsubmit: save },
        h('label', { class: 'field' }, 'Event name (top of every ticket)', eventName),
        h('label', { class: 'field' }, 'Ticket footer line', footer),
        h('label', { class: 'field' }, 'Receipt paper width', paper),
        h('label', { class: 'check' }, showPrice, 'Print the price on each ticket'),
        h('div', {}, h('button', { class: 'btn primary' }, 'Save settings')))),
    h('section', { class: 'card narrow' }, h('h2', {}, 'Data'),
      h('p', { class: 'muted' }, 'Download everything as a spreadsheet, or take a full copy of the database as a backup.'),
      h('div', { class: 'inline', style: { marginTop: '10px' } },
        h('a', { class: 'btn', href: '/api/admin/export.csv' }, 'Export all sales (CSV)'),
        h('a', { class: 'btn', href: '/api/admin/backup' }, 'Download database backup'))),
    h('section', { class: 'card narrow dangerzone' }, h('h2', {}, 'Clear test sales'),
      h('p', { class: 'muted' }, 'Deletes every order and restarts order numbers at 100. The menu, cashiers and volunteers are kept. Use this after testing, before the event starts. It cannot be undone.'),
      h('div', { class: 'inline', style: { marginTop: '10px' } }, confirmBox,
        h('button', { class: 'btn danger', onclick: guard(async () => { await call('POST', '/api/admin/reset-sales', { confirm: confirmBox.value.trim() }); confirmBox.value = ''; toast('All sales cleared', 'ok'); }) }, 'Delete all sales'))));
}

// ---------- start ----------
async function start() {
  try {
    const me = await api('GET', '/api/admin/me');
    A.defaultPassword = me.default_password;
    await loadCatalog();
  } catch (e) { return renderLogin(); }
  if (!TABS.some(([id]) => id === A.tab)) A.tab = 'dashboard';
  renderShell();
  startLive();
}
start();
