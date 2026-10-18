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
  void_reason TEXT
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
  const ORDER_COLS = 'id,client_ref,cashier_id,cashier_name,total_cents,item_count,cash_tendered_cents,created_at,voided_at,void_reason';
  function loadOrder(id) {
    const o = q(`SELECT ${ORDER_COLS} FROM orders WHERE id=?`).get(id);
    if (!o) return null;
    o.lines = q('SELECT item_id,stall_id,item_name,stall_name,unit_price_cents,qty,line_total_cents FROM order_lines WHERE order_id=? ORDER BY id').all(id);
    return o;
  }

  const getItemForSale = q(`SELECT i.id,i.name,i.price_cents,i.available,i.archived,s.id stall_id,s.name stall_name,s.active stall_active,s.archived stall_archived
                            FROM items i JOIN stalls s ON s.id=i.stall_id WHERE i.id=?`);
  const insertOrder = q('INSERT INTO orders(client_ref,cashier_id,cashier_name,total_cents,item_count,cash_tendered_cents,created_at) VALUES(?,?,?,?,?,?,?)');
  const insertLine = q('INSERT INTO order_lines(order_id,item_id,stall_id,item_name,stall_name,unit_price_cents,qty,line_total_cents) VALUES(?,?,?,?,?,?,?,?)');
  const orderByRef = q('SELECT id,cashier_id FROM orders WHERE client_ref=?');

  // One order = one atomic transaction. The client sends a unique client_ref
  // with each cart, so a retry after a dropped connection can never record
  // the same sale twice: the second attempt just gets the first order back.
  const createOrderTx = db.transaction((cashier, { client_ref, lines, expected_total_cents, cash_tendered_cents }) => {
    const existing = orderByRef.get(client_ref);
    if (existing) {
      if (existing.cashier_id !== cashier.id) throw new HttpError(409, 'REF_CONFLICT', 'Order reference already used');
      return { order: loadOrder(existing.id), duplicate: true };
    }
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
    if (expected_total_cents !== total) throw new HttpError(409, 'PRICE_CHANGED', 'Prices changed. Check the new total.', { total_cents: total });
    if (cash_tendered_cents != null && cash_tendered_cents < total) throw new HttpError(400, 'TENDER_SHORT', 'Cash received is less than the total');

    const orderId = insertOrder.run(client_ref, cashier.id, cashier.name, total, count, cash_tendered_cents ?? null, now()).lastInsertRowid;
    for (const [it, qty, lineTotal] of resolved) insertLine.run(orderId, it.id, it.stall_id, it.name, it.stall_name, it.price_cents, qty, lineTotal);
    return { order: loadOrder(orderId), duplicate: false };
  });
  const createOrder = (cashier, body) => createOrderTx.immediate(cashier, body);

  const recentOrdersForCashier = (cashierId, limit = 12) =>
    q('SELECT id FROM orders WHERE cashier_id=? ORDER BY id DESC LIMIT ?').all(cashierId, limit).map((r) => loadOrder(r.id));

  function setVoid(id, voided, reason) {
    const r = q('UPDATE orders SET voided_at=?, void_reason=? WHERE id=?').run(voided ? now() : null, voided ? (reason || '') : null, id);
    if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
  }

  const LINE_SUMMARY = `(SELECT group_concat(l.qty || '× ' || l.item_name, ', ') FROM order_lines l WHERE l.order_id=o.id)`;
  function listOrders({ from, to, limit, offset, cashier_id, search }) {
    const where = ['o.created_at>=@from', 'o.created_at<@to'];
    const p = { from, to, limit, offset };
    if (cashier_id) { where.push('o.cashier_id=@cashier_id'); p.cashier_id = cashier_id; }
    if (search) { where.push('o.id=@search'); p.search = search; }
    const w = where.join(' AND ');
    const total = q(`SELECT COUNT(*) n FROM orders o WHERE ${w}`).get(p).n;
    const rows = q(`SELECT ${ORDER_COLS.split(',').map((c) => 'o.' + c).join(',')}, ${LINE_SUMMARY} summary
                    FROM orders o WHERE ${w} ORDER BY o.id DESC LIMIT @limit OFFSET @offset`).all(p);
    return { total, rows };
  }

  // ---------- reporting ----------
  function report({ from, to, bucketMin }) {
    const p = { from, to };
    const W = 'o.voided_at IS NULL AND o.created_at>=@from AND o.created_at<@to';
    const totals = q(`SELECT COUNT(*) orders, COALESCE(SUM(total_cents),0) sales_cents, COALESCE(SUM(item_count),0) items FROM orders o WHERE ${W}`).get(p);
    const voided = q('SELECT COUNT(*) orders, COALESCE(SUM(total_cents),0) sales_cents FROM orders o WHERE o.voided_at IS NOT NULL AND o.created_at>=@from AND o.created_at<@to').get(p);
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

    const byCashier = q(`SELECT o.cashier_id, COALESCE(c.name, MAX(o.cashier_name)) name, COUNT(*) orders,
                                SUM(o.total_cents) sales_cents, MAX(o.created_at) last_at
                         FROM orders o LEFT JOIN cashiers c ON c.id=o.cashier_id WHERE ${W}
                         GROUP BY o.cashier_id ORDER BY sales_cents DESC`).all(p);

    const bucket = bucketMin * 60000;
    const timeline = q(`SELECT (o.created_at / CAST(@bucket AS INTEGER)) * CAST(@bucket AS INTEGER) t, COUNT(*) orders, SUM(o.total_cents) sales_cents
                        FROM orders o WHERE ${W} GROUP BY t ORDER BY t`).all({ ...p, bucket });

    const recent = q(`SELECT o.id,o.cashier_name,o.total_cents,o.item_count,o.created_at,o.voided_at, ${LINE_SUMMARY} summary
                      FROM orders o WHERE o.created_at>=@from AND o.created_at<@to ORDER BY o.id DESC LIMIT 12`).all(p);

    return { generated_at: Date.now(), bucket_ms: bucket, totals, voided, last15, byStall, byItem: byItem.concat(unsold), byCashier, timeline, recent };
  }

  function exportRows({ from, to }) {
    return q(`SELECT o.id order_id, o.created_at, o.cashier_name, l.stall_name, l.item_name, l.qty, l.unit_price_cents, l.line_total_cents,
                     o.total_cents order_total_cents, o.voided_at
              FROM orders o JOIN order_lines l ON l.order_id=o.id
              WHERE o.created_at>=? AND o.created_at<? ORDER BY o.id, l.id`).all(from, to);
  }

  const resetSales = db.transaction(() => {
    q('DELETE FROM order_lines').run();
    q('DELETE FROM orders').run();
    q("DELETE FROM sqlite_sequence WHERE name IN ('orders','order_lines')").run();
  });

  return {
    raw: db, getSettings, updateSettings, catalog,
    createStall, updateStall, archiveStall: (id) => archiveStall.immediate(id),
    reorderStalls: (ids) => reorder.immediate('stalls', ids), reorderItems: (ids) => reorder.immediate('items', ids),
    createItem, updateItem, archiveItem,
    listCashiers, createCashier, updateCashier: (id, p) => updateCashier.immediate(id, p), archiveCashier: (id) => archiveCashier.immediate(id), cashierByPin,
    createSession, getSession, deleteSession, purgeSessions,
    createOrder, loadOrder, recentOrdersForCashier, setVoid, listOrders, report, exportRows,
    resetSales: () => resetSales.immediate(),
  };
}

module.exports = { openDb, HttpError };
