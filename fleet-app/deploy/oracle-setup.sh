#!/usr/bin/env bash
# =============================================================================
# Fleet Driver Monitor – setup for an Oracle Cloud (OCI) Ubuntu VM.
# Safe on a server that already hosts other websites.
#
#   Run from inside the fleet-app folder on the VM:
#       sudo bash deploy/oracle-setup.sh driver-log.example.com
#       sudo bash deploy/oracle-setup.sh                 # no domain: <ip>.sslip.io
#
# What it does (safe to run again to update the app – data is kept):
#   1. Installs Node.js 22 (if missing) and runs the app as a systemd service
#      on a FREE local port (127.0.0.1 only), data in /var/lib/fleet
#   2. Detects the web server that already owns ports 80/443:
#        nginx  -> adds ONE new site file for this domain (other sites untouched)
#        caddy  -> adds ONE marked block to the Caddyfile (other sites untouched)
#        none   -> installs Caddy
#      Existing configs are backed up first, tested, and restored if the test fails.
#   3. HTTPS certificate:
#        - Cloudflare Origin Certificate, if saved to /etc/fleet-app/ssl/origin.pem + origin.key
#          (use with Cloudflare orange cloud + SSL mode "Full (strict)")
#        - otherwise a free Let's Encrypt certificate (needs Cloudflare grey cloud / DNS only)
#   4. Opens ports 80/443 in the VM firewall, daily backups to /var/backups/fleet
# =============================================================================
set -euo pipefail

