'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { openDb, HttpError } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'pos.db');
const EVENT_TZ = process.env.EVENT_TZ || 'America/New_York';

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  if (PROD) {
    console.error('ADMIN_PASSWORD is not set. Refusing to start in production without it.');
    process.exit(1);
  }
  ADMIN_PASSWORD = 'admin123';
  console.warn('\n  ADMIN_PASSWORD not set. Using the development password "admin123".\n  Set ADMIN_PASSWORD before putting this on the internet.\n');
}

const db = openDb(DB_PATH);
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // Browsers cannot send a cross-site JSON POST without a CORS preflight,
  // which we never grant. Requiring JSON blocks cross-site form posts.
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.path.startsWith('/api/') && !req.is('application/json')) {
    return res.status(415).json({ error: 'JSON_REQUIRED', message: 'Send JSON' });
  }
  next();
});

// ---------- helpers ----------
const CASHIER_COOKIE = 'pos_cashier';
const ADMIN_COOKIE = 'pos_admin';
const CASHIER_TTL = 18 * 3600 * 1000;
const ADMIN_TTL = 12 * 3600 * 1000;

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(req, res, name, value, maxAgeMs) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (req.secure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

const bad = (msg) => new HttpError(400, 'BAD_REQUEST', msg);
function text(v, label, max = 60) {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${label} is required`);
  const t = v.trim().replace(/\s+/g, ' ');
  if (t.length > max) throw bad(`${label} is too long (max ${max} characters)`);
  return t;
}
function int(v, label, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${label} is not valid`);
  return v;
}
function pinOf(v) {
  if (typeof v !== 'string' || !/^\d{6}$/.test(v)) throw bad('PIN must be exactly 6 digits');
  return v;
}
function colorOf(v) {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw bad('Color is not valid');
  return v;
}
function idParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'NOT_FOUND', 'Not found');
  return id;
}
function range(req) {
  const from = Number(req.query.from) || 0;
  const to = Number(req.query.to) || 8640000000000000;
  return { from, to };
}

// Login throttling, per IP. The limits are loose because all six cashiers
// will usually share one IP address behind the venue's router.
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset < t) hits.delete(k); }, 60000).unref();
  return {
    blocked(ip) { const h = hits.get(ip); return !!h && h.reset > Date.now() && h.count >= max; },
    fail(ip) {
      const t = Date.now();
      const h = hits.get(ip);
      if (!h || h.reset < t) hits.set(ip, { count: 1, reset: t + windowMs }); else h.count++;
    },
  };
}
const pinLimiter = limiter(30, 5 * 60000);
const phoneLimiter = limiter(40, 5 * 60000); // wrong Guest service numbers
const adminLimiter = limiter(10, 10 * 60000);

// ---------- live updates (Server-Sent Events) ----------
const streams = new Set();
let menuVersion = Date.now();
function openStream(req, res, channel) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const s = { res, channel };
  streams.add(s);
  req.on('close', () => streams.delete(s));
}
function broadcast(event, data, channel) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
  for (const s of streams) if (!channel || s.channel === channel) s.res.write(msg);
}
setInterval(() => { for (const s of streams) s.res.write(': ping\n\n'); }, 20000).unref();
function menuChanged() {
  menuVersion++;
  broadcast('menu', { version: menuVersion });
}

// ---------- auth middleware ----------
function requireCashier(req, res, next) {
  const s = db.getSession(cookies(req)[CASHIER_COOKIE], 'cashier');
  if (!s) return res.status(401).json({ error: 'NOT_SIGNED_IN', message: 'Enter your PIN' });
  req.cashier = s.cashier;
  next();
}
function requireAdmin(req, res, next) {
  if (!db.getSession(cookies(req)[ADMIN_COOKIE], 'admin')) return res.status(401).json({ error: 'NOT_SIGNED_IN', message: 'Sign in' });
  next();
}

// ---------- cashier API ----------
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/api/login', (req, res) => {
  if (pinLimiter.blocked(req.ip)) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong PINs. Wait a few minutes.');
  const pin = pinOf(req.body.pin);
  const cashier = db.cashierByPin(pin);
  if (!cashier) {
    pinLimiter.fail(req.ip);
    throw new HttpError(401, 'WRONG_PIN', 'PIN not recognized');
  }
  setCookie(req, res, CASHIER_COOKIE, db.createSession('cashier', cashier.id, CASHIER_TTL), CASHIER_TTL);
  res.json({ cashier });
});
app.post('/api/logout', (req, res) => {
  db.deleteSession(cookies(req)[CASHIER_COOKIE]);
  setCookie(req, res, CASHIER_COOKIE, '', 0);
  res.json({ ok: true });
});
app.get('/api/me', requireCashier, (req, res) => res.json({ cashier: req.cashier }));

