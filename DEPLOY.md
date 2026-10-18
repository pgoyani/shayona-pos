# Deploying Food Stall POS on your own server

Two ways. **Option A (Docker)** is the easiest: one script does everything.
**Option B** sets it up by hand without Docker.

There is no separate database server either way. The app uses SQLite, a single
file it creates and manages itself.

# Option A: Docker (recommended)

## What the server needs

- Linux with Docker and Docker Compose. To install both on Ubuntu/Debian:

      curl -fsSL https://get.docker.com | sudo sh

- If the server should handle HTTPS itself: a domain or subdomain pointing to
  the server, and ports 80 and 443 open.
- If your hosting already puts HTTPS in front of the server (a control panel,
  load balancer or existing nginx), you only need the domain set up there.

## Install

Copy the zip to the server and unpack it:

    scp food-stall-pos.zip YOUR-USER@YOUR-SERVER:/tmp/
    ssh YOUR-USER@YOUR-SERVER
    sudo mkdir -p /opt/food-stall-pos
    sudo unzip -o /tmp/food-stall-pos.zip -d /opt/food-stall-pos
    cd /opt/food-stall-pos
    sudo ./deploy.sh

The script asks two things:

1. **Domain.** Enter it (for example `pos.example.org`) and the server gets a
   free HTTPS certificate automatically. Leave it empty if your hosting
   already provides HTTPS; then point that at `http://127.0.0.1:3000`. It must
   pass `X-Forwarded-Proto` and must not buffer `/api/events` and
   `/api/admin/events`.
2. **Admin password.** At least 10 characters, no spaces or `'`.

It then builds the app, starts it, waits until it answers, and prints the
address. Settings are saved in `.env` (readable only by root). The database
is in `pos-data/` next to the script.

It restarts by itself after a crash or a server reboot.

## Everyday commands

Run these from `/opt/food-stall-pos`:

| Command | What it does |
| --- | --- |
| `sudo ./deploy.sh` | Update: rebuild with the current code and restart. Backs up first. |
| `sudo ./deploy.sh backup` | Save a copy of the database to `pos-data/backups/` |
| `sudo ./deploy.sh status` | Is it running, and at what address |
| `sudo ./deploy.sh logs` | Watch the server log (Ctrl+C to stop watching) |
| `sudo ./deploy.sh stop` | Stop it. Data is kept. |
| `sudo ./deploy.sh password` | Change the admin password |

Automatic backup every 15 minutes:

    sudo crontab -e

and add:

    */15 * * * * cd /opt/food-stall-pos && ./deploy.sh backup >/dev/null 2>&1

The newest 200 backups are kept.

## Updating the code later

Unzip the new zip over the folder and run the script again:

    sudo unzip -o /tmp/food-stall-pos.zip -d /opt/food-stall-pos
    cd /opt/food-stall-pos && sudo ./deploy.sh

Sales and settings are untouched: `pos-data/` and `.env` are not in the zip.

## Restoring a backup

    sudo ./deploy.sh stop
    sudo cp pos-data/backups/pos-YYYYMMDD-HHMMSS.db pos-data/pos.db
    sudo rm -f pos-data/pos.db-wal pos-data/pos.db-shm
    sudo ./deploy.sh

A backup downloaded from Admin > Settings works the same way: copy it to
`pos-data/pos.db`.

Then continue with **Set up the system** further down.

# Option B: by hand, without Docker

## What the server needs

