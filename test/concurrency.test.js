'use strict';
// Load test: six cashiers ringing up orders at the same time against a real
// server and a throwaway database. Run with: npm test
//
// It checks that
//   - every accepted order is stored exactly once (no lost or doubled sales),
//   - retried requests (same order reference) never create a second order,
//   - order numbers are unique and gap-free,
//   - a price change in the middle of the rush is never recorded at the old price,
//   - the admin report adds up to exactly what the cashiers collected.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const CASHIERS = 6;
const ORDERS_EACH = Number(process.env.ORDERS_EACH) || 250;

function client() {
  let cookie = '';
  return async function call(method, url, body) {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_PASSWORD: 'test-admin', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(BASE + '/healthz')).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }

    const admin = client();
    assert.equal((await admin('POST', '/api/admin/login', { password: 'nope' })).status, 401);
    assert.equal((await admin('POST', '/api/admin/login', { password: 'test-admin' })).status, 200);

    // six cashiers, six PINs; duplicate PINs are refused
    const cashiers = [];
    for (let i = 0; i < CASHIERS; i++) {
      const pin = String(100000 + i * 1111);
      assert.equal((await admin('POST', '/api/admin/cashiers', { name: `Cashier ${i + 1}`, pin })).status, 201);
      const c = client();
      assert.equal((await c('POST', '/api/login', { pin })).status, 200);
      cashiers.push(c);
    }
    assert.equal((await admin('POST', '/api/admin/cashiers', { name: 'Dup', pin: '100000' })).status, 409);
    assert.equal((await client()('POST', '/api/login', { pin: '999999' })).status, 401);
    assert.equal((await client()('GET', '/api/menu')).status, 401);

    let menu = (await cashiers[0]('GET', '/api/menu')).json;
    let items = menu.stalls.flatMap((s) => s.items);
    const target = items[0];
    const price = () => Object.fromEntries(items.map((i) => [i.id, i.price_cents]));

    let collected = 0; let accepted = 0; let priceRejects = 0; let duplicates = 0; let ticketCount = 0;
    const ids = new Set();
    const perCashier = Array(CASHIERS).fill(0);

    async function sell(ci, n) {
      const call = cashiers[ci];
      const rnd = (k) => Math.floor(Math.random() * k);
      for (let i = 0; i < n; i++) {
        const ref = crypto.randomUUID();
        const lines = Array.from({ length: 1 + rnd(4) }, () => ({ item_id: items[rnd(items.length)].id, qty: 1 + rnd(3) }));
        for (let attempt = 0; attempt < 5; attempt++) {
          const p = price();
          const total = lines.reduce((s, l) => s + p[l.item_id] * l.qty, 0);
          const body = { client_ref: ref, lines, expected_total_cents: total, cash_tendered_cents: total + 500 };
          // one in five orders is sent twice at the same instant, like a double tap or a network retry
          const sends = i % 5 === 0 ? [call('POST', '/api/orders', body), call('POST', '/api/orders', body)] : [call('POST', '/api/orders', body)];
          const results = await Promise.all(sends);
          const ok = results.filter((r) => r.status === 200 || r.status === 201);
          if (ok.length) {
            assert.equal(results.filter((r) => r.status === 201).length, 1, 'exactly one request creates the order');
            duplicates += ok.length - 1;
            const o = ok[0].json.order;
            assert.equal(o.total_cents, total);
            assert.ok(!ids.has(o.id), 'order number issued twice');
            ids.add(o.id);
            collected += total; accepted++; perCashier[ci] += total;
            ticketCount += lines.reduce((s, l) => s + l.qty, 0);
            break;
          }
          assert.ok(results.every((r) => r.status === 409 && r.json.error === 'PRICE_CHANGED'), `unexpected response ${JSON.stringify(results[0])}`);
          priceRejects++;
          menu = (await call('GET', '/api/menu')).json;
          items = menu.stalls.flatMap((s) => s.items);
        }
      }
    }

    const started = Date.now();
    const rush = Promise.all(cashiers.map((_, ci) => sell(ci, ORDERS_EACH)));
    // admin raises a price twice while everyone is selling
    await new Promise((r) => setTimeout(r, 150));
    await admin('PATCH', `/api/admin/items/${target.id}`, { price_cents: target.price_cents + 100 });
    await new Promise((r) => setTimeout(r, 150));
    await admin('PATCH', `/api/admin/items/${target.id}`, { price_cents: target.price_cents + 250 });
    await rush;
    const secs = (Date.now() - started) / 1000;

    const rep = (await admin('GET', '/api/admin/report?bucket=15')).json;
    assert.equal(accepted, CASHIERS * ORDERS_EACH, 'every cart was eventually settled');
    assert.equal(rep.totals.orders, accepted, 'order count matches');
    assert.equal(rep.totals.sales_cents, collected, 'sales total matches cash collected');
    assert.equal(rep.totals.items, ticketCount, 'ticket count matches');
    assert.equal(rep.byStall.reduce((s, r) => s + r.sales_cents, 0), collected, 'stall totals add up');
    assert.equal(rep.byItem.reduce((s, r) => s + r.sales_cents, 0), collected, 'item totals add up');
    assert.equal(rep.timeline.reduce((s, r) => s + r.sales_cents, 0), collected, 'timeline adds up');
    assert.ok(rep.timeline.every((b) => b.t % rep.bucket_ms === 0), 'timeline buckets are aligned');
    assert.ok(rep.timeline.length <= 2, 'a few seconds of sales fall in one or two 15-minute buckets');
    for (let i = 0; i < CASHIERS; i++) {
      const row = rep.byCashier.find((r) => r.name === `Cashier ${i + 1}`);
      assert.equal(row.sales_cents, perCashier[i], `cashier ${i + 1} drawer matches`);
    }
    const sorted = [...ids].sort((a, b) => a - b);
    assert.equal(sorted[0], 1);
    assert.equal(sorted[sorted.length - 1], accepted, 'order numbers are gap-free');

    // sold-out item is refused
    await admin('PATCH', `/api/admin/items/${target.id}`, { available: false });
    const so = await cashiers[0]('POST', '/api/orders', { client_ref: crypto.randomUUID(), lines: [{ item_id: target.id, qty: 1 }], expected_total_cents: target.price_cents + 250 });
    assert.equal(so.status, 409); assert.equal(so.json.error, 'ITEM_UNAVAILABLE');

    // void removes an order from the totals, restore puts it back
    const first = (await admin('GET', '/api/admin/orders/1')).json.order;
    await admin('POST', '/api/admin/orders/1/void', { reason: 'test' });
    assert.equal((await admin('GET', '/api/admin/report')).json.totals.sales_cents, collected - first.total_cents);
    await admin('POST', '/api/admin/orders/1/restore');
    assert.equal((await admin('GET', '/api/admin/report')).json.totals.sales_cents, collected);

    // deactivating a cashier signs them out immediately
    const list = (await admin('GET', '/api/admin/catalog')).json.cashiers;
    await admin('PATCH', `/api/admin/cashiers/${list[5].id}`, { active: false });
    assert.equal((await cashiers[5]('GET', '/api/menu')).status, 401);

    console.log(`\nPASS  ${accepted} orders from ${CASHIERS} simultaneous cashiers in ${secs.toFixed(1)}s (${Math.round(accepted / secs)} orders/sec)`);
    console.log(`      $${(collected / 100).toFixed(2)} collected = $${(rep.totals.sales_cents / 100).toFixed(2)} in the report, ${ticketCount} tickets`);
    console.log(`      ${duplicates} duplicate submissions absorbed, ${priceRejects} stale-price orders rejected and re-rung\n`);
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('\nFAIL', e); process.exit(1); });
