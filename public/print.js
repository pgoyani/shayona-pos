'use strict';
// Ticket printing. One ticket per item unit: 2 Bhaji Pau + 1 Bhajiya = 3 tickets.
//
// Two ways to print:
//   'usb'     - the default. Talks to the receipt printer directly over USB
//               (ESC/POS) from Chrome or Edge, with a paper cut after every
//               ticket and no dialog. Falls back to 'browser' for that order
//               if the printer is unreachable.
//   'browser' - the normal browser print dialog. Works with any printer that
//               macOS can see. Each ticket is its own page. Used automatically
//               where the browser has no USB support.

const Printer = (() => {
  const LS_MODE = 'pos_print_mode';
  let usbDevice = null;
  let usbEndpoint = null;

  const usbSupported = () => 'usb' in navigator;
  // Direct USB unless this Mac was switched to the print dialog, or the browser cannot do USB.
  const mode = () => (usbSupported() && localStorage.getItem(LS_MODE) !== 'browser' ? 'usb' : 'browser');
  let onChange = () => {};
  const setMode = (m) => { localStorage.setItem(LS_MODE, m); onChange(); };

  // Ticket n of an order is the n-th unit when its lines are laid out in order.
  // The server numbers tickets the same way, so the code printed on a ticket
  // (order-ticket, e.g. 422-2) always identifies the same item for refunds.
  // Refunded tickets are left out, so a reprint can never revive them.
  function ticketsFor(order) {
    const out = [];
    for (const l of order.lines) for (let i = 0; i < l.qty; i++) out.push({ stall: l.stall_name, item: l.item_name, price_cents: l.unit_price_cents });
    out.forEach((t, i) => { t.n = i + 1; t.of = out.length; t.code = `${order.id}-${t.n}`; });
    const refunded = new Set((order.refunds || []).map((r) => r.ticket_no));
    return out.filter((t) => !refunded.has(t.n));
  }

  // The last slip of every order: what was ordered, prices and the total. It is
  // not a food ticket, and says so, so a stall never takes it for one.
  // Turned off in Admin > Settings. Test prints (order 0) get no summary.
  const wantsSummary = (order, settings) => settings.print_summary !== '0' && !!order.id && Array.isArray(order.lines) && order.lines.length > 0;
  function summaryOf(order) {
    const guest = order.kind === 'guest';
    const refunds = order.refunds || [];
    let pay;
    if (guest) pay = ['Guest service - no charge'];
    else if (order.payment === 'card') pay = ['Paid by card'];
    else if (order.cash_tendered_cents != null) pay = [`Cash received ${money(order.cash_tendered_cents)}`, `Change ${money(order.cash_tendered_cents - order.total_cents)}`];
    else pay = ['Paid in cash'];
    return {
      guest,
      lines: order.lines.map((l) => ({ qty: l.qty, name: l.item_name, amount: l.line_total_cents != null ? l.line_total_cents : l.unit_price_cents * l.qty })),
      total: order.total_cents,
      count: order.lines.reduce((s, l) => s + l.qty, 0),
      pay,
      refunded: refunds.length ? `Refunded: ${refunds.length} ticket${refunds.length === 1 ? '' : 's'}  -${money(refunds.reduce((s, r) => s + r.amount_cents, 0))}` : null,
    };
  }

  // Which scan code tickets carry: 'qr', 'barcode' or 'off' (Admin > Settings).
  const scanCode = (settings) => (settings.ticket_qr === '0' ? 'off' : settings.scan_code === 'barcode' ? 'barcode' : 'qr');
  // Code 128 barcode for 1D scanners, same text as the QR.
  function ticketBarcode(code) {
    if (typeof Code128 === 'undefined') return null;
    return h('div', { class: 't-barcode', innerHTML: Code128.svg('T:' + code, 40, 10) });
  }

  // QR with the ticket code, for scanning refunds. "T:" marks it as a ticket.
  // Only on browser-printed tickets. Turned off in Admin > Settings.
  function ticketQr(code) {
    if (typeof qrcode !== 'function') return null;
    const qr = qrcode(0, 'M');
    qr.addData('T:' + code, 'Alphanumeric');
    qr.make();
    return h('div', { class: 't-qr', innerHTML: qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true }) });
  }

  // Same date format on every computer, whatever its region or 24-hour setting: "Nov 8, 10:00 PM".
  const stamp = (ms) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

  // ----- browser printing -----
  function printBrowser(order, settings, reprint) {
    const width = settings.paper_width === '58' ? 58 : 80;
    const root = document.getElementById('print-root');
    root.className = 'w' + width;
    put(root, ...ticketsFor(order).map((t) =>
      h('div', { class: 'ticket' },
        h('div', { class: 't-event' }, settings.event_name),
        settings.print_stall !== '0' && h('div', { class: 't-stall' }, t.stall),
        h('div', { class: 't-item' }, t.item),
        settings.show_price_on_ticket === '1' && h('div', { class: 't-price' }, money(t.price_cents)),
        h('div', { class: 't-code-row' },
          h('div', {}, h('div', { class: 't-code-label' }, 'TICKET'), h('div', { class: 't-code' }, t.code)),
          scanCode(settings) === 'qr' ? ticketQr(t.code) : null),
        scanCode(settings) === 'barcode' ? ticketBarcode(t.code) : null,
        reprint && h('div', { class: 't-reprint' }, 'REPRINT'),
        h('div', { class: 't-meta' }, `${t.n} of ${t.of} in this order`),
        h('div', { class: 't-meta' }, `${stamp(order.created_at)}  ·  ${order.cashier_name}`),
        settings.refund_line && h('div', { class: 't-refund' }, settings.refund_line),
        settings.receipt_footer && h('div', { class: 't-footer' }, settings.receipt_footer))),
      wantsSummary(order, settings) && summaryBrowser(order, settings, reprint));
    // Size the page to the tallest ticket, so a long item name never spills
    // onto a second page and short tickets don't waste paper.
    // The summary gets its own page size, so a long order doesn't make every ticket long.
    root.classList.add('measuring');
    const mm = (el) => el.getBoundingClientRect().height * 25.4 / 96;
    const tallest = Math.max(...[...root.querySelectorAll('.ticket:not(.summary)')].map(mm), 0);
    const sum = root.querySelector('.summary');
    const sumMm = sum ? mm(sum) : 0;
    root.classList.remove('measuring');
    const pageMm = Math.max(60, Math.ceil(tallest + 4));
    document.getElementById('page-size').textContent = `@page { size: ${width}mm ${pageMm}mm; margin: 0; }`
      + (sum ? ` @page summary { size: ${width}mm ${Math.max(60, Math.ceil(sumMm + 4))}mm; margin: 0; }` : '');
    window.print();
  }

  function summaryBrowser(order, settings, reprint) {
    const s = summaryOf(order);
    return h('div', { class: 'ticket summary' },
      h('div', { class: 't-event' }, settings.event_name),
      h('div', { class: 's-title' }, 'ORDER SUMMARY'),
      h('div', { class: 's-sub' }, 'Not a food ticket'),
      reprint && h('div', { class: 't-reprint' }, 'REPRINT'),
      h('div', { class: 's-meta' }, h('span', {}, `Order #${order.id}`), h('span', {}, stamp(order.created_at))),
      h('div', { class: 's-meta' }, h('span', {}, `Cashier: ${order.cashier_name}`), order.preorder_code ? h('span', {}, `Pre-order ${order.preorder_code}`) : null),
      h('div', { class: 's-lines' }, s.lines.map((l) => h('div', { class: 's-line' }, h('span', {}, `${l.qty} x ${l.name}`), s.guest ? null : h('span', {}, money(l.amount))))),
      s.guest ? null : h('div', { class: 's-total' }, h('span', {}, `TOTAL (${s.count} item${s.count === 1 ? '' : 's'})`), h('span', {}, money(s.total))),
      h('div', { class: 's-pay' }, s.pay.map((p) => h('div', {}, p))),
      s.refunded && h('div', { class: 's-pay' }, s.refunded),
      settings.receipt_footer && h('div', { class: 't-footer' }, settings.receipt_footer));
  }

  // ----- direct USB (ESC/POS) -----
  const ESC = 0x1b; const GS = 0x1d; const LF = 0x0a;
  const ascii = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[·•]/g, '-').replace(/[^\x20-\x7e]/g, '?');
  function wrap(textIn, cols) {
    const lines = []; let cur = '';
    for (const word of ascii(textIn).split(' ')) {
      let w = word;
      while (w.length > cols) { if (cur) { lines.push(cur); cur = ''; } lines.push(w.slice(0, cols)); w = w.slice(cols); }
      if ((cur + ' ' + w).trim().length > cols) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
    }
    if (cur) lines.push(cur);
    return lines;
  }
  // Ways to tell the cutter to cut. Printers of this kind nearly all accept the
  // first one; the others are there in case a model does not.
  // feed = blank paper (in dots, 8 dots = 1 mm) under the last line before the cut.
  // The standard command moves the last line up to the blade by itself, so it
  // only needs a small margin. The others cut wherever the paper is, so the
  // last line first has to travel from the print head up to the blade (about 1.5 cm).
  const LS_CUT = 'pos_cut';
  const CUTS = {
    feed: { label: 'Standard (feed and cut)', bytes: [GS, 0x56, 0x42, 0x00], feed: 16 },
    partial: { label: 'Partial cut', bytes: [GS, 0x56, 0x01], feed: 160 },
    full: { label: 'Full cut', bytes: [GS, 0x56, 0x00], feed: 160 },
    legacy: { label: 'Older command set', bytes: [ESC, 0x69], feed: 160 },
    none: { label: 'No cut (tear by hand)', bytes: [], feed: 160 },
  };
  const cut = () => { try { const k = localStorage.getItem(LS_CUT); return CUTS[k] ? k : 'feed'; } catch (e) { return 'feed'; } };
  const setCut = (k) => { try { localStorage.setItem(LS_CUT, k); } catch (e) { /* private mode */ } };
  // Blank space at the end of each ticket, per computer. '' = automatic (the cut
  // command's own amount); otherwise millimetres.
  const LS_SPACE = 'pos_space';
  const SPACES = [['', 'Automatic'], ['0', 'None'], ['5', '5 mm'], ['10', '1 cm'], ['20', '2 cm']];
  const space = () => { try { const v = localStorage.getItem(LS_SPACE) || ''; return SPACES.some(([k]) => k === v) ? v : ''; } catch (e) { return ''; } };
  const setSpace = (v) => { try { v ? localStorage.setItem(LS_SPACE, v) : localStorage.removeItem(LS_SPACE); } catch (e) { /* private mode */ } };
  // Bytes that end a ticket: feed the blank space, then cut. ESC J feeds by dots
  // (at most 255 at a time) without printing a line.
  function endTicket(b) {
    const c = CUTS[cut()];
    let dots = space() === '' ? c.feed : Number(space()) * 8;
    while (dots > 0) { const n = Math.min(dots, 255); b.push(ESC, 0x4a, n); dots -= n; }
    b.push(...c.bytes);
  }

  // QR as a raster picture (GS v 0). Every ESC/POS printer can print a
  // picture, unlike the QR command, which varies by brand. The picture is only
  // as wide as the QR and is centred by the printer (ESC a 1), so it stays in
  // the middle whatever the real paper width is.
  // A centred picture of width x height dots; dark(x, y) says which dots are black.
  function raster(width, height, dark) {
    const wBytes = Math.ceil(width / 8);
    const out = [ESC, 0x61, 1, GS, 0x76, 0x30, 0, wBytes & 0xff, wBytes >> 8, height & 0xff, height >> 8];
    for (let y = 0; y < height; y++) {
      for (let xb = 0; xb < wBytes; xb++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) { const x = xb * 8 + bit; if (x < width && dark(x, y)) byte |= 0x80 >> bit; }
        out.push(byte);
      }
    }
    return out;
  }
  function qrRaster(text, cols) {
    if (typeof qrcode !== 'function') return [];
    const qr = qrcode(0, 'M');
    qr.addData(text, 'Alphanumeric');
    qr.make();
    const n = qr.getModuleCount();
    const scale = cols === 48 ? 6 : 5;                // dots per QR square: about 16mm (80mm paper) or 13mm (58mm)
    const quiet = 1;                                  // thin white border, in squares; the paper around it is white too
    const size = (n + quiet * 2) * scale;
    return raster(size, size, (x, y) => {
      const mx = Math.floor(x / scale) - quiet; const my = Math.floor(y / scale) - quiet;
      return my >= 0 && my < n && mx >= 0 && mx < n && qr.isDark(my, mx);
    });
  }
  // Code 128 barcode picture: 3 dots per bar (0.375 mm, easy for laser
  // scanners), 10 mm tall, with white space either side for the scanner.
  function barcodeRaster(text, cols) {
    if (typeof Code128 === 'undefined') return [];
    const bits = Code128.bits(text);
    const scale = 3;
    const quiet = cols === 48 ? 10 : 8;              // in bars; 58mm paper has room for 8
    const width = (bits.length + quiet * 2) * scale;
    return raster(width, 80, (x) => bits[Math.floor(x / scale) - quiet] === '1');
  }

  function escpos(order, settings, reprint) {
    const cols = settings.paper_width === '58' ? 32 : 48;
    const b = [];
    const size = (n) => b.push(GS, 0x21, n);           // 0x00 normal, 0x11 double width+height
    const bold = (on) => b.push(ESC, 0x45, on ? 1 : 0);
    const invert = (on) => b.push(GS, 0x42, on ? 1 : 0);
    const line = (s) => { for (const ch of s) b.push(ch.charCodeAt(0)); b.push(LF); };
    const block = (s, width) => wrap(s, width).forEach(line);
    // Item name as big as possible: one line if it fits, otherwise two lines
    // split between words so both halves are about the same length
    // ("Gulab Jamun" / "(2 pc)"). Never breaks inside a word.
    const twoLines = (text, width) => {
      const words = ascii(text).split(' ');
      let best = null;
      for (let k = 1; k < words.length; k++) {
        const a = words.slice(0, k).join(' '); const z = words.slice(k).join(' ');
        if (a.length <= width && z.length <= width && (!best || Math.max(a.length, z.length) < Math.max(best[0].length, best[1].length))) best = [a, z];
      }
      return best;
    };
    const itemName = (name) => {
      const text = ascii(name);
      for (const [w, ht] of [[3, 3], [2, 3]]) {
        if (text.length <= Math.floor(cols / w)) { size(((w - 1) << 4) | (ht - 1)); line(text); return; }
      }
      for (const [w, ht] of [[3, 3], [2, 3], [2, 2]]) {
        const pair = twoLines(text, Math.floor(cols / w));
        if (pair) { size(((w - 1) << 4) | (ht - 1)); pair.forEach(line); return; }
      }
      size(0x11); block(name, Math.floor(cols / 2));
    };
    // Stall name in the black band: same balanced split when it needs two lines.
    const stallBand = (name) => {
      const width = Math.floor(cols / 2) - 2;
      const lines = ascii(name).length <= width ? [ascii(name)] : (twoLines(name, width) || wrap(name, width));
      lines.forEach((l) => line(' ' + l + ' '));
    };
    b.push(ESC, 0x40);                                 // reset
    for (const t of ticketsFor(order)) {
      b.push(ESC, 0x61, 1);                            // center
      size(0x00); bold(false); block(settings.event_name, cols); b.push(LF);
      if (settings.print_stall !== '0') {            // stall name in a black band (Admin > Settings can turn it off)
        size(0x11); bold(true); invert(true); stallBand(t.stall); invert(false);
        b.push(LF);
      }
      // Item name in extra-large bold letters so the stall can read it at arm's length.
      bold(true);
      itemName(t.item);
      if (settings.show_price_on_ticket === '1') {
        b.push(ESC, 0x4a, 20);                         // small gap (about 2.5mm) under the big item name
        size(0x01); bold(true); line(money(t.price_cents)); bold(false);  // double height, bold
      }
      size(0x00); bold(true); b.push(LF); line('TICKET');
      size(0x11); line(t.code);                        // big and bold, plain (no black box)
      size(0x00); bold(false);
      if (scanCode(settings) === 'qr') b.push(...qrRaster('T:' + t.code, cols));
      if (scanCode(settings) === 'barcode') { b.push(LF); b.push(...barcodeRaster('T:' + t.code, cols)); }
      b.push(LF);
      if (reprint) { bold(true); line('** REPRINT **'); bold(false); }
      line(`${t.n} of ${t.of} in this order`);
      block(`${stamp(order.created_at)}  -  ${order.cashier_name}`, cols);
      if (settings.refund_line) { b.push(LF); block(settings.refund_line, cols); }
      if (settings.receipt_footer) block(settings.receipt_footer, cols);
      if (!order.id) {                                 // test print: show whether the paper width is right
        b.push(LF); line('-'.repeat(cols));
        block(`Paper width check (${cols === 48 ? '80' : '58'} mm): the dashes above should fill exactly one line. If they wrap onto two lines, choose 58 mm in the Printer box. If they cover only part of the paper, choose 80 mm.`, cols);
      }
      endTicket(b);                                    // small margin, then cut
    }
    if (wantsSummary(order, settings)) {
      const s = summaryOf(order);
      const pad = (left, right) => { const room = cols - right.length - 1; const ls = wrap(left, room); ls.forEach((l, i) => line(i === ls.length - 1 ? l.padEnd(cols - right.length) + right : l)); };
      const rule = () => line('-'.repeat(cols));
      b.push(ESC, 0x61, 1); size(0x00); bold(false); block(settings.event_name, cols);
      size(0x11); bold(true); line('ORDER SUMMARY'); size(0x00); bold(false);
      line('Not a food ticket');
      if (reprint) { bold(true); line('** REPRINT **'); bold(false); }
      b.push(ESC, 0x61, 0);                            // left
      rule();
      pad(`Order #${order.id}`, ascii(stamp(order.created_at)));
      pad(`Cashier: ${order.cashier_name}`, order.preorder_code ? `Pre-order ${order.preorder_code}` : '');
      rule();
      for (const l of s.lines) pad(`${l.qty} x ${l.name}`, s.guest ? '' : money(l.amount));
      rule();
      if (!s.guest) { bold(true); size(0x01); pad(`TOTAL (${s.count} item${s.count === 1 ? '' : 's'})`, money(s.total)); size(0x00); bold(false); }
      s.pay.forEach((p) => line(ascii(p)));
      if (s.refunded) line(ascii(s.refunded));
      b.push(ESC, 0x61, 1);
      if (settings.receipt_footer) { b.push(LF); block(settings.receipt_footer, cols); }
      endTicket(b);
    }
    return new Uint8Array(b);
  }

  async function openUsb(device) {
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    for (const iface of device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        const ep = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
        if (!ep) continue;
        await device.claimInterface(iface.interfaceNumber);
        usbDevice = device; usbEndpoint = ep.endpointNumber;
        return;
      }
    }
    throw new Error('That device does not look like a receipt printer');
  }
  // The most recent USB failure, kept so the Printer dialog can explain it.
  let lastError = null;
  function note(step, e) { lastError = { step, name: (e && e.name) || 'Error', message: (e && e.message) || String(e), at: Date.now() }; return e; }

  // Turn a browser USB error into what to do about it.
  function explain(err) {
    const e = err || lastError;
    if (!e) return '';
    const text = `${e.name} ${e.message}`.toLowerCase();
    if (e.name === 'NotFoundError' || text.includes('no device selected')) return 'No printer was picked. If the printer was not in the list, check that it is switched on and the USB cable is in, then try again.';
    if (text.includes('does not look like')) return 'The device you picked is not the receipt printer. Press Connect USB printer again and pick the printer.';
    if (e.name === 'SecurityError' || text.includes('access denied') || text.includes('claim')) return 'Chrome was refused access to the printer. Something else on this Mac is holding it. Remove the printer from System Settings > Printers & Scanners, close any other tab or app that prints to it, unplug it and plug it back in, then connect again.';
    if (text.includes('not connected')) return 'No approved printer is plugged in. Plug it in and switch it on, or press Connect USB printer.';
    if (e.name === 'NetworkError' || text.includes('transfer') || text.includes('disconnected')) return 'The printer stopped responding. Check power, the USB cable and the paper, then press Connect USB printer again.';
    return e.message;
  }

  async function connectUsb() {
    if (!('usb' in navigator)) throw new Error('Direct USB printing needs Chrome or Edge');
    try {
      const device = await navigator.usb.requestDevice({ filters: [] });
      await openUsb(device);
      lastError = null;
      onChange();
      return device.productName || 'USB printer';
    } catch (e) { throw note('connect', e); }
  }
  async function ensureUsb() {
    if (usbDevice && usbDevice.opened) return;
    usbDevice = null;
    const known = await navigator.usb.getDevices(); // printers this browser was already allowed to use
    let failed = null;
    for (const d of known) { try { await openUsb(d); return; } catch (e) { failed = note('reconnect', e); /* try the next one */ } }
    if (failed) throw failed; // an approved printer is there but would not open: report why
    throw note('reconnect', new Error('USB printer is not connected'));
  }
  async function printUsb(order, settings, reprint) {
    await ensureUsb();
    const data = escpos(order, settings, reprint);
    try {
      for (let i = 0; i < data.length; i += 4096) {
        const r = await usbDevice.transferOut(usbEndpoint, data.slice(i, i + 4096));
        if (r && r.status && r.status !== 'ok') throw new Error(`USB transfer ${r.status}`);
      }
    } catch (e) { throw note('send', e); }
    return data.length;
  }
  // For the test button: print over USB only, and report the real error instead of falling back.
  async function printUsbOnly(order, settings) {
    try { return await printUsb(order, withPaper(settings), false); } catch (e) { usbDevice = null; onChange(); throw e; }
  }

  // Everything worth knowing when printing misbehaves, as text that can be copied into a message.
  async function diagnostics(settings) {
    const hex = (n) => '0x' + n.toString(16).padStart(4, '0');
    const out = ['Food Stall POS printer details', `Time: ${new Date().toString()}`, `Browser: ${navigator.userAgent}`,
      `Page: ${location.origin} (secure: ${window.isSecureContext ? 'yes' : 'no'})`, `USB support in this browser: ${usbSupported() ? 'yes' : 'no'}`,
      `Print method: ${mode()}`, `Cut command: ${cut()}`, `Space at end: ${space() === '' ? 'automatic' : space() + ' mm'}`, `Paper width: ${settings ? withPaper(settings).paper_width : '?'} mm${paper() ? ' (set on this computer)' : ' (admin setting)'}`, `Connected now: ${usbStatus() || 'none'}`];
    if (usbSupported()) {
      const devices = await navigator.usb.getDevices().catch(() => []);
      out.push(`Approved USB devices: ${devices.length}`);
      for (const d of devices) {
        out.push(`- ${d.productName || 'unnamed'} | maker: ${d.manufacturerName || '?'} | vendor ${hex(d.vendorId)} product ${hex(d.productId)} | open: ${d.opened ? 'yes' : 'no'}`);
        for (const iface of (d.configuration ? d.configuration.interfaces : [])) {
          for (const alt of iface.alternates) {
            out.push(`    interface ${iface.interfaceNumber} class ${alt.interfaceClass}${alt.interfaceClass === 7 ? ' (printer)' : ''} claimed: ${iface.claimed ? 'yes' : 'no'} endpoints: ${alt.endpoints.map((e) => `${e.direction}/${e.type}/${e.endpointNumber}`).join(', ') || 'none'}`);
          }
        }
      }
    }
    out.push(lastError ? `Last error: [${lastError.step}] ${lastError.name}: ${lastError.message} (${new Date(lastError.at).toLocaleTimeString()})` : 'Last error: none');
    if (lastError) out.push(`Meaning: ${explain()}`);
    return out.join('\n');
  }

  // Paper width can be set per computer, because counters can have different
  // printers. Empty means use the admin setting.
  const LS_PAPER = 'pos_paper';
  const paper = () => { try { return localStorage.getItem(LS_PAPER) || ''; } catch (e) { return ''; } };
  const setPaper = (v) => { try { v ? localStorage.setItem(LS_PAPER, v) : localStorage.removeItem(LS_PAPER); } catch (e) { /* private mode */ } };
  const withPaper = (settings) => (paper() ? { ...settings, paper_width: paper() } : settings);

  // Returns the mode that actually printed.
  async function print(order, settingsIn, reprint) {
    const settings = withPaper(settingsIn);
    if (mode() === 'usb') {
      try { await printUsb(order, settings, reprint); return 'usb'; } catch (e) {
        usbDevice = null;
        onChange();
        toast('Receipt printer not connected. Using the print dialog for this order.', 'error');
      }
    }
    printBrowser(order, settings, reprint);
    return 'browser';
  }

  const usbStatus = () => (usbDevice && usbDevice.opened ? (usbDevice.productName || 'USB printer') : null);

  // Keep up with the cable: reconnect when an already-approved printer is plugged in, notice when it is pulled.
  if (usbSupported()) {
    navigator.usb.addEventListener('connect', () => { if (mode() === 'usb') ensureUsb().catch(() => {}).then(() => onChange()); });
    navigator.usb.addEventListener('disconnect', (e) => { if (e.device === usbDevice) usbDevice = null; onChange(); });
  }
  // Open an already-approved printer without asking. Resolves true when one is ready.
  const autoConnect = () => (mode() === 'usb' ? ensureUsb().then(() => true, () => false).then((ok) => { onChange(); return ok; }) : Promise.resolve(false));

  return { print, printUsbOnly, mode, setMode, connectUsb, ensureUsb, autoConnect, usbStatus, ticketsFor, usbSupported, explain, diagnostics, cut, setCut, CUTS, space, setSpace, SPACES, paper, setPaper, onChange: (fn) => { onChange = fn; }, _escpos: escpos };
})();