APP_DIR=/opt/fleet-app
DATA_DIR=/var/lib/fleet
BACKUP_DIR=/var/backups/fleet
ENV_FILE=/etc/fleet-app.env
SSL_DIR=/etc/fleet-app/ssl
SERVICE=fleet-app
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33mWARNING: %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo:  sudo bash deploy/oracle-setup.sh your.domain"
[[ -f "$SRC_DIR/server.js" && -d "$SRC_DIR/public" ]] || die "server.js not found. Run this from the fleet-app folder."
command -v apt-get >/dev/null || die "This script supports Ubuntu. Create the VM with the 'Canonical Ubuntu' image."
export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- domain
PUBLIC_IP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com || curl -fsS --max-time 10 https://ifconfig.me || true)"
PUBLIC_IP="$(echo "$PUBLIC_IP" | tr -d '[:space:]')"
DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  [[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Could not detect the public IP. Pass a domain: sudo bash deploy/oracle-setup.sh your.domain"
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
fi
DOMAIN="$(echo "$DOMAIN" | tr 'A-Z' 'a-z' | sed -e 's#^https\?://##' -e 's#/.*$##')"
[[ "$DOMAIN" != *_* ]] || die "'$DOMAIN' contains an underscore (_), which web addresses cannot use. Try ${DOMAIN//_/-}"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "'$DOMAIN' is not a valid domain name."

CF_CERT="$SSL_DIR/origin.pem"; CF_KEY="$SSL_DIR/origin.key"
# Accept the location used by older versions of this script.
if [[ ! -s "$CF_CERT" && -s /etc/caddy/cloudflare-origin.pem && -s /etc/caddy/cloudflare-origin.key ]]; then
  mkdir -p "$SSL_DIR"; cp /etc/caddy/cloudflare-origin.pem "$CF_CERT"; cp /etc/caddy/cloudflare-origin.key "$CF_KEY"
fi
USE_CF_CERT=0
if [[ -s "$CF_CERT" && -s "$CF_KEY" ]]; then
  grep -q "BEGIN CERTIFICATE" "$CF_CERT" || die "$CF_CERT is not a certificate (must start with -----BEGIN CERTIFICATE-----)"
  grep -q "PRIVATE KEY" "$CF_KEY" || die "$CF_KEY is not a private key (must start with -----BEGIN PRIVATE KEY-----)"
  chmod 644 "$CF_CERT"; chmod 600 "$CF_KEY"
  USE_CF_CERT=1
fi

DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [[ -n "$PUBLIC_IP" && "$DNS_IP" != "$PUBLIC_IP" && $USE_CF_CERT -eq 0 ]]; then
  warn "$DOMAIN points to '${DNS_IP:-nothing}' but this server is $PUBLIC_IP.
  If it is a Cloudflare address (104.x / 172.6x.x), set the DNS record to 'DNS only' (grey cloud),
  or install a Cloudflare Origin Certificate (see deploy/ORACLE-CLOUD.md). Continuing anyway."
fi
say "Setting up https://$DOMAIN"

# ---------------------------------------------------------------- packages
say "Installing system packages"
apt-get update -y
apt-get install -y curl ca-certificates gnupg iptables-persistent iproute2

need_node=1
if command -v node >/dev/null; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' && need_node=0
fi
if [[ $need_node -eq 1 ]]; then
  if command -v node >/dev/null; then
    warn "Node.js $(node -v) is installed. Upgrading to Node 22 for this app – other Node apps on this server will also use Node 22 (it is backward compatible for almost all apps)."
  fi
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
"$NODE_BIN" -e 'require("node:sqlite")' 2>/dev/null || die "Node.js $("$NODE_BIN" -v) has no built-in SQLite; need 22.13 or newer."

# ---------------------------------------------------------------- choose a free local port
port_owner_pid() { ss -ltnpH "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2; }
OUR_PID="$(systemctl show -p MainPID --value $SERVICE 2>/dev/null || echo 0)"
PORT=""
[[ -f "$ENV_FILE" ]] && PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 || true)"
if [[ -n "$PORT" ]]; then
  owner="$(port_owner_pid "$PORT" || true)"
  if [[ -n "$owner" && "$owner" != "$OUR_PID" ]]; then
    warn "Port $PORT is used by another program ($(ps -o comm= -p "$owner" 2>/dev/null)). Choosing a new port."
    PORT=""
  fi
fi
if [[ -z "$PORT" ]]; then
  for p in $(seq 3080 3199); do
    if [[ -z "$(ss -ltnH "sport = :$p" 2>/dev/null)" ]]; then PORT=$p; break; fi
  done
  [[ -n "$PORT" ]] || die "No free port found between 3080 and 3199."
fi
say "The app will listen on 127.0.0.1:$PORT"

# ---------------------------------------------------------------- app files + service
say "Installing the app to $APP_DIR"
id fleet >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin fleet
mkdir -p "$APP_DIR" "$DATA_DIR" "$BACKUP_DIR"
rm -rf "$APP_DIR/public"
cp -r "$SRC_DIR/server.js" "$SRC_DIR/package.json" "$SRC_DIR/public" "$APP_DIR/"
chown -R root:root "$APP_DIR"
chown -R fleet:fleet "$DATA_DIR"
chmod 750 "$DATA_DIR"

ADMIN_PW_MSG="(unchanged – use your existing admin password)"
if [[ ! -f "$ENV_FILE" ]]; then
  ADMIN_PW="$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)"
  printf 'PORT=%s\nHOST=127.0.0.1\nDATA_DIR=%s\nTZ=Asia/Kolkata\nADMIN_PASSWORD=%s\n' "$PORT" "$DATA_DIR" "$ADMIN_PW" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  [[ -f "$DATA_DIR/fleet.db" ]] || ADMIN_PW_MSG="$ADMIN_PW"
else
  sed -i "s/^PORT=.*/PORT=$PORT/" "$ENV_FILE"
  grep -q '^HOST=' "$ENV_FILE" || echo "HOST=127.0.0.1" >> "$ENV_FILE"
fi

cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Fleet Driver Monitor
After=network-online.target
Wants=network-online.target

[Service]
User=fleet
Group=fleet
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN --no-warnings=ExperimentalWarning server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable $SERVICE >/dev/null
systemctl restart $SERVICE
sleep 2
curl -fsS "http://127.0.0.1:$PORT/" >/dev/null || die "The app did not start. See: sudo journalctl -u $SERVICE -n 50"

# ---------------------------------------------------------------- which web server owns 80/443?
web_owner() {
  ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -oE 'users:\(\("[^"]+"' | head -1 | sed 's/.*"\(.*\)"/\1/'
}
WEB="${WEB_SERVER:-$(web_owner || true)}"
case "$WEB" in
  "")              WEB=caddy-new ;;
  nginx*)          WEB=nginx ;;
  caddy*)          WEB=caddy ;;
  apache2*|httpd*) die "Apache is serving ports 80/443. Ask for an Apache version of this setup, or proxy $DOMAIN to http://127.0.0.1:$PORT yourself." ;;
  *)               die "Ports 80/443 are used by '$WEB'. Proxy $DOMAIN to http://127.0.0.1:$PORT in that program, or run with WEB_SERVER=nginx|caddy." ;;
