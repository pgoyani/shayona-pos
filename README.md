# Food Stall POS

Cash-only point of sale for the mandir food stalls. Cashiers sign in with a
6-digit PIN, tap items, collect cash, and one ticket prints per item so the
customer can walk to each stall. The admin side manages stalls, items, prices
and cashiers, and shows sales live.

## Run it on a Mac

Needs Node.js 20 or newer (nodejs.org).

    npm install
    ADMIN_PASSWORD=pick-a-password npm start

- Cashier screen: http://localhost:3000/
- Admin: http://localhost:3000/admin

First steps in the admin:

1. **Menu**: the five stalls and items you see are samples. Rename, reprice, delete, add.
2. **Cashiers**: add each cashier with a 6-digit PIN.
3. **Settings**: event name, ticket footer, paper width (80 mm or 58 mm).
4. Ring up some test orders, then **Settings > Clear test sales** before the event.

## Hosting it

It is one Node process plus one database file. Two things matter:

1. **The database must sit on a persistent disk.** Set `DATA_DIR` to that disk.
   Many hosts wipe the normal filesystem on every restart or deploy. Without a
   persistent disk a restart would erase the sales.
2. **Run exactly one instance.** Do not turn on autoscaling or multiple
   replicas. One instance handles this event many times over.

Set `ADMIN_PASSWORD` in the host's environment settings. In production the
server refuses to start without it.

`Dockerfile` and `render.yaml` are included. On Render: New > Blueprint, point
it at the repository, enter `ADMIN_PASSWORD` when asked. Fly.io and Railway
work the same way with a volume mounted at `/data`. Check the host's current
pricing for persistent disks before choosing.

The host must serve the site over HTTPS (all of the above do).

Before the event, and once it is over, use **Settings > Download database
backup** to keep a copy of everything.

## Printing tickets (NetumScan USB receipt printer)

**Direct USB (default).** Chrome talks to the printer itself, cuts after every
ticket, and shows no dialog. Once per Mac: plug the printer in, click the
amber **Connect printer** button at the top of the cashier screen, then
**Connect USB printer**, and pick the printer. The button turns to **Printer
ready**. After that the Mac reconnects by itself, also when the cable is
unplugged and plugged back in. This needs Chrome or Edge and the HTTPS site
(or localhost). If macOS has the printer open through its own driver, Chrome
may not be able to claim it. Remove the printer from Printers & Scanners in
that case.

If the printer is not connected when an order is settled, that order falls
back to the browser print dialog so the customer still gets tickets.

