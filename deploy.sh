#!/usr/bin/env bash
# Food Stall POS - one script to install, update and look after the server.
#
#   ./deploy.sh            first run: asks a few questions, then starts everything
#                          later runs: rebuilds with the current code and restarts
#   ./deploy.sh backup     saves a copy of the database to pos-data/backups/
#   ./deploy.sh status     shows whether it is running
#   ./deploy.sh logs       follows the server log (Ctrl+C to stop watching)
#   ./deploy.sh stop       stops it (data is kept)
#   ./deploy.sh password   changes the admin password

set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

need_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed. On Ubuntu/Debian run: curl -fsSL https://get.docker.com | sudo sh"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose is missing. Install the docker-compose-plugin package."
  docker info >/dev/null 2>&1 || fail "Cannot talk to Docker. Run this with sudo, or add your user to the docker group."
}

env_get() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }

env_set() {  # env_set KEY VALUE  (rewrites the line, keeps the rest of .env)
  local tmp; tmp=$(mktemp)
  [ -f .env ] && grep -vE "^$1=" .env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  mv "$tmp" .env; chmod 600 .env
}

ask_password() {
  local p1 p2
  while true; do
    read -rsp "Admin password (at least 10 characters): " p1; echo
    [ ${#p1} -ge 10 ] || { echo "Too short, try again."; continue; }
    [[ "$p1" != *[[:space:]]* && "$p1" != *\'* ]] || { echo "No spaces or ' please, try again."; continue; }
    read -rsp "Type it again: " p2; echo
    [ "$p1" = "$p2" ] && break
    echo "They did not match, try again."
  done
  env_set ADMIN_PASSWORD "'$p1'"   # single quotes: Docker reads it literally, even with $ or #
}

first_setup() {
  say "First-time setup"
  echo "If this server should handle HTTPS itself, enter the domain that points here"
  echo "(for example pos.example.org). Ports 80 and 443 must be free and open."
  echo "Leave it empty if your hosting already provides HTTPS in front of this server;"
  echo "then point it at http://127.0.0.1:3000."
  read -rp "Domain: " domain
  domain=$(echo "$domain" | tr -d '[:space:]' | sed -E 's#^https?://##; s#/.*$##')
  ask_password
  env_set EVENT_TZ "${EVENT_TZ:-America/New_York}"
  if [ -n "$domain" ]; then
    env_set DOMAIN "$domain"
    env_set COMPOSE_PROFILES https
  else
    env_set COMPOSE_PROFILES ""
  fi
}

wait_healthy() {
  printf 'Waiting for the server to start'
  for _ in $(seq 1 40); do
    if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      echo " ok"; return 0
    fi
    printf '.'; sleep 2
  done
  echo; docker compose logs --tail 30 app
  fail "The server did not start. The log above usually says why."
}

do_backup() {
  mkdir -p pos-data/backups
  local name="pos-$(date +%Y%m%d-%H%M%S).db"
  docker compose exec -T app node -e "
    const D = require('better-sqlite3');
    const db = new D('/data/pos.db', { readonly: true });
    db.backup('/data/backups/$name').then(() => { db.close(); }).catch((e) => { console.error(e.message); process.exit(1); });
  " || fail "Backup failed. Is the server running? (./deploy.sh status)"
  echo "Saved pos-data/backups/$name"
  # keep the newest 200 backups
  ls -1t pos-data/backups/pos-*.db 2>/dev/null | tail -n +201 | xargs -r rm -f || true
}

show_address() {
  local domain; domain=$(env_get DOMAIN)
  if [ -n "$domain" ] && [ "$(env_get COMPOSE_PROFILES)" = "https" ]; then
    echo "Cashier screen: https://$domain/"
    echo "Admin:          https://$domain/admin"
    echo "The certificate can take a minute on the very first start."
  else
    echo "Running on http://127.0.0.1:3000 on this server."
    echo "Point your hosting's HTTPS proxy at it. It must pass X-Forwarded-Proto"
    echo "and must not buffer /api/events and /api/admin/events."
  fi
}

cmd=${1:-up}
need_docker
mkdir -p pos-data

case "$cmd" in
  up|update|start)
    [ -f .env ] && [ -n "$(env_get ADMIN_PASSWORD)" ] || first_setup
    if [ -f pos-data/pos.db ]; then say "Backing up before the update"; ( do_backup ) 2>/dev/null || echo "(skipped, server not running)"; fi
    say "Building and starting"
    docker compose up -d --build --remove-orphans
    wait_healthy
    say "Food Stall POS is running"
    show_address
    ;;
  backup)   do_backup ;;
  status)   docker compose ps; echo; show_address ;;
  logs)     docker compose logs -f --tail 100 app ;;
  stop)     docker compose stop; echo "Stopped. Data is kept in pos-data/." ;;
  password) ask_password; docker compose up -d --force-recreate app; wait_healthy; echo "Admin password changed." ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