esac
say "Web server on this machine: ${WEB/caddy-new/none (installing Caddy)}"

# ---------------------------------------------------------------- nginx
setup_nginx() {
  local conf
  if [[ -d /etc/nginx/sites-available && -d /etc/nginx/sites-enabled ]]; then
    conf=/etc/nginx/sites-available/fleet-app.conf
  else
    conf=/etc/nginx/conf.d/fleet-app.conf
  fi
  local backup="/root/nginx-backup-$STAMP.tar.gz"
  tar -czf "$backup" -C /etc nginx
  say "Backed up the current Nginx config to $backup"

  # Make sure no other site already claims this domain.
  local enabled=(/etc/nginx/nginx.conf /etc/nginx/conf.d /etc/nginx/sites-enabled)
  local clash
  clash="$(grep -RlsE "server_name[^;]*[[:space:]]${DOMAIN//./\\.}([[:space:]]|;)" "${enabled[@]}" | grep -v "fleet-app.conf" || true)"
  [[ -z "$clash" ]] || die "Another Nginx site already uses server_name $DOMAIN: $(echo $clash). Remove it from that file first."

  # IPv6 listen lines only if this machine has IPv6; "http2 on;" only on nginx >= 1.25.1.
  local v6=0 newh2=0 ver
  [[ -s /proc/net/if_inet6 ]] && v6=1
  ver="$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  [[ "$(printf '%s\n1.25.1\n' "$ver" | sort -V | head -1)" == "1.25.1" ]] && newh2=1
  local l80="    listen 80;" l443
  [[ $v6 -eq 1 ]] && l80+=$'\n    listen [::]:80;'
  if [[ $newh2 -eq 1 ]]; then
    l443="    listen 443 ssl;"; [[ $v6 -eq 1 ]] && l443+=$'\n    listen [::]:443 ssl;'; l443+=$'\n    http2 on;'
  else
    l443="    listen 443 ssl http2;"; [[ $v6 -eq 1 ]] && l443+=$'\n    listen [::]:443 ssl http2;'
  fi

  local proxy="
    client_max_body_size 50m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }"

  if [[ $USE_CF_CERT -eq 1 ]]; then
    cat > "$conf" <<EOF
# Fleet Driver Monitor – managed by fleet-app/deploy/oracle-setup.sh
server {
$l80
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
server {
$l443
    server_name $DOMAIN;
    ssl_certificate     $CF_CERT;
    ssl_certificate_key $CF_KEY;
$proxy
}
EOF
  else
    cat > "$conf" <<EOF
# Fleet Driver Monitor – managed by fleet-app/deploy/oracle-setup.sh
server {
$l80
    server_name $DOMAIN;
$proxy
}
EOF
  fi
  [[ "$conf" == /etc/nginx/sites-available/* ]] && ln -sf "$conf" /etc/nginx/sites-enabled/fleet-app.conf
  if ! nginx -t 2>/tmp/fleet-nginx-test.log; then
    rm -f /etc/nginx/sites-enabled/fleet-app.conf "$conf"
    cat /tmp/fleet-nginx-test.log
    die "Nginx config test failed – nothing was changed (other sites are untouched)."
  fi
  systemctl reload nginx

  if [[ $USE_CF_CERT -eq 0 ]]; then
    say "Getting a free Let's Encrypt certificate for $DOMAIN"
    apt-get install -y certbot python3-certbot-nginx
    if ! certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect; then
      warn "Certificate request failed. Most common causes:
  - Cloudflare record is still 'Proxied' (orange) – set it to 'DNS only' (grey), wait 5 min, run this script again
  - or use a Cloudflare Origin Certificate instead (see deploy/ORACLE-CLOUD.md).
  The site is reachable over plain http://$DOMAIN for now."
    fi
  fi
  # A previous version of this script may have installed Caddy – make sure it never fights nginx for 80/443.
  if systemctl list-unit-files caddy.service >/dev/null 2>&1 && systemctl is-enabled caddy >/dev/null 2>&1; then
    systemctl disable --now caddy >/dev/null 2>&1 || true
    say "Disabled Caddy (Nginx is your web server)"
  fi
}

# ---------------------------------------------------------------- caddy
install_caddy() {
  command -v caddy >/dev/null && return
  say "Installing Caddy (HTTPS web server)"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
}
setup_caddy() {
  local cf=/etc/caddy/Caddyfile
  mkdir -p /etc/caddy; touch "$cf"
  cp "$cf" "$cf.bak-$STAMP"
  say "Backed up the current Caddyfile to $cf.bak-$STAMP"
  # Remove our previous block (marked), or the package's default placeholder site.
  sed -i '/^# BEGIN fleet-app/,/^# END fleet-app/d' "$cf"
  if grep -q '/usr/share/caddy' "$cf" && [[ $(grep -cv '^\s*\(#.*\)\?$' "$cf") -le 4 ]]; then : > "$cf"; fi
  local body; body="$(cat "$cf")"; [[ -n "$body" ]] && printf '%s\n' "$body" > "$cf"   # trim trailing blank lines
  local tls=""
  if [[ $USE_CF_CERT -eq 1 ]]; then
    chgrp caddy "$CF_KEY" 2>/dev/null && chmod 640 "$CF_KEY"
    tls="	tls $CF_CERT $CF_KEY"
  fi
  {
    echo ""
    echo "# BEGIN fleet-app (managed by fleet-app/deploy/oracle-setup.sh)"
    echo "$DOMAIN {"
    [[ -n "$tls" ]] && echo "$tls"
    echo "	encode gzip"
    echo "	reverse_proxy 127.0.0.1:$PORT"
    echo "}"
    echo "# END fleet-app"
  } >> "$cf"
  if ! caddy validate --config "$cf" --adapter caddyfile >/tmp/fleet-caddy-test.log 2>&1; then
    cp "$cf.bak-$STAMP" "$cf"
    tail -5 /tmp/fleet-caddy-test.log
    die "Caddy config test failed – restored the previous Caddyfile (other sites are untouched)."
  fi
  systemctl enable caddy >/dev/null
  if systemctl is-active caddy >/dev/null; then systemctl reload caddy; else systemctl restart caddy; fi
}

case "$WEB" in
  nginx)     setup_nginx ;;
  caddy)     setup_caddy ;;
  caddy-new) install_caddy; setup_caddy ;;
esac

# ---------------------------------------------------------------- firewall
say "Making sure ports 80 and 443 are open in the VM firewall"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport $p -m state --state NEW -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 1 -p tcp --dport $p -m state --state NEW -j ACCEPT
done
netfilter-persistent save >/dev/null 2>&1 || true
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp; ufw allow 443/tcp; fi

# ---------------------------------------------------------------- daily backup
cat > /etc/cron.daily/fleet-backup <<EOF
#!/bin/sh
# Consistent copy of the database + photos, kept for 14 days.
D=\$(date +%F)
$NODE_BIN --no-warnings -e "new (require('node:sqlite').DatabaseSync)('$DATA_DIR/fleet.db').exec(\"VACUUM INTO '$BACKUP_DIR/fleet-\$D.db'\")" 2>/dev/null || true
tar -czf $BACKUP_DIR/uploads-\$D.tar.gz -C $DATA_DIR uploads 2>/dev/null || true
find $BACKUP_DIR -type f -mtime +14 -delete
EOF
chmod 755 /etc/cron.daily/fleet-backup

# ---------------------------------------------------------------- result
sleep 2
HTTPS_LOCAL="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" 2>/dev/null || true)"
HTTPS_LOCAL="${HTTPS_LOCAL:-fail}"
CERT_INFO="$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -subject -issuer -enddate 2>/dev/null | tr '\n' ' ' || true)"

cat <<EOF

=====================================================================
  Fleet Driver Monitor is installed
---------------------------------------------------------------------
  Web server : $WEB      App port: 127.0.0.1:$PORT
  HTTPS test : $HTTPS_LOCAL (200 = OK; "fail"/000 = certificate not ready)
  Certificate: ${CERT_INFO:-none yet}

  Open       : https://$DOMAIN
  Login      : admin
  Password   : $ADMIN_PW_MSG
               (change it after logging in: Profile page)

  Cloudflare:
   - DNS only (grey cloud)  -> Let's Encrypt certificate (this script)
   - Proxied (orange cloud) -> needs a Cloudflare Origin Certificate in
     $SSL_DIR and SSL/TLS mode "Full (strict)" – see deploy/ORACLE-CLOUD.md

  Useful commands:
    sudo systemctl status $SERVICE       # is the app running?
    sudo journalctl -u $SERVICE -f       # app logs
    ls $BACKUP_DIR                        # daily backups
=====================================================================
EOF