- Linux with **Node.js 20 or newer** (22 recommended)
- About 200 MB of RAM and 100 MB of disk
- A domain or subdomain pointing to the server
- HTTPS (a free Let's Encrypt certificate is fine)
- A **local** disk for the database (not a network drive)

There is no separate database server to install. The app uses SQLite, which
is a single file the app creates and manages itself.

## 1. Copy the zip to the server and unpack it

From your Mac:

    scp food-stall-pos.zip YOUR-USER@pos.example.org:/tmp/

On the server:

    sudo apt update && sudo apt install -y unzip
    sudo useradd --system --home /opt/food-stall-pos --shell /usr/sbin/nologin pos
    sudo mkdir -p /opt/food-stall-pos
    sudo unzip -o /tmp/food-stall-pos.zip -d /opt/food-stall-pos
    sudo chown -R pos:pos /opt/food-stall-pos

## 2. Install Node.js (skip if `node -v` already shows 20 or higher)

    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt install -y nodejs
    node -v

## 3. Install the app's packages

    cd /opt/food-stall-pos
    sudo -u pos npm ci --omit=dev

If this fails while building `better-sqlite3`, install build tools and run it
again:

    sudo apt install -y build-essential python3

## 4. Set up the database folder

The database lives outside the code folder, so updating the code never
touches sales data.

    sudo mkdir -p /var/lib/food-stall-pos
    sudo chown pos:pos /var/lib/food-stall-pos
    sudo chmod 700 /var/lib/food-stall-pos

That is all the database setup needed. On first start the app creates
`pos.db` in this folder, builds the tables, and adds a sample menu. You will
also see `pos.db-wal` and `pos.db-shm` next to it while it runs. Leave them.

## 5. Settings (passwords and paths)

Create `/etc/food-stall-pos.env`:

    sudo nano /etc/food-stall-pos.env

with:

    NODE_ENV=production
    PORT=3000
    DATA_DIR=/var/lib/food-stall-pos
    EVENT_TZ=America/New_York
    ADMIN_PASSWORD=pick-a-long-password-only-organisers-know

Then lock it down:

    sudo chmod 600 /etc/food-stall-pos.env

The app refuses to start without `ADMIN_PASSWORD`.

## 6. Run it as a service (starts on boot, restarts if it crashes)

Create `/etc/systemd/system/food-stall-pos.service`:

    [Unit]
    Description=Food Stall POS
    After=network.target

    [Service]
    User=pos
    WorkingDirectory=/opt/food-stall-pos
    EnvironmentFile=/etc/food-stall-pos.env
    ExecStart=/usr/bin/node server.js
    Restart=always
    RestartSec=2

    [Install]
    WantedBy=multi-user.target

Start it:

    sudo systemctl daemon-reload
    sudo systemctl enable --now food-stall-pos
    sudo systemctl status food-stall-pos
    curl http://127.0.0.1:3000/healthz

The last line should print `{"ok":true}`. Logs:

    sudo journalctl -u food-stall-pos -f

Run exactly **one** copy of the app. Do not use cluster mode or several
workers. All orders must go through one process.

## 7. HTTPS with nginx

    sudo apt install -y nginx certbot python3-certbot-nginx

Create `/etc/nginx/sites-available/food-stall-pos`:

    server {
        listen 80;
        server_name pos.example.org;

        location / {
            proxy_pass http://127.0.0.1:3000;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_read_timeout 3600s;
        }
    }

Turn it on and get the certificate:

    sudo ln -s /etc/nginx/sites-available/food-stall-pos /etc/nginx/sites-enabled/
    sudo nginx -t && sudo systemctl reload nginx
    sudo certbot --nginx -d pos.example.org

Certbot adds the HTTPS part and renews the certificate automatically.

Two details matter if your hosting uses something other than nginx (Apache,
a control panel, a load balancer):

- It must pass `X-Forwarded-Proto`. Sign-in cookies are marked secure based on it.
- It must not buffer `/api/events` and `/api/admin/events`. These keep a
  connection open to push live updates. The app already sends
  `X-Accel-Buffering: no`, which nginx respects.

Block port 3000 from outside so only nginx reaches the app:

    sudo ufw allow OpenSSH
    sudo ufw allow 'Nginx Full'
    sudo ufw enable

## 8. Check it works

- `https://pos.example.org/healthz` shows `{"ok":true}`
- `https://pos.example.org/admin` shows the admin sign-in
- `https://pos.example.org/` shows the cashier PIN screen

## 9. Set up the system

Your local test data does not carry over. In `/admin`:

1. **Menu:** replace the sample stalls and items with the real ones and prices.
2. **Cashiers:** add each cashier with a 6-digit PIN. Write the PINs down.
   They cannot be viewed later.
3. **Settings:** event name, ticket footer, paper width 80 mm.
4. Ring up a few test orders and watch the dashboard.
5. **Settings > Clear test sales:** type `RESET`. Order numbers restart at 1.
6. **Settings > Download database backup.**

## 10. Each cashier Mac

1. Use **Chrome** (or Edge). Safari cannot do direct USB printing.
2. If you set `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
   for local testing, set it back to **Default** and relaunch.
3. Make sure the receipt printer is **not** added in System Settings >
   Printers & Scanners.
4. Plug in the printer, open `https://pos.example.org`, sign in with a PIN.
5. Click **Connect printer**, then **Connect USB printer**, pick the printer.
6. Press **Print a test ticket**. Two separate, cut tickets means it is ready.

## Backups

Easiest: **Admin > Settings > Download database backup**, before and after
the event.

Automatic backups on the server every 15 minutes:

    sudo apt install -y sqlite3
    sudo mkdir -p /var/backups/food-stall-pos && sudo chown pos:pos /var/backups/food-stall-pos
    sudo crontab -u pos -e

and add:

    */15 * * * * sqlite3 /var/lib/food-stall-pos/pos.db ".backup '/var/backups/food-stall-pos/pos-$(date +\%H\%M).db'"

This keeps a rolling day of copies. Don't copy `pos.db` with `cp` while the
app is running; use one of the two methods above.

To restore a backup: stop the service, replace
`/var/lib/food-stall-pos/pos.db` with the backup file, delete `pos.db-wal` and
`pos.db-shm` if present, make sure `pos` owns the file, start the service.

## Updating the code later

    scp food-stall-pos.zip YOUR-USER@pos.example.org:/tmp/
    sudo unzip -o /tmp/food-stall-pos.zip -d /opt/food-stall-pos
    sudo chown -R pos:pos /opt/food-stall-pos
    cd /opt/food-stall-pos && sudo -u pos npm ci --omit=dev
    sudo systemctl restart food-stall-pos

Sales are untouched because they live in `/var/lib/food-stall-pos`. The
restart takes a few seconds. Cashier screens reconnect by themselves and keep
any order in progress. Don't update during the event.

## Event day

- **Before opening:** download a backup. Check every cashier Mac shows
  **Printer ready**.
- **During:** keep an eye on the live dashboard.
- **After closing:** **Orders > Export CSV** and a final database backup.

## If the server goes down during the event

1. On one Mac, rename the latest backup to `pos.db` and put it in the
   project's `data` folder.
2. Run `ADMIN_PASSWORD=your-password npm start` in the project folder.
3. Other Macs open `http://THAT-MAC-IP:3000`. For direct USB printing they
   need the Chrome flag above, set to that address.