**Browser print dialog.** Choose it under **Printer** on a Mac where direct
USB does not work. It works with any printer macOS can see. Install the
printer on the Mac first (System Settings > Printers & Scanners, using the
driver from the printer's maker). Each ticket is its own page, so in the
driver's options choose to cut after every page. To skip the dialog and print
straight away, quit Chrome and start it from Terminal with:

    open -a "Google Chrome" --args --kiosk-printing

Direct USB sends standard ESC/POS commands. It has not been tried on your
actual printer yet, so use **Print a test ticket** well before the event.

### If the printer does not work

Open **Printer** on the cashier screen and press **Print a test ticket**. It
prints two test tickets and the box under the options says what happened.

| What you see | What to do |
| --- | --- |
| Printer is not in Chrome's list | Check power and cable. Look for it under Apple menu > About This Mac > More Info > System Report > USB. If it is not there, try another cable or port. |
| "Chrome was refused access" | macOS is holding the printer. Remove it from System Settings > Printers & Scanners, unplug, plug back in, connect again. |
| Test says sent, nothing prints | Paper in backwards (thermal side must face the print head), cover not closed, or the wrong device was picked. |
| Tickets print but come out as one strip | Open **Troubleshooting** and try the next **Cut command**, then test again. |
| Text prints as random symbols | The printer is not in ESC/POS mode. Switch that Mac to **Browser print dialog** and install the maker's driver. |
| Nothing above helps | Switch that Mac to **Browser print dialog**. Then press **Copy details** under Troubleshooting and send the text to whoever is helping. |

If printing fails mid-order the sale is still saved. Reprint from **Recent
orders** on the cashier screen. Reprints are marked REPRINT.

## Refunds

Every ticket has a code like `422-2` (order 422, ticket 2). Order numbers
start at 100.

1. The customer brings the unused ticket(s) to any cashier.
2. The cashier presses **Refund**, types each ticket code and presses Enter.
   The screen shows the item and the price paid, or why it can't be refunded
   (already refunded, order cancelled, no such ticket).
3. **Refund N tickets** saves it. Give the cash back and keep the paper
   tickets in a refund envelope, so they can't be used at a stall.

Each ticket can only be refunded once, even if two cashiers try at the same
moment. Reprints leave out refunded tickets.

Without the paper ticket, an admin can refund from **Admin > Orders > Refund**.
Those count as "Admin", not against a cashier's drawer.

The dashboard shows net sales (sales minus refunds), and for each cashier the
cash their drawer should hold. An order with refunds can't be voided; refund
its remaining tickets instead.

## Guest service (free food for guests, through volunteers)

Volunteers on the list in **Admin > Guest service** can order free food for
guests at any cashier.

1. The cashier rings up the items as usual, then presses **Guest service**
   (under Cash collected) instead of taking cash.
2. The cashier types the volunteer's phone number and presses **Check number**.
   The screen shows only "Volunteer found" (never the name) or "not on the
   volunteer list".
3. **Print N tickets · no charge** prints the tickets. They are the same as
   paid tickets, so stalls treat them the same way.

Admin setup: add volunteers one at a time (name optional, phone required), or
**Paste a list** with one per line, such as `Ramesh Patel, 404-555-0101`.
Any phone format works, because only the last 10 digits are matched. Switch a
volunteer off to stop them at once, or remove them; their past orders stay.

Reporting:
- Guest service orders are never in sales, net, or any cashier's drawer. The
  dashboard has a Guest service tile and a by-volunteer card.
- The Items and Stalls views show "+N guest", so stalls see the full demand.
- The Guest service page lists each volunteer's orders, tickets, menu value
  and last order for the chosen day. **Orders** opens that volunteer's orders.
- The CSV export has `type` and `volunteer` columns.

Guest tickets can't be refunded for cash. An admin can void a guest order made
by mistake.

## How concurrent cashiers are handled

- Every order is written in a single database transaction, so two cashiers
  settling at the same instant can never corrupt or lose each other's sale.
- Each cart carries a unique reference. If the connection drops and the
  cashier presses the button again, the server returns the order it already
  saved and does not create a second one.
- The server prices the order itself. If a price changed or an item sold out
  while the cart was open, the order is refused and the screen shows the new
  total, so the cash collected always matches what is recorded.
- Menu and price changes reach every cashier screen in about a second.

`npm test` starts a throwaway server and has six cashiers ring up 1,500 orders
at once, with double submissions and mid-rush price changes, then checks the
report matches the cash collected to the cent.

## Files

    server.js      web server and API
    db.js          database schema, order transaction, reports
    public/        cashier screen (index.html, pos.js, print.js) and admin (admin.html, admin.js)
    test/          concurrency test
    data/pos.db    the database (created on first run)

## Good to know

- Internet at the venue is the single point of failure for a hosted site. As a
  fallback, run `npm start` on one Mac and have the other Macs open
  `http://<that-mac's-ip>:3000` over the same Wi-Fi. Those other Macs use the
  browser print dialog automatically, since direct USB needs HTTPS or localhost.
- Voiding an order (Admin > Orders) removes it from the totals but keeps the record.
- Deleting a stall, item or cashier never deletes past sales.
- Cashier PINs cannot be viewed after saving. Set a new one if someone forgets.
