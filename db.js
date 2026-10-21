'use strict';
// Database layer. SQLite in WAL mode, every write inside a transaction.
// All money is stored as integer cents.

const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stalls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#c2410c',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stall_id INTEGER NOT NULL REFERENCES stalls(id),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  available INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cashiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pin_hmac TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cashiers_pin ON cashiers(pin_hmac) WHERE archived = 0;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  cashier_id INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_ref TEXT NOT NULL UNIQUE,
  cashier_id INTEGER NOT NULL,
  cashier_name TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  cash_tendered_cents INTEGER,
  created_at INTEGER NOT NULL,
  voided_at INTEGER,
  void_reason TEXT,
  kind TEXT NOT NULL DEFAULT 'sale',  -- 'sale' (cash) or 'guest' (Guest service, no money)
  volunteer_id INTEGER,
  volunteer_name TEXT
);
CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS orders_cashier ON orders(cashier_id, created_at);
CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL,
  stall_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  stall_name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  line_total_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lines_order ON order_lines(order_id);
CREATE INDEX IF NOT EXISTS lines_item ON order_lines(item_id);
-- One row per refunded ticket. UNIQUE(order_id, ticket_no) means a ticket can
-- only ever be refunded once, even if two cashiers try at the same moment.
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  ticket_no INTEGER NOT NULL,
  line_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  stall_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  stall_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  cashier_id INTEGER,
  cashier_name TEXT NOT NULL,
  batch_ref TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(order_id, ticket_no)
);
CREATE INDEX IF NOT EXISTS refunds_created ON refunds(created_at);
CREATE INDEX IF NOT EXISTS refunds_batch ON refunds(batch_ref);
CREATE INDEX IF NOT EXISTS refunds_line ON refunds(line_id);
-- Volunteers who may order free food for guests (Guest service).
-- phone holds the last 10 digits only, so "+1 (555) 123-4567" and "5551234567" match.
CREATE TABLE IF NOT EXISTS volunteers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS volunteers_phone ON volunteers(phone) WHERE archived = 0;
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS = {
  event_name: 'Diwali Food Stalls',
  receipt_footer: 'Happy Diwali!',
  paper_width: '80',
  show_price_on_ticket: '0',
};
const PUBLIC_SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

