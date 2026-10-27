'use strict';
// Load test against a running site (for example the live one before the event).
//
//   node test/live.js https://your-site.org --password YOUR_ADMIN_PASSWORD
//
// Options:
//   --cashiers 6     cashiers selling at the same time
//   --orders 120     orders each cashier rings up
//   --phones 150     phone pre-orders (stay under the site's limit of 400 per 5 minutes)
//   --force          run even if the site already has sales
//
// It never touches your real menu, prices or cashiers. It adds a "LOAD TEST"
// stall, test cashiers and a test volunteer, sells only test items, checks the
// numbers, then removes the stall, cashiers and volunteer again. The test orders
// stay in the sales until you press Admin > Settings > Clear test sales.

const crypto = require('crypto');

// ---------- options ----------
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const BASE = (argv.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/+$/, '');
const PASSWORD = opt('password', process.env.ADMIN_PASSWORD);
const CASHIERS = Number(opt('cashiers', 6));
const ORDERS_EACH = Number(opt('orders', 120));
const PHONES = Number(opt('phones', 150));
const FORCE = argv.includes('--force');
if (!BASE || !PASSWORD) {
  console.log('Usage: node test/live.js https://your-site.org --password ADMIN_PASSWORD [--cashiers 6] [--orders 120] [--phones 150] [--force]');
  process.exit(1);
}