app.get('/api/menu', requireCashier, (req, res) => {
  res.json({ version: menuVersion, settings: db.getSettings(), stalls: db.catalog({ forCashier: true }) });
});

app.post('/api/orders', requireCashier, (req, res) => {
  const b = req.body || {};
  if (typeof b.client_ref !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(b.client_ref)) throw bad('Order reference is not valid');
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 100) throw bad('Order has no items');
  const lines = b.lines.map((l) => ({ item_id: int(l && l.item_id, 'Item', 1, 2 ** 31), qty: int(l && l.qty, 'Quantity', 1, 99) }));
  const expected = int(b.expected_total_cents, 'Total', 0, 10000000);
  const guestPhone = b.guest_phone == null ? null : String(b.guest_phone).slice(0, 30);
  if (guestPhone != null && !db.normPhone(guestPhone)) throw bad('Phone number needs 10 digits');
  const tendered = guestPhone != null || b.cash_tendered_cents == null ? null : int(b.cash_tendered_cents, 'Cash received', 0, 100000000);
  const { order, duplicate } = db.createOrder(req.cashier, { client_ref: b.client_ref, lines, expected_total_cents: expected, cash_tendered_cents: tendered, guest_phone: guestPhone });
  if (!duplicate) broadcast('order', { id: order.id, total_cents: order.total_cents }, 'admin');
  res.status(duplicate ? 200 : 201).json({ order, duplicate });
});

// Guest service: the cashier types the volunteer's phone number. We only say
// whether it is on the list; the name is never sent to the cashier screen.
app.post('/api/guest/check', requireCashier, (req, res) => {
  if (phoneLimiter.blocked(req.ip)) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many numbers not found. Wait a few minutes.');
  const phone = String((req.body || {}).phone || '').slice(0, 30);
  if (!db.normPhone(phone)) throw bad('Phone number needs 10 digits');
  const found = !!db.volunteerByPhone(phone);
  if (!found) phoneLimiter.fail(req.ip);
  res.json({ found });
});

app.get('/api/orders/recent', requireCashier, (req, res) => res.json({ orders: db.recentOrdersForCashier(req.cashier.id) }));

// ---------- refunds ----------
// A ticket code is "order-ticket", e.g. 422-2. Accept a space, slash or dot too.
function parseTicketCode(s) {
  const m = /^\s*#?\s*(\d{1,9})\s*[-\s/.]\s*(\d{1,4})\s*$/.exec(String(s || ''));
  if (!m) throw bad('Type the ticket code like 422-2');
  return { order_id: Number(m[1]), ticket_no: Number(m[2]) };
}
function refundBody(b, maxTickets) {
  if (typeof b.batch_ref !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(b.batch_ref)) throw bad('Refund reference is not valid');
  if (!Array.isArray(b.tickets) || b.tickets.length < 1 || b.tickets.length > maxTickets) throw bad('No tickets to refund');
  const tickets = b.tickets.map((t) => ({ order_id: int(t && t.order_id, 'Ticket', 1, 2 ** 31), ticket_no: int(t && t.ticket_no, 'Ticket', 1, 10000) }));
  const reason = b.reason == null ? null : String(b.reason).trim().slice(0, 200) || null;
  return { batch_ref: b.batch_ref, tickets, reason };
}
app.get('/api/tickets/:code', requireCashier, (req, res) => {
  const { order_id, ticket_no } = parseTicketCode(req.params.code);
  res.json({ ticket: db.lookupTicket(order_id, ticket_no) });
});
app.post('/api/refunds', requireCashier, (req, res) => {
  const result = db.refundTickets(req.cashier, refundBody(req.body || {}, 50));
  if (!result.duplicate) broadcast('order', {}, 'admin');
  res.status(result.duplicate ? 200 : 201).json(result);
});
app.get('/api/events', requireCashier, (req, res) => openStream(req, res, 'cashier'));

// ---------- admin API ----------
app.post('/api/admin/login', (req, res) => {
  if (adminLimiter.blocked(req.ip)) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Wait a few minutes.');
  const given = crypto.createHash('sha256').update(String((req.body || {}).password || '')).digest();
  const want = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(given, want)) {
    adminLimiter.fail(req.ip);
    throw new HttpError(401, 'WRONG_PASSWORD', 'Wrong password');
  }
  setCookie(req, res, ADMIN_COOKIE, db.createSession('admin', null, ADMIN_TTL), ADMIN_TTL);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  db.deleteSession(cookies(req)[ADMIN_COOKIE]);
  setCookie(req, res, ADMIN_COOKIE, '', 0);
  res.json({ ok: true });
});

const admin = express.Router();
admin.use(requireAdmin);
app.use('/api/admin', admin);