const SAMPLE_MENU = [
  ['Pav Bhaji & Sandwich', '#c2410c', [['Bhaji Pau', 800], ['Extra Pau', 100], ['Veg Sandwich', 600], ['Cheese Sandwich', 700]]],
  ['Farsan', '#a16207', [['Bhajiya', 500], ['Samosa (2 pc)', 400], ['Dabeli', 500], ['Khaman', 500]]],
  ['South Indian', '#15803d', [['Masala Dosa', 800], ['Plain Dosa', 600], ['Idli Sambhar', 600], ['Medu Vada', 600]]],
  ['Sweets', '#be185d', [['Jalebi', 500], ['Gulab Jamun (2 pc)', 400], ['Kulfi', 400]]],
  ['Drinks', '#0e7490', [['Masala Chai', 200], ['Mango Lassi', 400], ['Water Bottle', 100], ['Soda', 200]]],
];

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL'); // a settled order survives a crash or power cut
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  // Databases made before Guest service existed: add the new order columns.
  const orderCols = new Set(db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name));
  if (!orderCols.has('kind')) db.exec("ALTER TABLE orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'sale'");
  if (!orderCols.has('volunteer_id')) db.exec('ALTER TABLE orders ADD COLUMN volunteer_id INTEGER');
  if (!orderCols.has('volunteer_name')) db.exec('ALTER TABLE orders ADD COLUMN volunteer_name TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS orders_volunteer ON orders(volunteer_id, created_at)');

  const now = () => Date.now();
  const stmts = new Map();
  const q = (sql) => { let s = stmts.get(sql); if (!s) { s = db.prepare(sql); stmts.set(sql, s); } return s; };

  // ---------- settings ----------
  const setSetting = q('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const getSettingStmt = q('SELECT value FROM settings WHERE key=?');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    q('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, v);
  }
  // Databases created by the first version carry the old default event name. Rename it once; a name the admin typed is left alone.
  q("UPDATE settings SET value=? WHERE key='event_name' AND value=?").run(DEFAULT_SETTINGS.event_name, ['Sha', 'yona Diwali Food Stalls'].join(''));
  if (!getSettingStmt.get('pin_secret')) setSetting.run('pin_secret', crypto.randomBytes(32).toString('hex'));
  const pinSecret = getSettingStmt.get('pin_secret').value;
  const pinHmac = (pin) => crypto.createHmac('sha256', pinSecret).update(String(pin)).digest('hex');

  function getSettings() {
    const out = {};
    for (const k of PUBLIC_SETTING_KEYS) out[k] = getSettingStmt.get(k).value;
    return out;
  }
  function updateSettings(patch) {
    const tx = db.transaction(() => {
      for (const k of PUBLIC_SETTING_KEYS) if (patch[k] !== undefined) setSetting.run(k, String(patch[k]));
    });
    tx.immediate();
    return getSettings();
  }

  // Order numbers start at 100 so ticket codes are always at least "100-1".
  // Only applies while there are no orders; existing numbers are never changed.
  function seedOrderNumbers() {
    if (q('SELECT COUNT(*) n FROM orders').get().n > 0) return;
    q("DELETE FROM sqlite_sequence WHERE name='orders'").run();
    q("INSERT INTO sqlite_sequence(name,seq) VALUES('orders',99)").run();
  }
  db.transaction(seedOrderNumbers).immediate();

  // ---------- first-run sample menu ----------
  if (q('SELECT COUNT(*) n FROM stalls').get().n === 0) {
    db.transaction(() => {
      SAMPLE_MENU.forEach(([name, color, items], si) => {
        const sid = q('INSERT INTO stalls(name,color,sort_order) VALUES(?,?,?)').run(name, color, si).lastInsertRowid;
        items.forEach(([iname, price], ii) =>
          q('INSERT INTO items(stall_id,name,price_cents,sort_order) VALUES(?,?,?,?)').run(sid, iname, price, ii));
      });
    }).immediate();
  }

  // ---------- catalog ----------
  function catalog({ forCashier }) {
    const stalls = q(`SELECT id,name,color,sort_order,active FROM stalls WHERE archived=0 ${forCashier ? 'AND active=1' : ''} ORDER BY sort_order,id`).all();
    const items = q('SELECT id,stall_id,name,price_cents,available,sort_order FROM items WHERE archived=0 ORDER BY sort_order,id').all();
    const byStall = new Map(stalls.map((s) => [s.id, { ...s, items: [] }]));
    for (const it of items) byStall.get(it.stall_id)?.items.push(it);
    return [...byStall.values()];
  }

  const nextSort = (table, where = '', ...args) =>
    q(`SELECT COALESCE(MAX(sort_order),-1)+1 n FROM ${table} WHERE archived=0 ${where}`).get(...args).n;

  function createStall({ name, color }) {
    const r = q('INSERT INTO stalls(name,color,sort_order) VALUES(?,?,?)').run(name, color || '#c2410c', nextSort('stalls'));
    return r.lastInsertRowid;
  }
  function updateStall(id, p) {
    const s = q('SELECT * FROM stalls WHERE id=? AND archived=0').get(id);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Stall not found');
    q('UPDATE stalls SET name=?, color=?, active=? WHERE id=?').run(p.name ?? s.name, p.color ?? s.color, p.active === undefined ? s.active : (p.active ? 1 : 0), id);
  }
  const archiveStall = db.transaction((id) => {
    q('UPDATE items SET archived=1 WHERE stall_id=?').run(id);
    q('UPDATE stalls SET archived=1 WHERE id=?').run(id);
  });
  const reorder = db.transaction((table, ids) => {
    const st = q(`UPDATE ${table} SET sort_order=? WHERE id=?`);
    ids.forEach((id, i) => st.run(i, id));
  });

  function createItem({ stall_id, name, price_cents }) {
    if (!q('SELECT 1 FROM stalls WHERE id=? AND archived=0').get(stall_id)) throw new HttpError(404, 'NOT_FOUND', 'Stall not found');
    return q('INSERT INTO items(stall_id,name,price_cents,sort_order) VALUES(?,?,?,?)')
      .run(stall_id, name, price_cents, nextSort('items', 'AND stall_id=?', stall_id)).lastInsertRowid;
  }
  function updateItem(id, p) {
    const it = q('SELECT * FROM items WHERE id=? AND archived=0').get(id);
    if (!it) throw new HttpError(404, 'NOT_FOUND', 'Item not found');
    q('UPDATE items SET name=?, price_cents=?, available=? WHERE id=?').run(
      p.name ?? it.name, p.price_cents ?? it.price_cents, p.available === undefined ? it.available : (p.available ? 1 : 0), id);
  }
  const archiveItem = (id) => q('UPDATE items SET archived=1 WHERE id=?').run(id);

  // ---------- cashiers ----------
  const listCashiers = () => q('SELECT id,name,active,created_at FROM cashiers WHERE archived=0 ORDER BY id').all();
  function pinTaken(pin, exceptId) {
    const row = q('SELECT id FROM cashiers WHERE pin_hmac=? AND archived=0').get(pinHmac(pin));
    return !!row && row.id !== exceptId;
  }
  function createCashier({ name, pin }) {
    if (pinTaken(pin)) throw new HttpError(409, 'PIN_TAKEN', 'Another cashier already uses that PIN');
    return q('INSERT INTO cashiers(name,pin_hmac,created_at) VALUES(?,?,?)').run(name, pinHmac(pin), now()).lastInsertRowid;
  }
  const updateCashier = db.transaction((id, p) => {
    const c = q('SELECT * FROM cashiers WHERE id=? AND archived=0').get(id);
    if (!c) throw new HttpError(404, 'NOT_FOUND', 'Cashier not found');
    if (p.pin !== undefined && pinTaken(p.pin, id)) throw new HttpError(409, 'PIN_TAKEN', 'Another cashier already uses that PIN');
    const active = p.active === undefined ? c.active : (p.active ? 1 : 0);
    q('UPDATE cashiers SET name=?, pin_hmac=?, active=? WHERE id=?').run(p.name ?? c.name, p.pin !== undefined ? pinHmac(p.pin) : c.pin_hmac, active, id);
    // a new PIN or a deactivation signs the cashier out everywhere
    if (p.pin !== undefined || !active) q("DELETE FROM sessions WHERE kind='cashier' AND cashier_id=?").run(id);
  });
  const archiveCashier = db.transaction((id) => {
    q('UPDATE cashiers SET archived=1, active=0 WHERE id=?').run(id);
    q("DELETE FROM sessions WHERE kind='cashier' AND cashier_id=?").run(id);
  });
  const cashierByPin = (pin) => q('SELECT id,name FROM cashiers WHERE pin_hmac=? AND archived=0 AND active=1').get(pinHmac(pin));

  // ---------- volunteers (Guest service) ----------
  // Keep only digits, and only the last 10, so any common way of writing the
  // same number matches. Returns null when there are too few digits.
  const normPhone = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
  // Per-volunteer totals for a date range (voided orders left out).
  const VG = "o.volunteer_id=v.id AND o.kind='guest' AND o.voided_at IS NULL AND o.created_at>=@from AND o.created_at<@to";
  const listVolunteers = ({ from = 0, to = 8640000000000000 } = {}) => q(`SELECT v.id,v.name,v.phone,v.active,v.created_at,
      (SELECT COUNT(*) FROM orders o WHERE ${VG}) orders,
      (SELECT COALESCE(SUM(o.item_count),0) FROM orders o WHERE ${VG}) tickets,
      (SELECT COALESCE(SUM(o.total_cents),0) FROM orders o WHERE ${VG}) value_cents,
      (SELECT MAX(o.created_at) FROM orders o WHERE ${VG}) last_at
    FROM volunteers v WHERE v.archived=0 ORDER BY v.name COLLATE NOCASE, v.id`).all({ from, to });
  function phoneTaken(phone, exceptId) {
    const row = q('SELECT id FROM volunteers WHERE phone=? AND archived=0').get(phone);
    return !!row && row.id !== exceptId;
  }
  function createVolunteer({ name, phone }) {
    const ph = normPhone(phone);
    if (!ph) throw new HttpError(400, 'BAD_PHONE', 'Phone number needs 10 digits');
    if (phoneTaken(ph)) throw new HttpError(409, 'PHONE_TAKEN', 'That phone number is already on the list');
    return q('INSERT INTO volunteers(name,phone,created_at) VALUES(?,?,?)').run(name || '', ph, now()).lastInsertRowid;
  }
  function updateVolunteer(id, p) {
    const v = q('SELECT * FROM volunteers WHERE id=? AND archived=0').get(id);
    if (!v) throw new HttpError(404, 'NOT_FOUND', 'Volunteer not found');
    let ph = v.phone;
    if (p.phone !== undefined) {
      ph = normPhone(p.phone);
      if (!ph) throw new HttpError(400, 'BAD_PHONE', 'Phone number needs 10 digits');
      if (phoneTaken(ph, id)) throw new HttpError(409, 'PHONE_TAKEN', 'That phone number is already on the list');
    }
    q('UPDATE volunteers SET name=?, phone=?, active=? WHERE id=?').run(p.name ?? v.name, ph, p.active === undefined ? v.active : (p.active ? 1 : 0), id);
  }
  const archiveVolunteer = (id) => q('UPDATE volunteers SET archived=1, active=0 WHERE id=?').run(id);
  // Paste a list: one volunteer per line, "Name, phone" or just the phone.
  const addVolunteersTx = db.transaction((rows) => {
    const added = [];
    const skipped = [];
    for (const { line, name, phone } of rows) {
      const ph = normPhone(phone);
      if (!ph) { skipped.push({ line, reason: 'no 10-digit phone number' }); continue; }
      if (phoneTaken(ph)) { skipped.push({ line, reason: 'already on the list' }); continue; }
      q('INSERT INTO volunteers(name,phone,created_at) VALUES(?,?,?)').run(name || '', ph, now());
      added.push(ph);
    }
    return { added: added.length, skipped };
  });
  const volunteerByPhone = (phone) => {
    const ph = normPhone(phone);
    return ph ? q('SELECT id,name,phone FROM volunteers WHERE phone=? AND archived=0 AND active=1').get(ph) : undefined;
  };

  // ---------- sessions ----------
  const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
  function createSession(kind, cashierId, ttlMs) {
    const token = crypto.randomBytes(32).toString('base64url');
    q('INSERT INTO sessions(token_hash,kind,cashier_id,created_at,expires_at) VALUES(?,?,?,?,?)').run(hashToken(token), kind, cashierId || null, now(), now() + ttlMs);
    return token;
  }
  function getSession(token, kind) {
    if (!token) return null;
    const s = q('SELECT * FROM sessions WHERE token_hash=? AND kind=? AND expires_at>?').get(hashToken(token), kind, now());
    if (!s) return null;
    if (kind === 'cashier') {
      const c = q('SELECT id,name FROM cashiers WHERE id=? AND active=1 AND archived=0').get(s.cashier_id);
      return c ? { cashier: c } : null;
    }
    return { admin: true };
  }
  const deleteSession = (token) => token && q('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
  const purgeSessions = () => q('DELETE FROM sessions WHERE expires_at<=?').run(now());

  // ---------- orders ----------
  const ORDER_COLS = 'id,client_ref,cashier_id,cashier_name,total_cents,item_count,cash_tendered_cents,created_at,voided_at,void_reason,kind,volunteer_id,volunteer_name';
  function loadOrder(id) {
    const o = q(`SELECT ${ORDER_COLS} FROM orders WHERE id=?`).get(id);
    if (!o) return null;
    o.lines = q('SELECT item_id,stall_id,item_name,stall_name,unit_price_cents,qty,line_total_cents FROM order_lines WHERE order_id=? ORDER BY id').all(id);
    o.refunds = q('SELECT ticket_no,item_name,stall_name,amount_cents,cashier_name,reason,created_at FROM refunds WHERE order_id=? ORDER BY ticket_no').all(id);
    return o;
  }

  // ---------- tickets and refunds ----------
  // Ticket n of an order is the n-th unit when its lines are laid out in id
  // order. The printer numbers tickets the same way (public/print.js).
  function ticketsOf(orderId) {
    const out = [];
    for (const l of q('SELECT id,item_id,stall_id,item_name,stall_name,unit_price_cents,qty FROM order_lines WHERE order_id=? ORDER BY id').all(orderId)) {
      for (let i = 0; i < l.qty; i++) out.push({ ticket_no: out.length + 1, line_id: l.id, item_id: l.item_id, stall_id: l.stall_id, item_name: l.item_name, stall_name: l.stall_name, amount_cents: l.unit_price_cents });
    }
    return out;
  }

  // Everything a cashier needs to see about one ticket before refunding it.
  function lookupTicket(orderId, ticketNo) {
    const code = `${orderId}-${ticketNo}`;
    const o = q('SELECT id,created_at,cashier_name,voided_at,kind FROM orders WHERE id=?').get(orderId);
    if (!o) return { code, order_id: orderId, ticket_no: ticketNo, status: 'not_found' };
    const all = ticketsOf(orderId);
    const t = all[ticketNo - 1];
    if (!t) return { code, order_id: orderId, ticket_no: ticketNo, status: 'not_found' };
    const base = { code, order_id: orderId, ticket_no: ticketNo, of: all.length, ...t, sold_at: o.created_at, sold_by: o.cashier_name };
    if (o.voided_at) return { ...base, status: 'voided' };
    if (o.kind === 'guest') return { ...base, status: 'guest' }; // no money was taken, so nothing to give back
    const r = q('SELECT cashier_name,created_at FROM refunds WHERE order_id=? AND ticket_no=?').get(orderId, ticketNo);
    if (r) return { ...base, status: 'refunded', refunded_by: r.cashier_name, refunded_at: r.created_at };
    return { ...base, status: 'ok' };
  }

  const insertRefund = q(`INSERT INTO refunds(order_id,ticket_no,line_id,item_id,stall_id,item_name,stall_name,amount_cents,cashier_id,cashier_name,batch_ref,reason,created_at)
                          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // All tickets in one refund succeed together or not at all. batch_ref makes a
  // retried request (double tap, dropped connection) return the first result.
  const refundTx = db.transaction((actor, { batch_ref, tickets, reason }) => {
    const prior = q('SELECT order_id,ticket_no,item_name,stall_name,amount_cents FROM refunds WHERE batch_ref=? ORDER BY id').all(batch_ref);
    if (prior.length) return { refunds: prior, total_cents: prior.reduce((s, r) => s + r.amount_cents, 0), duplicate: true };
    const seen = new Set();
    const ok = [];
    const problems = [];
    for (const { order_id, ticket_no } of tickets) {
      const key = `${order_id}-${ticket_no}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = lookupTicket(order_id, ticket_no);
      (t.status === 'ok' ? ok : problems).push(t);
    }
    if (problems.length) throw new HttpError(409, 'TICKET_PROBLEM', 'Some tickets cannot be refunded', { tickets: problems });
    if (!ok.length) throw new HttpError(400, 'BAD_REQUEST', 'No tickets to refund');
    const at = now();
    for (const t of ok) insertRefund.run(t.order_id, t.ticket_no, t.line_id, t.item_id, t.stall_id, t.item_name, t.stall_name, t.amount_cents, actor.id, actor.name, batch_ref, reason || null, at);
    return { refunds: ok, total_cents: ok.reduce((s, t) => s + t.amount_cents, 0), duplicate: false };
  });
  const refundTickets = (actor, body) => refundTx.immediate(actor, body);

  const getItemForSale = q(`SELECT i.id,i.name,i.price_cents,i.available,i.archived,s.id stall_id,s.name stall_name,s.active stall_active,s.archived stall_archived
                            FROM items i JOIN stalls s ON s.id=i.stall_id WHERE i.id=?`);
  const insertOrder = q('INSERT INTO orders(client_ref,cashier_id,cashier_name,total_cents,item_count,cash_tendered_cents,created_at,kind,volunteer_id,volunteer_name) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const insertLine = q('INSERT INTO order_lines(order_id,item_id,stall_id,item_name,stall_name,unit_price_cents,qty,line_total_cents) VALUES(?,?,?,?,?,?,?,?)');
  const orderByRef = q('SELECT id,cashier_id FROM orders WHERE client_ref=?');

  // One order = one atomic transaction. The client sends a unique client_ref
  // with each cart, so a retry after a dropped connection can never record
  // the same sale twice: the second attempt just gets the first order back.
  // A Guest service order passes guest_phone instead of cash. The volunteer is
  // checked inside the same transaction, so a volunteer switched off in the
  // admin a second earlier cannot slip through.
  const createOrderTx = db.transaction((cashier, { client_ref, lines, expected_total_cents, cash_tendered_cents, guest_phone }) => {
    const existing = orderByRef.get(client_ref);
    if (existing) {
      if (existing.cashier_id !== cashier.id) throw new HttpError(409, 'REF_CONFLICT', 'Order reference already used');
      return { order: loadOrder(existing.id), duplicate: true };
    }
    const guest = guest_phone != null;
    const volunteer = guest ? volunteerByPhone(guest_phone) : null;
    if (guest && !volunteer) throw new HttpError(404, 'VOLUNTEER_NOT_FOUND', 'That phone number is not on the volunteer list');
    const merged = new Map();
    for (const l of lines) merged.set(l.item_id, (merged.get(l.item_id) || 0) + l.qty);

    const resolved = [];
    const unavailable = [];
    let total = 0;
    let count = 0;
    for (const [itemId, qty] of merged) {
      const it = getItemForSale.get(itemId);
      if (!it || it.archived || !it.available || it.stall_archived || !it.stall_active) { unavailable.push(itemId); continue; }
      const lineTotal = it.price_cents * qty;
      total += lineTotal;
      count += qty;
      resolved.push([it, qty, lineTotal]);
    }
    if (unavailable.length) throw new HttpError(409, 'ITEM_UNAVAILABLE', 'Some items are no longer available', { item_ids: unavailable });
    // The cashier must have collected the amount we record. If a price moved
    // while the cart was open, reject and let the screen show the new total.
    // Guest orders take no money, so a price change does not matter for them.
    if (!guest && expected_total_cents !== total) throw new HttpError(409, 'PRICE_CHANGED', 'Prices changed. Check the new total.', { total_cents: total });
    if (cash_tendered_cents != null && cash_tendered_cents < total) throw new HttpError(400, 'TENDER_SHORT', 'Cash received is less than the total');

    const orderId = insertOrder.run(client_ref, cashier.id, cashier.name, total, count, guest ? null : (cash_tendered_cents ?? null), now(),
      guest ? 'guest' : 'sale', guest ? volunteer.id : null, guest ? (volunteer.name || volunteer.phone) : null).lastInsertRowid;
    for (const [it, qty, lineTotal] of resolved) insertLine.run(orderId, it.id, it.stall_id, it.name, it.stall_name, it.price_cents, qty, lineTotal);
    return { order: loadOrder(orderId), duplicate: false };
  });
  const createOrder = (cashier, body) => createOrderTx.immediate(cashier, body);

  const recentOrdersForCashier = (cashierId, limit = 12) =>
    q('SELECT id FROM orders WHERE cashier_id=? ORDER BY id DESC LIMIT ?').all(cashierId, limit).map((r) => loadOrder(r.id));

  function setVoid(id, voided, reason) {
    if (voided && q('SELECT 1 FROM refunds WHERE order_id=?').get(id)) {
      throw new HttpError(409, 'HAS_REFUNDS', 'Some tickets from this order were already refunded. Refund the remaining tickets instead of voiding.');
    }
    const r = q('UPDATE orders SET voided_at=?, void_reason=? WHERE id=?').run(voided ? now() : null, voided ? (reason || '') : null, id);
    if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
  }

  const REFUND_COUNT = '(SELECT COUNT(*) FROM refunds r WHERE r.order_id=o.id)';
  const REFUND_SUM = '(SELECT COALESCE(SUM(r.amount_cents),0) FROM refunds r WHERE r.order_id=o.id)';
  const LINE_SUMMARY = `(SELECT group_concat(l.qty || '× ' || l.item_name, ', ') FROM order_lines l WHERE l.order_id=o.id)`;
  function listOrders({ from, to, limit, offset, cashier_id, search, kind, volunteer_id }) {
    const where = ['o.created_at>=@from', 'o.created_at<@to'];
    const p = { from, to, limit, offset };
    if (cashier_id) { where.push('o.cashier_id=@cashier_id'); p.cashier_id = cashier_id; }
    if (kind) { where.push('o.kind=@kind'); p.kind = kind; }
    if (volunteer_id) { where.push('o.volunteer_id=@volunteer_id'); p.volunteer_id = volunteer_id; }
    if (search) { where.push('o.id=@search'); p.search = search; }
    const w = where.join(' AND ');
    const total = q(`SELECT COUNT(*) n FROM orders o WHERE ${w}`).get(p).n;
    const rows = q(`SELECT ${ORDER_COLS.split(',').map((c) => 'o.' + c).join(',')}, ${LINE_SUMMARY} summary, ${REFUND_COUNT} refunded, ${REFUND_SUM} refunded_cents
                    FROM orders o WHERE ${w} ORDER BY o.id DESC LIMIT @limit OFFSET @offset`).all(p);
    return { total, rows };
  }

  // ---------- reporting ----------
  function report({ from, to, bucketMin }) {
    const p = { from, to };
    // W = real cash sales. Guest service orders are counted separately (G) so
    // they never inflate sales or what a cashier should have in the drawer.
    const W = "o.voided_at IS NULL AND o.kind='sale' AND o.created_at>=@from AND o.created_at<@to";
    const G = "o.voided_at IS NULL AND o.kind='guest' AND o.created_at>=@from AND o.created_at<@to";
    const totals = q(`SELECT COUNT(*) orders, COALESCE(SUM(total_cents),0) sales_cents, COALESCE(SUM(item_count),0) items FROM orders o WHERE ${W}`).get(p);
    const voided = q('SELECT COUNT(*) orders, COALESCE(SUM(total_cents),0) sales_cents FROM orders o WHERE o.voided_at IS NOT NULL AND o.kind=\'sale\' AND o.created_at>=@from AND o.created_at<@to').get(p);
    const since = Date.now() - 15 * 60000;
    const last15 = q(`SELECT COUNT(*) orders, COALESCE(SUM(total_cents),0) sales_cents FROM orders o WHERE ${W} AND o.created_at>=@since`).get({ ...p, since });

    const byStall = q(`SELECT l.stall_id, COALESCE(s.name, MAX(l.stall_name)) name, COALESCE(s.color,'#64748b') color,
                              SUM(l.qty) qty, SUM(l.line_total_cents) sales_cents
                       FROM order_lines l JOIN orders o ON o.id=l.order_id LEFT JOIN stalls s ON s.id=l.stall_id
                       WHERE ${W} GROUP BY l.stall_id ORDER BY sales_cents DESC`).all(p);

    const byItem = q(`SELECT l.item_id, COALESCE(i.name, MAX(l.item_name)) name, COALESCE(s.name, MAX(l.stall_name)) stall, COALESCE(s.color,'#64748b') color,
                             SUM(l.qty) qty, SUM(l.line_total_cents) sales_cents
                      FROM order_lines l JOIN orders o ON o.id=l.order_id
                      LEFT JOIN items i ON i.id=l.item_id LEFT JOIN stalls s ON s.id=l.stall_id
                      WHERE ${W} GROUP BY l.item_id ORDER BY sales_cents DESC, qty DESC`).all(p);
    // include menu items that have not sold at all, so slow movers are visible
    const sold = new Set(byItem.map((r) => r.item_id));
    const unsold = q(`SELECT i.id item_id, i.name, s.name stall, s.color FROM items i JOIN stalls s ON s.id=i.stall_id
                      WHERE i.archived=0 AND s.archived=0 ORDER BY s.sort_order, i.sort_order`).all()
      .filter((r) => !sold.has(r.item_id)).map((r) => ({ ...r, qty: 0, sales_cents: 0 }));

    const byCashierSales = q(`SELECT o.cashier_id, COALESCE(c.name, MAX(o.cashier_name)) name, COUNT(*) orders,
                                SUM(o.total_cents) sales_cents, MAX(o.created_at) last_at
                         FROM orders o LEFT JOIN cashiers c ON c.id=o.cashier_id WHERE ${W}
                         GROUP BY o.cashier_id`).all(p);

    const bucket = bucketMin * 60000;
    const timeline = q(`SELECT (o.created_at / CAST(@bucket AS INTEGER)) * CAST(@bucket AS INTEGER) t, COUNT(*) orders, SUM(o.total_cents) sales_cents
                        FROM orders o WHERE ${W} GROUP BY t ORDER BY t`).all({ ...p, bucket });

    const recent = q(`SELECT o.id,o.cashier_name,o.total_cents,o.item_count,o.created_at,o.voided_at,o.kind,o.volunteer_name, ${LINE_SUMMARY} summary, ${REFUND_COUNT} refunded
                      FROM orders o WHERE o.created_at>=@from AND o.created_at<@to ORDER BY o.id DESC LIMIT 12`).all(p);

    // Refunds count in the period they were paid out, because that is when
    // the cash left the drawer. Net = sales - refunds.
    const RW = 'r.created_at>=@from AND r.created_at<@to';
    const refundTotals = q(`SELECT COUNT(*) tickets, COALESCE(SUM(amount_cents),0) cents FROM refunds r WHERE ${RW}`).get(p);
    totals.refunds_cents = refundTotals.cents;
    totals.refunded_tickets = refundTotals.tickets;
    totals.net_cents = totals.sales_cents - refundTotals.cents;
    totals.net_items = totals.items - refundTotals.tickets;

    const subtract = (rows, keyCol, refundRows, extra) => {
      const map = new Map(rows.map((r) => [r[keyCol], r]));
      for (const rf of refundRows) {
        let row = map.get(rf.key);
        if (!row) { row = { [keyCol]: rf.key, ...extra(rf), qty: 0, sales_cents: 0 }; map.set(rf.key, row); rows.push(row); }
        row.qty -= rf.tickets; row.sales_cents -= rf.cents;
        row.refunded = (row.refunded || 0) + rf.tickets;
      }
      return rows;
    };
    subtract(byStall, 'stall_id', q(`SELECT r.stall_id key, COUNT(*) tickets, SUM(r.amount_cents) cents, MAX(r.stall_name) stall_name, COALESCE(s.color,'#64748b') color
                                     FROM refunds r LEFT JOIN stalls s ON s.id=r.stall_id WHERE ${RW} GROUP BY r.stall_id`).all(p),
      (rf) => ({ name: rf.stall_name, color: rf.color }));
    byStall.sort((a, b) => b.sales_cents - a.sales_cents);
    subtract(byItem, 'item_id', q(`SELECT r.item_id key, COUNT(*) tickets, SUM(r.amount_cents) cents, MAX(r.item_name) item_name, MAX(r.stall_name) stall_name, COALESCE(s.color,'#64748b') color
                                   FROM refunds r LEFT JOIN stalls s ON s.id=r.stall_id WHERE ${RW} GROUP BY r.item_id`).all(p),
      (rf) => ({ name: rf.item_name, stall: rf.stall_name, color: rf.color }));
    const soldAfter = new Set(byItem.map((r) => r.item_id));

    // Cash each cashier should hold: what they took in minus what they paid back.
    const cashierMap = new Map(byCashierSales.map((c) => [String(c.cashier_id), { ...c, refunds_cents: 0, refunded_tickets: 0 }]));
    for (const rf of q(`SELECT r.cashier_id, MAX(r.cashier_name) name, COUNT(*) tickets, SUM(r.amount_cents) cents, MAX(r.created_at) last_at
                        FROM refunds r WHERE ${RW} GROUP BY r.cashier_id`).all(p)) {
      const key = String(rf.cashier_id);
      let row = cashierMap.get(key);
      if (!row) { row = { cashier_id: rf.cashier_id, name: rf.cashier_id == null ? 'Admin' : rf.name, orders: 0, sales_cents: 0, last_at: rf.last_at, refunds_cents: 0, refunded_tickets: 0 }; cashierMap.set(key, row); }
      row.refunds_cents += rf.cents; row.refunded_tickets += rf.tickets;
      row.last_at = Math.max(row.last_at || 0, rf.last_at);
    }
    const byCashier = [...cashierMap.values()].map((c) => ({ ...c, cash_cents: c.sales_cents - c.refunds_cents })).sort((a, b) => b.cash_cents - a.cash_cents);

    const tl = new Map(timeline.map((b) => [b.t, b]));
    for (const rb of q(`SELECT (r.created_at / CAST(@bucket AS INTEGER)) * CAST(@bucket AS INTEGER) t, SUM(r.amount_cents) cents
                        FROM refunds r WHERE ${RW} GROUP BY t`).all({ ...p, bucket })) {
      const b = tl.get(rb.t);
      if (b) b.sales_cents -= rb.cents; else { const nb = { t: rb.t, orders: 0, sales_cents: -rb.cents }; tl.set(rb.t, nb); timeline.push(nb); }
    }
    timeline.sort((a, b) => a.t - b.t);

    const recentRefunds = q(`SELECT r.order_id, r.ticket_no, r.item_name, r.stall_name, r.amount_cents, r.cashier_name, r.created_at
                             FROM refunds r WHERE ${RW} ORDER BY r.id DESC LIMIT 10`).all(p);

    // ---- Guest service ----
    const guest = q(`SELECT COUNT(*) orders, COALESCE(SUM(item_count),0) tickets, COALESCE(SUM(total_cents),0) value_cents FROM orders o WHERE ${G}`).get(p);
    guest.byVolunteer = q(`SELECT o.volunteer_id, COALESCE(NULLIF(v.name,''), MAX(o.volunteer_name)) name, v.phone, COUNT(*) orders,
                                  SUM(o.item_count) tickets, SUM(o.total_cents) value_cents, MAX(o.created_at) last_at
                           FROM orders o LEFT JOIN volunteers v ON v.id=o.volunteer_id WHERE ${G}
                           GROUP BY o.volunteer_id ORDER BY tickets DESC`).all(p);
    const allItems = byItem.concat(unsold.filter((u) => !soldAfter.has(u.item_id)));
    const itemMap = new Map(allItems.map((r) => [r.item_id, r]));
    for (const g of q(`SELECT l.item_id, MAX(l.item_name) name, MAX(l.stall_name) stall, COALESCE(s.color,'#64748b') color, SUM(l.qty) qty
                       FROM order_lines l JOIN orders o ON o.id=l.order_id LEFT JOIN stalls s ON s.id=l.stall_id
                       WHERE ${G} GROUP BY l.item_id`).all(p)) {
      let row = itemMap.get(g.item_id);
      if (!row) { row = { item_id: g.item_id, name: g.name, stall: g.stall, color: g.color, qty: 0, sales_cents: 0 }; itemMap.set(g.item_id, row); allItems.push(row); }
      row.guest_qty = g.qty;
    }
    const stallMap = new Map(byStall.map((r) => [r.stall_id, r]));
    for (const g of q(`SELECT l.stall_id, MAX(l.stall_name) name, COALESCE(s.color,'#64748b') color, SUM(l.qty) qty
                       FROM order_lines l JOIN orders o ON o.id=l.order_id LEFT JOIN stalls s ON s.id=l.stall_id
                       WHERE ${G} GROUP BY l.stall_id`).all(p)) {
      let row = stallMap.get(g.stall_id);
      if (!row) { row = { stall_id: g.stall_id, name: g.name, color: g.color, qty: 0, sales_cents: 0 }; stallMap.set(g.stall_id, row); byStall.push(row); }
      row.guest_qty = g.qty;
    }
    for (const c of byCashier) c.guest_orders = 0;
    for (const g of q(`SELECT o.cashier_id, COUNT(*) n FROM orders o WHERE ${G} GROUP BY o.cashier_id`).all(p)) {
      const c = byCashier.find((x) => x.cashier_id === g.cashier_id);
      if (c) c.guest_orders = g.n;
    }

    return { generated_at: Date.now(), bucket_ms: bucket, totals, voided, last15, byStall, byItem: allItems, byCashier, timeline, recent, recentRefunds, guest };
  }

  function exportRows({ from, to }) {
    return q(`SELECT o.id order_id, o.created_at, o.cashier_name, l.stall_name, l.item_name, l.qty, l.unit_price_cents, l.line_total_cents,
                     o.total_cents order_total_cents, o.voided_at, o.kind, o.volunteer_name,
                     (SELECT COUNT(*) FROM refunds r WHERE r.line_id=l.id) refunded_qty,
                     (SELECT COALESCE(SUM(r.amount_cents),0) FROM refunds r WHERE r.line_id=l.id) refunded_cents
              FROM orders o JOIN order_lines l ON l.order_id=o.id
              WHERE o.created_at>=? AND o.created_at<? ORDER BY o.id, l.id`).all(from, to);
  }

  const resetSales = db.transaction(() => {
    q('DELETE FROM refunds').run();
    q('DELETE FROM order_lines').run();
    q('DELETE FROM orders').run();
    q("DELETE FROM sqlite_sequence WHERE name IN ('orders','order_lines','refunds')").run();
    seedOrderNumbers();
  });

  return {
    raw: db, getSettings, updateSettings, catalog,
    createStall, updateStall, archiveStall: (id) => archiveStall.immediate(id),
    reorderStalls: (ids) => reorder.immediate('stalls', ids), reorderItems: (ids) => reorder.immediate('items', ids),
    createItem, updateItem, archiveItem,
    listCashiers, createCashier, updateCashier: (id, p) => updateCashier.immediate(id, p), archiveCashier: (id) => archiveCashier.immediate(id), cashierByPin,
    createSession, getSession, deleteSession, purgeSessions,
    listVolunteers, createVolunteer, updateVolunteer, archiveVolunteer, addVolunteers: (rows) => addVolunteersTx.immediate(rows), volunteerByPhone, normPhone,
    createOrder, loadOrder, recentOrdersForCashier, setVoid, listOrders, report, exportRows, lookupTicket, refundTickets,
    resetSales: () => resetSales.immediate(),
  };
}

module.exports = { openDb, HttpError };
