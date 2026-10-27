'use strict';
// Load test: six cashiers ringing up orders at the same time against a real
// server and a throwaway database. Run with: npm test
//
// It checks that
//   - every accepted order is stored exactly once (no lost or doubled sales),
//   - retried requests (same order reference) never create a second order,
//   - order numbers are unique, gap-free and start at 100,
//   - a price change in the middle of the rush is never recorded at the old price,
//   - the admin report adds up to exactly what the cashiers collected,
//   - six cashiers refunding overlapping tickets at once refund each ticket
//     exactly once, and net sales and each drawer still add up to the cent,
//   - Guest service orders mixed into the rush are logged per volunteer and
//     never touch sales, drawers or refunds.

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
  const call = async function call(method, url, body) {
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
  call.cookie = () => cookie;
  return call;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_PASSWORD: 'test-admin', NODE_ENV: 'test', PREORDER_LIMIT: '100000' },
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

    // volunteers for Guest service: one added by hand, two pasted as a list
    assert.equal((await admin('POST', '/api/admin/volunteers', { name: 'Vol A', phone: '(555) 100-0001' })).status, 201);
    const bulk = (await admin('POST', '/api/admin/volunteers/bulk', { text: 'Vol B, 555-100-0002\n+1 555 100 0003\nVol A again 5551000001\nno number here' })).json;
    assert.equal(bulk.added, 2, JSON.stringify(bulk));
    assert.deepEqual(bulk.skipped.map((x) => x.reason), ['already on the list', 'no 10-digit phone number']);
    assert.equal((await admin('POST', '/api/admin/volunteers', { name: 'Dup', phone: '5551000002' })).status, 409);
    const VOL_PHONES = ['555-100-0001', '(555) 100 0002', '+15551000003']; // typed differently from how they were saved
    const vols = (await admin('GET', '/api/admin/volunteers')).json.volunteers;
    assert.equal(vols.length, 3);

    let menu = (await cashiers[0]('GET', '/api/menu')).json;
    let items = menu.stalls.flatMap((s) => s.items);
    const target = items[0];
    const price = () => Object.fromEntries(items.map((i) => [i.id, i.price_cents]));

    let collected = 0; let accepted = 0; let priceRejects = 0; let duplicates = 0; let ticketCount = 0;
    const ids = new Set();
    const orderInfo = new Map(); // order id -> price of each ticket, in ticket order
    const perCashier = Array(CASHIERS).fill(0);
    const guest = { orders: 0, tickets: 0, value: 0, perVol: [0, 0, 0], tickets_list: [] };

    async function sell(ci, n) {
      const call = cashiers[ci];
      const rnd = (k) => Math.floor(Math.random() * k);
      for (let i = 0; i < n; i++) {
        const ref = crypto.randomUUID();
        const lines = Array.from({ length: 1 + rnd(4) }, () => ({ item_id: items[rnd(items.length)].id, qty: 1 + rnd(3) }));
        if (i % 7 === 3) {
          // Guest service: a volunteer's phone instead of cash. A stale total is fine, no money changes hands.
          const vi = rnd(3);
          const body = { client_ref: ref, lines, expected_total_cents: 1, guest_phone: VOL_PHONES[vi] };
          const sends = i % 2 ? [call('POST', '/api/orders', body), call('POST', '/api/orders', body)] : [call('POST', '/api/orders', body)];
          const results = await Promise.all(sends);
          assert.ok(results.every((r) => r.status === 200 || r.status === 201), JSON.stringify(results[0].json));
          assert.equal(results.filter((r) => r.status === 201).length, 1, 'guest order created once');
          const o = results[0].json.order;
          assert.equal(o.kind, 'guest'); assert.equal(o.cash_tendered_cents, null);
          assert.ok(!ids.has(o.id)); ids.add(o.id);
          guest.orders++; guest.tickets += o.item_count; guest.value += o.total_cents; guest.perVol[vi] += o.item_count;
          guest.tickets_list.push(`${o.id}-1`);
          continue;
        }
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
            orderInfo.set(o.id, o.lines.flatMap((l) => Array(l.qty).fill(l.unit_price_cents)));
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
    assert.equal(accepted + guest.orders, CASHIERS * ORDERS_EACH, 'every cart was eventually settled');
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
    assert.equal(sorted[0], 100, 'order numbers start at 100');
    assert.equal(sorted[sorted.length - 1], 99 + accepted + guest.orders, 'order numbers are gap-free');

    // ---- Guest service: logged per volunteer, kept out of sales and drawers ----
    assert.ok(guest.orders > 100, 'plenty of guest orders were mixed into the rush');
    assert.equal(rep.guest.orders, guest.orders, 'guest order count');
    assert.equal(rep.guest.tickets, guest.tickets, 'guest ticket count');
    assert.equal(rep.guest.value_cents, guest.value, 'guest menu value');
    assert.equal(rep.byItem.reduce((s, r) => s + (r.guest_qty || 0), 0), guest.tickets, 'guest items add up');
    assert.equal(rep.byStall.reduce((s, r) => s + (r.guest_qty || 0), 0), guest.tickets, 'guest stall counts add up');
    assert.equal(rep.byCashier.reduce((s, r) => s + r.guest_orders, 0), guest.orders, 'guest orders per cashier add up');
    const volsAfter = (await admin('GET', '/api/admin/volunteers')).json.volunteers;
    for (let vi = 0; vi < 3; vi++) {
      const v = volsAfter.find((x) => x.phone === `555100000${vi + 1}`);
      assert.equal(v.tickets, guest.perVol[vi], `volunteer ${vi + 1} tickets`);
      assert.equal(rep.guest.byVolunteer.find((x) => x.volunteer_id === v.id).tickets, guest.perVol[vi]);
    }
    assert.deepEqual((await cashiers[0]('POST', '/api/guest/check', { phone: '555.100.0002' })).json, { found: true }, 'cashier learns only that the volunteer exists, never the name');
    assert.deepEqual((await cashiers[0]('POST', '/api/guest/check', { phone: '555-999-0000' })).json, { found: false });
    assert.equal((await cashiers[0]('POST', '/api/guest/check', { phone: '123' })).status, 400);
    const anyItem = items.find((it) => it.id !== target.id);
    const unknown = await cashiers[0]('POST', '/api/orders', { client_ref: crypto.randomUUID(), lines: [{ item_id: anyItem.id, qty: 1 }], expected_total_cents: 0, guest_phone: '5559990000' });
    assert.equal(unknown.status, 404); assert.equal(unknown.json.error, 'VOLUNTEER_NOT_FOUND');
    const volC = vols.find((x) => x.phone === '5551000003');
    await admin('PATCH', `/api/admin/volunteers/${volC.id}`, { active: false });
    assert.deepEqual((await cashiers[0]('POST', '/api/guest/check', { phone: '5551000003' })).json, { found: false }, 'switched-off volunteer is refused');
    assert.equal((await cashiers[0]('POST', '/api/orders', { client_ref: crypto.randomUUID(), lines: [{ item_id: anyItem.id, qty: 1 }], expected_total_cents: 0, guest_phone: '5551000003' })).status, 404);
    await admin('PATCH', `/api/admin/volunteers/${volC.id}`, { active: true });
    assert.equal((await cashiers[2]('GET', `/api/tickets/${guest.tickets_list[0]}`)).json.ticket.status, 'guest', 'guest ticket is recognised');
    const [go, gn] = guest.tickets_list[0].split('-').map(Number);
    const gr = await cashiers[2]('POST', '/api/refunds', { batch_ref: crypto.randomUUID(), tickets: [{ order_id: go, ticket_no: gn }] });
    assert.equal(gr.status, 409, 'guest tickets cannot be refunded for cash');
    const gl = (await admin('GET', `/api/admin/orders?kind=guest&limit=200&volunteer_id=${vols[0].id}`)).json;
    assert.ok(gl.rows.length > 0 && gl.rows.every((o) => o.kind === 'guest' && o.volunteer_id === vols[0].id), 'orders filter by volunteer');

    // ---- phone pre-orders: 300 phones submit at once, cashiers take the cash ----
    const phone = client(); // no sign-in
    const pubMenu = (await phone('GET', '/api/public/menu')).json;
    assert.ok(pubMenu.open && pubMenu.stalls.length, 'public menu is open');
    assert.ok(!pubMenu.stalls.some((s) => s.items.some((i) => i.id === undefined || 'available' in i)), 'public menu only lists what can be ordered');
    const pubItems = pubMenu.stalls.flatMap((s) => s.items);
    const pubPrice = Object.fromEntries(pubItems.map((i) => [i.id, i.price_cents]));
    const rndP = (k) => Math.floor(Math.random() * k);
    const pres = [];
    const preStart = Date.now();
    await Promise.all(Array.from({ length: 30 }, async (_, w) => {
      for (let k = 0; k < 10; k++) {
        const ref = crypto.randomUUID();
        const lines = Array.from({ length: 1 + rndP(3) }, () => ({ item_id: pubItems[rndP(pubItems.length)].id, qty: 1 + rndP(3) }));
        const merged = new Map(); for (const l of lines) merged.set(l.item_id, (merged.get(l.item_id) || 0) + l.qty);
        const total = [...merged].reduce((s, [id, q]) => s + pubPrice[id] * q, 0);
        const body = { client_ref: ref, lines, expected_total_cents: total };
        const rs = await Promise.all(k % 3 === 0 ? [phone('POST', '/api/public/preorders', body), phone('POST', '/api/public/preorders', body)] : [phone('POST', '/api/public/preorders', body)]);
        assert.equal(rs.filter((r) => r.status === 201).length, 1, `one pre-order per submit ${JSON.stringify(rs[0].json)}`);
        assert.ok(rs.every((r) => r.json.preorder.code === rs[0].json.preorder.code), 'a double tap returns the same code');
        assert.equal(rs[0].json.preorder.total_cents, total);
        pres.push({ ...rs[0].json.preorder, ref, merged });
      }
    }));
    const preSecs = (Date.now() - preStart) / 1000;
    assert.equal(new Set(pres.map((p) => p.code)).size, pres.length, 'every open pre-order has its own code');
    assert.ok(pres.every((p) => /^\d{4}$/.test(p.code)), 'codes are 4 digits');
    const stale = await phone('POST', '/api/public/preorders', { client_ref: crypto.randomUUID(), lines: [{ item_id: pubItems[0].id, qty: 1 }], expected_total_cents: pubItems[0].price_cents + 1 });
    assert.equal(stale.status, 409); assert.equal(stale.json.error, 'PRICE_CHANGED');
    let rp = (await admin('GET', '/api/admin/report')).json;
    assert.equal(rp.preorders.submitted, pres.length); assert.equal(rp.preorders.waiting, pres.length);
    assert.equal(rp.totals.sales_cents, collected, 'unpaid pre-orders are not sales');

    // two cashiers look up the same code: the second is told who has it, and can take over
    const [pa, pb] = [pres[0], pres[1]];
    assert.equal((await cashiers[0]('POST', '/api/preorders/claim', { code: pa.code })).json.status, 'ok');
    const second = (await cashiers[1]('POST', '/api/preorders/claim', { code: pa.code })).json;
    assert.equal(second.status, 'claimed'); assert.equal(second.claimed_by, 'Cashier 1');
    assert.equal((await cashiers[1]('POST', '/api/preorders/claim', { code: pa.code, take_over: true })).json.status, 'ok');
    assert.equal((await cashiers[2]('POST', '/api/preorders/claim', { code: '0000' })).json.status, 'not_found');
    // a customer who starts over cancels their code
    assert.equal((await phone('POST', `/api/public/preorders/${pb.code}/cancel`, { ref: pb.ref })).status, 200);
    assert.equal((await cashiers[2]('POST', '/api/preorders/claim', { code: pb.code })).json.status, 'cancelled');

    // every cashier tries to pay every pre-order at once: each one is paid exactly once
    const toPay = pres.filter((p) => p !== pb);
    let prePaid = 0; let preSales = 0; let doublePay = 0;
    const paidBy = new Map();
    await Promise.all(cashiers.slice(0, 5).map(async (call, ci) => {
      for (const p of [...toPay].sort(() => Math.random() - 0.5)) {
        const lines = [...p.merged].map(([item_id, qty]) => ({ item_id, qty }));
        const r = await call('POST', '/api/orders', { client_ref: crypto.randomUUID(), lines, expected_total_cents: p.total_cents, cash_tendered_cents: p.total_cents, preorder_id: p.id });
        if (r.status === 201) {
          assert.ok(!paidBy.has(p.id), `pre-order ${p.code} paid twice`);
          paidBy.set(p.id, ci); prePaid++; preSales += p.total_cents; perCashier[ci] += p.total_cents;
          assert.equal(r.json.order.preorder_code, p.code);
        } else {
          assert.equal(r.status, 409, JSON.stringify(r.json)); assert.equal(r.json.error, 'PREORDER_PAID'); doublePay++;
        }
      }
    }));
    assert.equal(prePaid, toPay.length, 'every pre-order was paid once');
    collected += preSales; accepted += prePaid;
    const st = (await phone('GET', `/api/public/preorders/${pa.code}?ref=${pa.ref}`)).json.preorder;
    assert.equal(st.status, 'paid'); assert.ok(st.order_id >= 100, 'the phone learns it was paid');
    assert.equal((await cashiers[3]('POST', '/api/preorders/claim', { code: pa.code })).json.status, 'paid', 'a paid code says so at the cashier');
    assert.equal((await phone('GET', `/api/public/preorders/${pa.code}?ref=${crypto.randomUUID()}`)).status, 404, 'a stranger cannot read someone else\'s order');
    rp = (await admin('GET', '/api/admin/report')).json;
    assert.equal(rp.preorders.paid, prePaid); assert.equal(rp.preorders.cancelled, 1); assert.equal(rp.preorders.waiting, 0);
    assert.equal(rp.preorders.orders, prePaid); assert.equal(rp.preorders.sales_cents, preSales);
    assert.equal(rp.totals.sales_cents, collected, 'paid pre-orders count as sales');
    // the admin can close phone ordering
    await admin('PUT', '/api/admin/settings', { preorders_enabled: false });
    assert.equal((await phone('GET', '/api/public/menu')).json.open, false);
    assert.equal((await phone('POST', '/api/public/preorders', { client_ref: crypto.randomUUID(), lines: [{ item_id: pubItems[0].id, qty: 1 }], expected_total_cents: pubItems[0].price_cents })).status, 403);
    await admin('PUT', '/api/admin/settings', { preorders_enabled: true });
    assert.equal((await phone('GET', '/api/admin/report')).status, 401, 'the public cannot see the admin');
    assert.equal((await phone('GET', '/api/menu')).status, 401, 'or the cashier menu');

    // ---- refunds: six cashiers refund overlapping tickets at the same moment ----
    const rnd = (k) => Math.floor(Math.random() * k);
    const allTickets = [];
    for (const [oid, prices] of orderInfo) prices.forEach((price, i) => allTickets.push({ order_id: oid, ticket_no: i + 1, price }));
    for (let i = allTickets.length - 1; i > 0; i--) { const j = rnd(i + 1); [allTickets[i], allTickets[j]] = [allTickets[j], allTickets[i]]; }
    const pool = allTickets.slice(0, 250);
    const refunded = new Map();
    const perCashierRefund = Array(CASHIERS).fill(0);
    let refundedCents = 0; let refundConflicts = 0;
    const rStart = Date.now();
    await Promise.all(cashiers.map(async (call, ci) => {
      for (let k = 0; k < 80; k++) {
        const t = pool[rnd(pool.length)];
        const r = await call('POST', '/api/refunds', { batch_ref: crypto.randomUUID(), tickets: [{ order_id: t.order_id, ticket_no: t.ticket_no }] });
        const key = `${t.order_id}-${t.ticket_no}`;
        if (r.status === 201) {
          assert.ok(!refunded.has(key), `ticket ${key} refunded twice`);
          refunded.set(key, ci);
          assert.equal(r.json.total_cents, t.price, 'refund pays the price on the ticket');
          refundedCents += t.price; perCashierRefund[ci] += t.price;
        } else {
          assert.equal(r.status, 409, JSON.stringify(r.json));
          assert.equal(r.json.tickets[0].status, 'refunded');
          refundConflicts++;
        }
      }
    }));
    const rSecs = (Date.now() - rStart) / 1000;

    // a multi-ticket refund sent twice at once is paid out once
    const fresh = allTickets.filter((t) => !refunded.has(`${t.order_id}-${t.ticket_no}`)).slice(0, 3);
    const batch = { batch_ref: crypto.randomUUID(), tickets: fresh.map(({ order_id, ticket_no }) => ({ order_id, ticket_no })) };
    const [b1, b2] = await Promise.all([cashiers[0]('POST', '/api/refunds', batch), cashiers[0]('POST', '/api/refunds', batch)]);
    assert.deepEqual([b1.status, b2.status].sort(), [200, 201], 'one creates, the retry returns the same refund');
    assert.equal(b1.json.total_cents, b2.json.total_cents);
    for (const t of fresh) { refunded.set(`${t.order_id}-${t.ticket_no}`, 0); refundedCents += t.price; perCashierRefund[0] += t.price; }

    // a refund with one bad ticket refunds nothing
    const okT = allTickets.find((t) => !refunded.has(`${t.order_id}-${t.ticket_no}`));
    const usedT = fresh[0];
    const mixed = await cashiers[1]('POST', '/api/refunds', { batch_ref: crypto.randomUUID(), tickets: [okT, usedT].map(({ order_id, ticket_no }) => ({ order_id, ticket_no })) });
    assert.equal(mixed.status, 409);
    assert.equal((await cashiers[1]('GET', `/api/tickets/${okT.order_id}-${okT.ticket_no}`)).json.ticket.status, 'ok', 'all or nothing');

    // ticket lookup
    assert.equal((await cashiers[1]('GET', `/api/tickets/${usedT.order_id}-${usedT.ticket_no}`)).json.ticket.status, 'refunded');
    assert.equal((await cashiers[1]('GET', `/api/tickets/${encodeURIComponent(`${okT.order_id} ${okT.ticket_no}`)}`)).json.ticket.status, 'ok', 'space works as separator');
    assert.equal((await cashiers[1]('GET', '/api/tickets/99999-1')).json.ticket.status, 'not_found');
    assert.equal((await cashiers[1]('GET', `/api/tickets/${okT.order_id}-999`)).json.ticket.status, 'not_found');
    assert.equal((await cashiers[1]('GET', '/api/tickets/abc')).status, 400);

    // an order with refunds cannot be voided; its record lists the refunded tickets
    const refundedOrder = usedT.order_id;
    const v = await admin('POST', `/api/admin/orders/${refundedOrder}/void`, { reason: 'test' });
    assert.equal(v.status, 409); assert.equal(v.json.error, 'HAS_REFUNDS');
    assert.ok((await admin('GET', `/api/admin/orders/${refundedOrder}`)).json.order.refunds.some((r) => r.ticket_no === usedT.ticket_no));

    // admin refund without the paper ticket counts against "Admin", not a cashier
    const adminT = allTickets.find((t) => !refunded.has(`${t.order_id}-${t.ticket_no}`));
    const ar = await admin('POST', `/api/admin/orders/${adminT.order_id}/refund`, { batch_ref: crypto.randomUUID(), ticket_nos: [adminT.ticket_no], reason: 'lost ticket' });
    assert.equal(ar.status, 200, JSON.stringify(ar.json));
    refunded.set(`${adminT.order_id}-${adminT.ticket_no}`, 'admin'); refundedCents += adminT.price;

    const rep2 = (await admin('GET', '/api/admin/report?bucket=15')).json;
    assert.equal(rep2.totals.sales_cents, collected, 'gross sales unchanged by refunds');
    assert.equal(rep2.totals.refunds_cents, refundedCents, 'refund total matches cash paid back');
    assert.equal(rep2.totals.refunded_tickets, refunded.size);
    assert.equal(rep2.totals.net_cents, collected - refundedCents, 'net = sales - refunds');
    assert.equal(rep2.byStall.reduce((s, r) => s + r.sales_cents, 0), rep2.totals.net_cents, 'stall net adds up');
    assert.equal(rep2.byItem.reduce((s, r) => s + r.sales_cents, 0), rep2.totals.net_cents, 'item net adds up');
    assert.equal(rep2.timeline.reduce((s, r) => s + r.sales_cents, 0), rep2.totals.net_cents, 'timeline net adds up');
    for (let i = 0; i < CASHIERS; i++) {
      const row = rep2.byCashier.find((r) => r.name === `Cashier ${i + 1}`);
      assert.equal(row.cash_cents, perCashier[i] - perCashierRefund[i], `cashier ${i + 1} drawer after refunds`);
    }
    assert.equal(rep2.byCashier.find((r) => r.name === 'Admin').refunds_cents, adminT.price);
    const csv = await fetch(BASE + '/api/admin/export.csv', { headers: { Cookie: admin.cookie() } }).then((r) => r.text());
    const csvRows = csv.trim().split('\r\n').slice(1).map((line) => line.split(','));
    const csvRefunded = csvRows.reduce((s, c) => s + (Number(c[12]) || 0), 0);
    assert.equal(csvRefunded, refunded.size, 'CSV lists every refunded ticket');
    assert.equal(csvRows.filter((c) => c[3] === 'guest service').reduce((s, c) => s + Number(c[7]), 0), guest.tickets, 'CSV marks guest service lines');

    // voiding a guest order changes the guest totals, never sales
    const gVoid = gl.rows[0];
    await admin('POST', `/api/admin/orders/${gVoid.id}/void`, {});
    const rep3 = (await admin('GET', '/api/admin/report')).json;
    assert.equal(rep3.guest.tickets, guest.tickets - gVoid.item_count);
    assert.equal(rep3.totals.net_cents, rep2.totals.net_cents);
    await admin('POST', `/api/admin/orders/${gVoid.id}/restore`);

    // sold-out item is refused
    await admin('PATCH', `/api/admin/items/${target.id}`, { available: false });
    const so = await cashiers[0]('POST', '/api/orders', { client_ref: crypto.randomUUID(), lines: [{ item_id: target.id, qty: 1 }], expected_total_cents: target.price_cents + 250 });
    assert.equal(so.status, 409); assert.equal(so.json.error, 'ITEM_UNAVAILABLE');

    // void removes an order from the totals, restore puts it back
    const cleanId = [...orderInfo.keys()].find((id) => ![...refunded.keys()].some((k) => k.startsWith(`${id}-`)));
    const first = (await admin('GET', `/api/admin/orders/${cleanId}`)).json.order;
    assert.equal((await admin('POST', `/api/admin/orders/${cleanId}/void`, { reason: 'test' })).status, 200);
    assert.equal((await admin('GET', '/api/admin/report')).json.totals.sales_cents, collected - first.total_cents);
    const vr = await cashiers[0]('POST', '/api/refunds', { batch_ref: crypto.randomUUID(), tickets: [{ order_id: cleanId, ticket_no: 1 }] });
    assert.equal(vr.json.tickets[0].status, 'voided', 'tickets of a voided order cannot be refunded');
    await admin('POST', `/api/admin/orders/${cleanId}/restore`);
    assert.equal((await admin('GET', '/api/admin/report')).json.totals.sales_cents, collected);

    // deactivating a cashier signs them out immediately
    const list = (await admin('GET', '/api/admin/catalog')).json.cashiers;
    await admin('PATCH', `/api/admin/cashiers/${list[5].id}`, { active: false });
    assert.equal((await cashiers[5]('GET', '/api/menu')).status, 401);

    console.log(`\nPASS  ${accepted} orders from ${CASHIERS} simultaneous cashiers in ${secs.toFixed(1)}s (${Math.round(accepted / secs)} orders/sec)`);
    console.log(`      $${(collected / 100).toFixed(2)} collected = $${(rep2.totals.sales_cents / 100).toFixed(2)} in the report, ${ticketCount} tickets`);
    console.log(`      ${duplicates} duplicate submissions absorbed, ${priceRejects} stale-price orders rejected and re-rung`);
    console.log(`      ${refunded.size} tickets refunded ($${(refundedCents / 100).toFixed(2)}) in ${rSecs.toFixed(1)}s by 6 cashiers at once, ${refundConflicts} double-refund attempts refused`);
    console.log(`      ${pres.length} phone pre-orders from 30 phones at once in ${preSecs.toFixed(1)}s, all with their own code; ${prePaid} paid by 5 cashiers racing, ${doublePay} double payments refused`);
    console.log(`      ${guest.orders} Guest service orders (${guest.tickets} free tickets) mixed in, logged per volunteer, kept out of sales and drawers`);
    console.log(`      net $${(rep2.totals.net_cents / 100).toFixed(2)} and every drawer reconcile to the cent\n`);
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('\nFAIL', e); process.exit(1); });
