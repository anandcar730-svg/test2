#!/usr/bin/env bash
# =============================================================================
# Fleet Driver Monitor – one-command setup for an Oracle Cloud (OCI) Ubuntu VM
#
#   Run from inside the fleet-app folder on the VM:
#       sudo bash deploy/oracle-setup.sh                 # uses <your-ip>.sslip.io
#       sudo bash deploy/oracle-setup.sh fleet.mysite.in # uses your own domain
#
# What it does (safe to run again later to update the app – data is kept):
#   1. Installs Node.js 22 and Caddy (automatic free HTTPS certificate)
#   2. Copies the app to /opt/fleet-app, data lives in /var/lib/fleet
#   3. Runs it as a systemd service that restarts on crash/reboot
#   4. Opens ports 80/443 in the VM's own firewall (Oracle images block them)
#   5. Makes a daily backup into /var/backups/fleet (keeps 14 days)
# =============================================================================
set -euo pipefail

APP_DIR=/opt/fleet-app
DATA_DIR=/var/lib/fleet
BACKUP_DIR=/var/backups/fleet
ENV_FILE=/etc/fleet-app.env
SERVICE=fleet-app
PORT=3000
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo:  sudo bash deploy/oracle-setup.sh"
[[ -f "$SRC_DIR/server.js" && -d "$SRC_DIR/public" ]] || die "server.js not found. Run this from the fleet-app folder."
command -v apt-get >/dev/null || die "This script supports Ubuntu images. Create the VM with the 'Canonical Ubuntu' image."
export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- domain
PUBLIC_IP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com || curl -fsS --max-time 10 https://ifconfig.me || true)"
PUBLIC_IP="$(echo "$PUBLIC_IP" | tr -d '[:space:]')"
DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  [[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Could not detect the public IP. Pass a domain: sudo bash deploy/oracle-setup.sh your.domain"
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"   # free hostname that points to this IP
fi
DOMAIN="$(echo "$DOMAIN" | tr 'A-Z' 'a-z' | sed -e 's#^https\?://##' -e 's#/.*$##')"
if [[ "$DOMAIN" == *_* ]]; then
  die "'$DOMAIN' contains an underscore (_). Web addresses cannot use underscores and no HTTPS
       certificate can be issued for them. Use a hyphen or nothing instead, e.g. ${DOMAIN//_/-}"
fi
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "'$DOMAIN' is not a valid domain name."
if [[ -n "${1:-}" && -n "$PUBLIC_IP" ]]; then
  DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
  if [[ "$DNS_IP" != "$PUBLIC_IP" ]]; then
    printf '\n\033[1;33mWARNING: %s points to "%s" but this server is %s.\033[0m\n' "$DOMAIN" "${DNS_IP:-nothing}" "$PUBLIC_IP"
    echo "Add a DNS A record: ${DOMAIN%%.*}  ->  $PUBLIC_IP  (HTTPS starts working once it updates)."
  fi
fi
say "Setting up https://$DOMAIN"

# ---------------------------------------------------------------- packages
say "Installing system packages"
apt-get update -y
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

need_node=1
if command -v node >/dev/null; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' && need_node=0
fi
if [[ $need_node -eq 1 ]]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -e 'require("node:sqlite")' 2>/dev/null || die "Node.js $(node -v) has no built-in SQLite; need 22.13 or newer."

if ! command -v caddy >/dev/null; then
  say "Installing Caddy (HTTPS web server)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# ---------------------------------------------------------------- app files
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
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
HOST=127.0.0.1
DATA_DIR=$DATA_DIR
TZ=Asia/Kolkata
ADMIN_PASSWORD=$ADMIN_PW
EOF
  chmod 600 "$ENV_FILE"
  [[ -f "$DATA_DIR/fleet.db" ]] || ADMIN_PW_MSG="$ADMIN_PW"
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
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning server.js
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

# ---------------------------------------------------------------- HTTPS
say "Configuring Caddy for $DOMAIN"
# Cloudflare proxy (orange cloud): if a Cloudflare Origin Certificate was saved to these
# two files, use it instead of Let's Encrypt (set Cloudflare SSL/TLS mode to "Full (strict)").
CF_CERT=/etc/caddy/cloudflare-origin.pem
CF_KEY=/etc/caddy/cloudflare-origin.key
TLS_LINE=""
if [[ -s "$CF_CERT" && -s "$CF_KEY" ]]; then
  grep -q "BEGIN CERTIFICATE" "$CF_CERT" || die "$CF_CERT is not a certificate (must start with -----BEGIN CERTIFICATE-----)"
  grep -q "PRIVATE KEY" "$CF_KEY" || die "$CF_KEY is not a private key (must start with -----BEGIN PRIVATE KEY-----)"
  chown root:caddy "$CF_CERT" "$CF_KEY"
  chmod 640 "$CF_CERT" "$CF_KEY"
  TLS_LINE="	tls $CF_CERT $CF_KEY"
  say "Using the Cloudflare Origin Certificate"
fi
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
$TLS_LINE
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
  || die "Caddy config is invalid. Check with: caddy validate --config /etc/caddy/Caddyfile"
systemctl enable caddy >/dev/null
systemctl restart caddy

# ---------------------------------------------------------------- firewall
# Oracle's Ubuntu images ship iptables rules that REJECT everything except SSH.
say "Opening ports 80 and 443 in the VM firewall"
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
set -e
D=\$(date +%F)
cd $DATA_DIR
/usr/bin/node --no-warnings -e "new (require('node:sqlite').DatabaseSync)('$DATA_DIR/fleet.db').exec(\"VACUUM INTO '$BACKUP_DIR/fleet-\$D.db'\")" 2>/dev/null || true
tar -czf $BACKUP_DIR/uploads-\$D.tar.gz -C $DATA_DIR uploads 2>/dev/null || true
find $BACKUP_DIR -type f -mtime +14 -delete
EOF
chmod 755 /etc/cron.daily/fleet-backup

# ---------------------------------------------------------------- check
sleep 2
if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null; then APP_OK="running"; else APP_OK="NOT running – see: sudo journalctl -u $SERVICE -n 50"; fi

cat <<EOF

=====================================================================
  Fleet Driver Monitor is installed
---------------------------------------------------------------------
  App status : $APP_OK
  Open       : https://$DOMAIN
  Login      : admin
  Password   : $ADMIN_PW_MSG
               (change it after logging in: Profile page)

  If the page does not open, add Ingress Rules for TCP ports 80 and
  443 (source 0.0.0.0/0) in the OCI console:
  Networking > Virtual cloud networks > your VCN > Security Lists >
  Default Security List > Add Ingress Rules.
  The HTTPS certificate is issued automatically once port 80/443 is
  reachable (can take a minute): sudo journalctl -u caddy -f

  Useful commands:
    sudo systemctl status $SERVICE       # is it running?
    sudo journalctl -u $SERVICE -f       # live logs
    ls $BACKUP_DIR                        # daily backups
=====================================================================
EOF
