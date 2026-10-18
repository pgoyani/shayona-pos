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

  function ticketsFor(order) {
    const out = [];
    for (const l of order.lines) for (let i = 0; i < l.qty; i++) out.push({ stall: l.stall_name, item: l.item_name, price_cents: l.unit_price_cents });
    out.forEach((t, i) => { t.n = i + 1; t.of = out.length; });
    return out;
  }

  const stamp = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // ----- browser printing -----
  function printBrowser(order, settings, reprint) {
    const width = settings.paper_width === '58' ? 58 : 80;
    document.getElementById('page-size').textContent = `@page { size: ${width}mm 70mm; margin: 0; }`;
    const root = document.getElementById('print-root');
    root.className = 'w' + width;
    put(root, ...ticketsFor(order).map((t) =>
      h('div', { class: 'ticket' },
        h('div', { class: 't-event' }, settings.event_name),
        h('div', { class: 't-stall' }, t.stall),
        h('div', { class: 't-item' }, t.item),
        settings.show_price_on_ticket === '1' && h('div', { class: 't-price' }, money(t.price_cents)),
        reprint && h('div', { class: 't-reprint' }, 'REPRINT'),
        h('div', { class: 't-meta' }, `Order #${order.id}  ·  Ticket ${t.n} of ${t.of}`),
        h('div', { class: 't-meta' }, `${stamp(order.created_at)}  ·  ${order.cashier_name}`),
        settings.receipt_footer && h('div', { class: 't-footer' }, settings.receipt_footer))));
    window.print();
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
  const LS_CUT = 'pos_cut';
  const CUTS = {
    feed: { label: 'Standard (feed and cut)', bytes: [GS, 0x56, 0x42, 0x00], feed: 4 },
    partial: { label: 'Partial cut', bytes: [GS, 0x56, 0x01], feed: 6 },
    full: { label: 'Full cut', bytes: [GS, 0x56, 0x00], feed: 6 },
    legacy: { label: 'Older command set', bytes: [ESC, 0x69], feed: 6 },
    none: { label: 'No cut (tear by hand)', bytes: [], feed: 6 },
  };
  const cut = () => (CUTS[localStorage.getItem(LS_CUT)] ? localStorage.getItem(LS_CUT) : 'feed');
  const setCut = (k) => localStorage.setItem(LS_CUT, k);

  function escpos(order, settings, reprint) {
    const cutter = CUTS[cut()];
    const cols = settings.paper_width === '58' ? 32 : 48;
    const b = [];
    const size = (n) => b.push(GS, 0x21, n);           // 0x00 normal, 0x11 double width+height
    const bold = (on) => b.push(ESC, 0x45, on ? 1 : 0);
    const invert = (on) => b.push(GS, 0x42, on ? 1 : 0);
    const line = (s) => { for (const ch of s) b.push(ch.charCodeAt(0)); b.push(LF); };
    const block = (s, width) => wrap(s, width).forEach(line);
    b.push(ESC, 0x40);                                 // reset
    for (const t of ticketsFor(order)) {
      b.push(ESC, 0x61, 1);                            // center
      size(0x00); bold(false); block(settings.event_name, cols); b.push(LF);
      size(0x11); bold(true); invert(true); wrap(t.stall, cols / 2 - 2).forEach((l) => line(' ' + l + ' ')); invert(false);
      b.push(LF);
      block(t.item, cols / 2);
      if (settings.show_price_on_ticket === '1') { size(0x00); line(money(t.price_cents)); }
      size(0x00); bold(false); b.push(LF);
      if (reprint) { bold(true); line('** REPRINT **'); bold(false); }
      line(`Order #${order.id}  -  Ticket ${t.n} of ${t.of}`);
      block(`${stamp(order.created_at)}  -  ${order.cashier_name}`, cols);
      if (settings.receipt_footer) block(settings.receipt_footer, cols);
      b.push(ESC, 0x64, cutter.feed);                  // feed a few lines so the text clears the blade
      b.push(...cutter.bytes);                         // cut
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
    try { return await printUsb(order, settings, false); } catch (e) { usbDevice = null; onChange(); throw e; }
  }

  // Everything worth knowing when printing misbehaves, as text that can be copied into a message.
  async function diagnostics(settings) {
    const hex = (n) => '0x' + n.toString(16).padStart(4, '0');
    const out = ['Food Stall POS printer details', `Time: ${new Date().toString()}`, `Browser: ${navigator.userAgent}`,
      `Page: ${location.origin} (secure: ${window.isSecureContext ? 'yes' : 'no'})`, `USB support in this browser: ${usbSupported() ? 'yes' : 'no'}`,
      `Print method: ${mode()}`, `Cut command: ${cut()}`, `Paper width: ${settings ? settings.paper_width : '?'} mm`, `Connected now: ${usbStatus() || 'none'}`];
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

  // Returns the mode that actually printed.
  async function print(order, settings, reprint) {
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

  return { print, printUsbOnly, mode, setMode, connectUsb, ensureUsb, autoConnect, usbStatus, ticketsFor, usbSupported, explain, diagnostics, cut, setCut, CUTS, onChange: (fn) => { onChange = fn; }, _escpos: escpos };
})();