admin.get('/me', (req, res) => res.json({ ok: true, default_password: !process.env.ADMIN_PASSWORD }));
admin.get('/events', (req, res) => openStream(req, res, 'admin'));
admin.get('/catalog', (req, res) => res.json({ stalls: db.catalog({ forCashier: false }), cashiers: db.listCashiers(), settings: db.getSettings() }));

admin.post('/stalls', (req, res) => {
  const id = db.createStall({ name: text(req.body.name, 'Stall name', 40), color: req.body.color ? colorOf(req.body.color) : undefined });
  menuChanged();
  res.status(201).json({ id });
});
admin.patch('/stalls/:id', (req, res) => {
  const b = req.body || {};
  db.updateStall(idParam(req), {
    name: b.name === undefined ? undefined : text(b.name, 'Stall name', 40),
    color: b.color === undefined ? undefined : colorOf(b.color),
    active: b.active === undefined ? undefined : !!b.active,
  });
  menuChanged();
  res.json({ ok: true });
});
admin.delete('/stalls/:id', (req, res) => { db.archiveStall(idParam(req)); menuChanged(); res.json({ ok: true }); });
const idList = (v) => { if (!Array.isArray(v) || v.length > 500 || !v.every((n) => Number.isInteger(n) && n > 0)) throw bad('Order list is not valid'); return v; };
admin.post('/stalls/reorder', (req, res) => { db.reorderStalls(idList(req.body.ids)); menuChanged(); res.json({ ok: true }); });

const priceOf = (v) => int(v, 'Price', 0, 100000);
admin.post('/items', (req, res) => {
  const b = req.body || {};
  const id = db.createItem({ stall_id: int(b.stall_id, 'Stall', 1, 2 ** 31), name: text(b.name, 'Item name', 40), price_cents: priceOf(b.price_cents) });
  menuChanged();
  res.status(201).json({ id });
});
admin.patch('/items/:id', (req, res) => {
  const b = req.body || {};
  db.updateItem(idParam(req), {
    name: b.name === undefined ? undefined : text(b.name, 'Item name', 40),
    price_cents: b.price_cents === undefined ? undefined : priceOf(b.price_cents),
    available: b.available === undefined ? undefined : !!b.available,
  });
  menuChanged();
  res.json({ ok: true });
});
admin.delete('/items/:id', (req, res) => { db.archiveItem(idParam(req)); menuChanged(); res.json({ ok: true }); });
admin.post('/items/reorder', (req, res) => { db.reorderItems(idList(req.body.ids)); menuChanged(); res.json({ ok: true }); });

admin.post('/cashiers', (req, res) => {
  const id = db.createCashier({ name: text(req.body.name, 'Cashier name', 40), pin: pinOf(req.body.pin) });
  res.status(201).json({ id });
});
admin.patch('/cashiers/:id', (req, res) => {
  const b = req.body || {};
  db.updateCashier(idParam(req), {
    name: b.name === undefined ? undefined : text(b.name, 'Cashier name', 40),
    pin: b.pin === undefined ? undefined : pinOf(b.pin),
    active: b.active === undefined ? undefined : !!b.active,
  });
  res.json({ ok: true });
});
admin.delete('/cashiers/:id', (req, res) => { db.archiveCashier(idParam(req)); res.json({ ok: true }); });

// ---------- volunteers (Guest service) ----------
const nameOf = (v) => (v == null ? '' : String(v).trim().replace(/\s+/g, ' ').slice(0, 60));
admin.get('/volunteers', (req, res) => res.json({ volunteers: db.listVolunteers(range(req)) }));
admin.post('/volunteers', (req, res) => {
  const b = req.body || {};
  const id = db.createVolunteer({ name: nameOf(b.name), phone: String(b.phone || '').slice(0, 30) });
  res.status(201).json({ id });
});
// Paste a list, one per line: "Name, phone", "Name phone" or just the phone.
admin.post('/volunteers/bulk', (req, res) => {
  const textIn = String((req.body || {}).text || '');
  if (textIn.length > 100000) throw bad('List is too long');
  const rows = textIn.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2000).map((line) => {
    const m = /^(.*?)[\s,;\t]*([+(]?\d[\d\s().-]{8,}\d)\s*$/.exec(line);
    return m ? { line, name: nameOf(m[1].replace(/[,;\t]+$/, '')), phone: m[2] } : { line, name: '', phone: '' };
  });
  res.json(db.addVolunteers(rows));
});
admin.patch('/volunteers/:id', (req, res) => {
  const b = req.body || {};
  db.updateVolunteer(idParam(req), {
    name: b.name === undefined ? undefined : nameOf(b.name),
    phone: b.phone === undefined ? undefined : String(b.phone).slice(0, 30),
    active: b.active === undefined ? undefined : !!b.active,
  });
  res.json({ ok: true });
});
admin.delete('/volunteers/:id', (req, res) => { db.archiveVolunteer(idParam(req)); res.json({ ok: true }); });