// ---------- helpers ----------
const timings = {};
function client() {
  let cookie = '';
  const call = async (method, url, body, label) => {
    const t0 = performance.now();
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
        break;
      } catch (e) {
        if (attempt >= 2) throw new Error(`${method} ${url} failed: ${e.cause ? e.cause.code || e.cause.message : e.message}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const ms = performance.now() - t0;
    if (label) (timings[label] = timings[label] || []).push(ms);
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
  call.cookie = () => cookie;
  return call;
}
const rnd = (k) => Math.floor(Math.random() * k);
const money = (c) => '$' + (c / 100).toFixed(2);
const pool = async (n, width, fn) => { let next = 0; await Promise.all(Array.from({ length: Math.min(width, n) }, async () => { while (next < n) await fn(next++); })); };

const results = [];
function check(ok, what, detail) {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${!ok && detail ? `  (${detail})` : ''}`);
}
function must(r, status, what) {
  if (r.status !== status) throw new Error(`${what}: expected ${status}, got ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

// ---------- main ----------
async function main() {
  const tag = new Date().toISOString().slice(5, 19).replace(/[-:T]/g, '');
  console.log(`\nLive load test against ${BASE}\n`);

  const admin = client();
  const health = await fetch(BASE + '/healthz').then((r) => r.ok).catch(() => false);
  if (!health) throw new Error('The site did not answer /healthz. Check the address.');
  must(await admin('POST', '/api/admin/login', { password: PASSWORD }), 200, 'Admin sign-in');

  const ALL = '?from=0&to=8640000000000000&bucket=60';
  const before = must(await admin('GET', '/api/admin/report' + ALL), 200, 'Report');
  if (before.totals.orders > 0 && !FORCE) {
    console.log(`The site already has ${before.totals.orders} orders (${money(before.totals.sales_cents)}).`);
    console.log('If these are test orders, run again with --force. The test adds more test orders.');
    process.exit(1);
  }
  const settings = must(await admin('GET', '/api/admin/settings'), 200, 'Settings');

  // ---- set up test stall, cashiers, volunteer ----
  const made = { stall: null, cashiers: [], volunteer: null, reopened: false };
  const cleanup = async () => {
    console.log('\nCleaning up');
    for (const id of made.cashiers) await admin('DELETE', `/api/admin/cashiers/${id}`);
    if (made.volunteer) await admin('DELETE', `/api/admin/volunteers/${made.volunteer}`);
    if (made.stall) await admin('DELETE', `/api/admin/stalls/${made.stall}`);
    if (made.reopened) await admin('PUT', '/api/admin/settings', { preorders_enabled: false });
    console.log(`  removed the test stall, ${made.cashiers.length} test cashiers and the test volunteer${made.reopened ? ', and closed phone ordering again' : ''}`);
  };

  try {
    console.log('Setting up');
    made.stall = must(await admin('POST', '/api/admin/stalls', { name: `LOAD TEST ${tag}`, color: '#475569' }), 201, 'Create test stall').id;
    const prices = [100, 250, 400, 550, 700, 875];
    const itemIds = [];
    for (let i = 0; i < prices.length; i++) itemIds.push(must(await admin('POST', '/api/admin/items', { stall_id: made.stall, name: `Test item ${i + 1}`, price_cents: prices[i] }), 201, 'Create test item').id);
    const priceOf = Object.fromEntries(itemIds.map((id, i) => [id, prices[i]]));

    const cashiers = [];
    for (let i = 0; i < CASHIERS; i++) {
      for (let attempt = 0; ; attempt++) {
        const pin = String(100000 + crypto.randomInt(900000));
        const r = await admin('POST', '/api/admin/cashiers', { name: `LT${tag} Cashier ${i + 1}`, pin });
        if (r.status === 409 && attempt < 10) continue; // PIN already used by someone
        made.cashiers.push(must(r, 201, 'Create test cashier').id);
        const c = client();
        must(await c('POST', '/api/login', { pin }), 200, 'Test cashier sign-in');
        cashiers.push(c);
        break;
      }
    }
    let volPhone;
    for (let attempt = 0; ; attempt++) {
      volPhone = '555' + String(crypto.randomInt(10000000)).padStart(7, '0');
      const r = await admin('POST', '/api/admin/volunteers', { name: `LT${tag} Volunteer`, phone: volPhone });
      if (r.status === 409 && attempt < 10) continue;
      made.volunteer = must(r, 201, 'Create test volunteer').id;
      break;
    }
    if (settings.preorders_enabled !== '1') { await admin('PUT', '/api/admin/settings', { preorders_enabled: true }); made.reopened = true; }
    console.log(`  test stall with ${itemIds.length} items, ${CASHIERS} cashiers, 1 volunteer\n`);

    // live dashboard updates: count the events the admin screen would receive
    let liveEvents = 0;
    const ac = new AbortController();
    try {
      const es = await fetch(BASE + '/api/admin/events', { headers: { Cookie: admin.cookie() }, signal: ac.signal });
      (async () => { const rd = es.body.getReader(); const dec = new TextDecoder(); try { for (;;) { const { value, done } = await rd.read(); if (done) break; liveEvents += (dec.decode(value).match(/event: order/g) || []).length; } } catch (e) { /* stopped */ } })();
    } catch (e) { /* checked below */ }

    // ---- 1. rush: cashiers selling at once ----
    console.log(`1. ${CASHIERS} cashiers ringing up ${ORDERS_EACH} orders each at the same time`);
    const exp = { sales: Array(CASHIERS).fill(0), orders: Array(CASHIERS).fill(0), tickets: 0, guestOrders: 0, guestTickets: 0, ticketsList: [] };
    let dupes = 0; let errors = 0;
    const t1 = performance.now();
    await Promise.all(cashiers.map(async (call, ci) => {
      for (let i = 0; i < ORDERS_EACH; i++) {
        const lines = Array.from({ length: 1 + rnd(3) }, () => ({ item_id: itemIds[rnd(itemIds.length)], qty: 1 + rnd(3) }));
        const merged = new Map(); for (const l of lines) merged.set(l.item_id, (merged.get(l.item_id) || 0) + l.qty);
        const total = [...merged].reduce((s, [id, q]) => s + priceOf[id] * q, 0);
        const count = [...merged.values()].reduce((a, b) => a + b, 0);
        const guest = i % 8 === 5;
        const body = guest ? { client_ref: crypto.randomUUID(), lines, expected_total_cents: total, guest_phone: volPhone }
          : { client_ref: crypto.randomUUID(), lines, expected_total_cents: total, cash_tendered_cents: total + 500 };
        const sends = i % 5 === 0 ? [call('POST', '/api/orders', body, 'order'), call('POST', '/api/orders', body, 'order')] : [call('POST', '/api/orders', body, 'order')];
        const rs = await Promise.all(sends);
        const created = rs.filter((r) => r.status === 201);
        if (created.length !== 1 || rs.some((r) => r.status !== 200 && r.status !== 201)) { errors++; continue; }
        dupes += rs.length - 1;
        const o = created[0].json.order;
        if (guest) { exp.guestOrders++; exp.guestTickets += count; } else {
          exp.sales[ci] += total; exp.orders[ci]++; exp.tickets += count;
          for (let n = 1; n <= count; n++) exp.ticketsList.push({ order_id: o.id, ticket_no: n, price: o.lines.flatMap((l) => Array(l.qty).fill(l.unit_price_cents))[n - 1], ci });
        }
      }
    }));
    const rushSecs = (performance.now() - t1) / 1000;
    const rushOrders = CASHIERS * ORDERS_EACH;
    check(errors === 0, `${rushOrders} orders in ${rushSecs.toFixed(1)}s (${Math.round(rushOrders / rushSecs)}/sec), ${dupes} double taps absorbed`, `${errors} orders failed`);

    // ---- 2. phones ----
    console.log(`\n2. ${PHONES} phone pre-orders, then cashiers racing to pay them`);
    const phone = client();
    const pres = [];
    let preErrors = 0;
    await pool(PHONES, 25, async () => {
      const lines = Array.from({ length: 1 + rnd(3) }, () => ({ item_id: itemIds[rnd(itemIds.length)], qty: 1 + rnd(2) }));
      const merged = new Map(); for (const l of lines) merged.set(l.item_id, (merged.get(l.item_id) || 0) + l.qty);
      const total = [...merged].reduce((s, [id, q]) => s + priceOf[id] * q, 0);
      const r = await phone('POST', '/api/public/preorders', { client_ref: crypto.randomUUID(), lines, expected_total_cents: total }, 'phone submit');
      if (r.status !== 201) { preErrors++; if (preErrors === 1) console.log(`     first error: ${r.status} ${JSON.stringify(r.json)}`); return; }
      pres.push({ ...r.json.preorder, merged });
    });
    check(preErrors === 0, `${pres.length} pre-orders submitted`, `${preErrors} refused`);
    check(new Set(pres.map((p) => p.code)).size === pres.length, 'every pre-order got its own code');
    const racers = cashiers.slice(0, Math.min(3, CASHIERS));
    const paidOnce = new Map(); let doublePaid = 0; let refused = 0; let payErrors = 0;
    await Promise.all(racers.map(async (call, ci) => {
      for (const p of [...pres].sort(() => Math.random() - 0.5)) {
        const lines = [...p.merged].map(([item_id, qty]) => ({ item_id, qty }));
        const r = await call('POST', '/api/orders', { client_ref: crypto.randomUUID(), lines, expected_total_cents: p.total_cents, cash_tendered_cents: p.total_cents, preorder_id: p.id }, 'pre-order pay');
        if (r.status === 201) {
          if (paidOnce.has(p.id)) doublePaid++;
          paidOnce.set(p.id, ci); exp.sales[ci] += p.total_cents; exp.orders[ci]++; exp.tickets += p.item_count;
        } else if (r.status === 409 && r.json.error === 'PREORDER_PAID') refused++;
        else payErrors++;
      }
    }));
    check(doublePaid === 0 && paidOnce.size === pres.length && payErrors === 0, `each pre-order paid exactly once (${refused} second payments refused)`, `${doublePaid} paid twice, ${pres.length - paidOnce.size} never paid, ${payErrors} errors`);

    // ---- 3. refunds ----
    console.log('\n3. Cashiers refunding overlapping tickets at the same time');
    const tix = exp.ticketsList.sort(() => Math.random() - 0.5).slice(0, 80);
    const refundedBy = new Map(); const refundSum = Array(CASHIERS).fill(0); let rDouble = 0; let rErr = 0;
    await Promise.all(cashiers.map(async (call, ci) => {
      for (let k = 0; k < 30; k++) {
        const t = tix[rnd(tix.length)];
        const r = await call('POST', '/api/refunds', { batch_ref: crypto.randomUUID(), tickets: [{ order_id: t.order_id, ticket_no: t.ticket_no }] }, 'refund');
        const key = `${t.order_id}-${t.ticket_no}`;
        if (r.status === 201) { if (refundedBy.has(key)) rDouble++; refundedBy.set(key, ci); refundSum[ci] += t.price; } else if (!(r.status === 409 && r.json.tickets && r.json.tickets[0].status === 'refunded')) rErr++;
      }
    }));
    check(rDouble === 0 && rErr === 0, `${refundedBy.size} tickets refunded, none twice`, `${rDouble} refunded twice, ${rErr} errors`);

    // ---- 4. the numbers ----
    console.log('\n4. Checking the admin numbers');
    await new Promise((r) => setTimeout(r, 800));
    ac.abort();
    const after = must(await admin('GET', '/api/admin/report' + ALL), 200, 'Report');
    const testRefunds = refundSum.reduce((a, b) => a + b, 0);
    const testSales = exp.sales.reduce((a, b) => a + b, 0);
    for (let i = 0; i < CASHIERS; i++) {
      const row = after.byCashier.find((r) => r.cashier_id === made.cashiers[i]);
      check(!!row && row.cash_cents === exp.sales[i] - refundSum[i] && row.orders === exp.orders[i],
        `Cashier ${i + 1} drawer ${money(exp.sales[i] - refundSum[i])}`, row ? `report says ${money(row.cash_cents)}, ${row.orders} orders` : 'missing');
    }
    const st = after.byStall.find((s) => s.stall_id === made.stall);
    check(!!st && st.sales_cents === testSales - testRefunds, `test stall net sales ${money(testSales - testRefunds)}`, st ? `report says ${money(st.sales_cents)}` : 'missing');
    check(!!st && (st.guest_qty || 0) === exp.guestTickets, `${exp.guestTickets} Guest service tickets kept out of sales`, st ? `report says ${st.guest_qty || 0}` : '');
    const gv = (after.guest.byVolunteer || []).find((v) => v.volunteer_id === made.volunteer);
    check(!!gv && gv.orders === exp.guestOrders, `${exp.guestOrders} Guest service orders logged to the volunteer`, gv ? `report says ${gv.orders}` : 'missing');
    check(after.preorders.paid - before.preorders.paid === pres.length, `${pres.length} pre-orders show as paid`, `report says ${after.preorders.paid - before.preorders.paid}`);
    const dSales = after.totals.net_cents - before.totals.net_cents;
    check(dSales === testSales - testRefunds, `site net sales went up by exactly ${money(testSales - testRefunds)}`, `went up by ${money(dSales)}. Were real cashiers selling during the test?`);
    check(liveEvents > 0, `live dashboard updates arrived (${liveEvents} events)`, 'none arrived. Check the proxy passes /api/admin/events without buffering');

    // ---- speed ----
    console.log('\nSpeed over the internet (time per request)');
    for (const [k, arr] of Object.entries(timings)) {
      console.log(`  ${k.padEnd(14)} typical ${Math.round(pct(arr, 50))} ms   slowest 5% ${Math.round(pct(arr, 95))} ms   worst ${Math.round(Math.max(...arr))} ms   (${arr.length} requests)`);
    }
  } finally {
    await cleanup().catch((e) => console.log('  cleanup problem: ' + e.message));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\nFAIL  ${failed.length} of ${results.length} checks failed` : `\nPASS  all ${results.length} checks`);
  console.log('Test orders are still in the sales. Press Admin > Settings > Clear test sales before the event.\n');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('\nFAIL', e.message); process.exit(1); });