admin.get('/report', (req, res) => {
  const bucketMin = [5, 15, 30, 60, 1440].includes(Number(req.query.bucket)) ? Number(req.query.bucket) : 15;
  res.json(db.report({ ...range(req), bucketMin }));
});
admin.get('/orders', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json(db.listOrders({ ...range(req), limit, offset, cashier_id: Number(req.query.cashier_id) || null, search: Number(req.query.search) || null,
    kind: ['sale', 'guest'].includes(req.query.kind) ? req.query.kind : null, volunteer_id: Number(req.query.volunteer_id) || null }));
});
admin.get('/orders/:id', (req, res) => {
  const o = db.loadOrder(idParam(req));
  if (!o) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
  res.json({ order: o });
});
// Refund without the paper ticket (lost ticket, mistakes). Recorded as "Admin".
admin.post('/orders/:id/refund', (req, res) => {
  const id = idParam(req);
  const b = req.body || {};
  if (!Array.isArray(b.ticket_nos)) throw bad('No tickets to refund');
  const body = refundBody({ ...b, tickets: b.ticket_nos.map((n) => ({ order_id: id, ticket_no: n })) }, 500);
  const result = db.refundTickets({ id: null, name: 'Admin' }, body);
  if (!result.duplicate) broadcast('order', {}, 'admin');
  res.json(result);
});
admin.post('/orders/:id/void', (req, res) => {
  db.setVoid(idParam(req), true, String((req.body || {}).reason || '').slice(0, 200));
  broadcast('order', {}, 'admin');
  res.json({ ok: true });
});
admin.post('/orders/:id/restore', (req, res) => {
  db.setVoid(idParam(req), false);
  broadcast('order', {}, 'admin');
  res.json({ ok: true });
});

admin.get('/settings', (req, res) => res.json(db.getSettings()));
admin.put('/settings', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.event_name !== undefined) patch.event_name = text(b.event_name, 'Event name', 60);
  if (b.receipt_footer !== undefined) patch.receipt_footer = String(b.receipt_footer).trim().slice(0, 60);
  if (b.paper_width !== undefined) { if (!['58', '80'].includes(String(b.paper_width))) throw bad('Paper width must be 58 or 80'); patch.paper_width = String(b.paper_width); }
  if (b.show_price_on_ticket !== undefined) patch.show_price_on_ticket = b.show_price_on_ticket ? '1' : '0';
  const s = db.updateSettings(patch);
  menuChanged();
  res.json(s);
});

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const money = (c) => (c / 100).toFixed(2);
admin.get('/export.csv', (req, res) => {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: EVENT_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const rows = db.exportRows(range(req));
  const out = ['order_number,time_local,cashier,type,volunteer,stall,item,qty,unit_price,line_total,order_total,voided,refunded_qty,refunded_amount'];
  for (const r of rows) {
    out.push([r.order_id, fmt.format(new Date(r.created_at)).replace(',', ''), r.cashier_name, r.kind === 'guest' ? 'guest service' : 'sale', r.volunteer_name || '',
      r.stall_name, r.item_name, r.qty,
      money(r.unit_price_cents), money(r.line_total_cents), money(r.order_total_cents), r.voided_at ? 'yes' : '', r.refunded_qty || '', r.refunded_qty ? money(r.refunded_cents) : ''].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pos-sales.csv"');
  res.send('﻿' + out.join('\r\n') + '\r\n');
});

admin.get('/backup', async (req, res, next) => {
  const tmp = path.join(path.dirname(DB_PATH), `backup-${Date.now()}.db`);
  try {
    await db.raw.backup(tmp);
    res.download(tmp, `pos-backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.db`, () => fs.rm(tmp, { force: true }, () => {}));
  } catch (e) { fs.rm(tmp, { force: true }, () => {}); next(e); }
});

admin.post('/reset-sales', (req, res) => {
  if ((req.body || {}).confirm !== 'RESET') throw bad('Type RESET to confirm');
  db.resetSales();
  broadcast('order', {}, 'admin');
  res.json({ ok: true });
});

// ---------- static pages ----------
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'BAD_REQUEST', message: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'SERVER_ERROR', message: 'Something went wrong on the server' });
});

setInterval(() => db.purgeSessions(), 3600 * 1000).unref();

const server = app.listen(PORT, () => {
  console.log(`Food Stall POS running on port ${PORT}`);
  console.log(`  Cashier screen: http://localhost:${PORT}/`);
  console.log(`  Admin:          http://localhost:${PORT}/admin`);
  console.log(`  Database:       ${DB_PATH}`);
});

function shutdown() {
  for (const s of streams) s.res.end();
  server.close(() => { db.raw.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
