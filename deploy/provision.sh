#!/usr/bin/env bash
set -euo pipefail

PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
BUN_VERSION="${BUN_VERSION:-1.3.4}"
APP_USER="${APP_USER:-shitpost-cms}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
ROOT_DIR="${ROOT_DIR:-/srv/shitpost-cms}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-}"
SKIP_UFW="${SKIP_UFW:-0}"

fail() {
  printf 'provisioning failed: %s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "run this script as root"
[[ "$BUN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "BUN_VERSION must be a semantic version"
[[ "$APP_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail "APP_USER is invalid"
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail "DEPLOY_USER is invalid"
[[ "$ROOT_DIR" == /* ]] || fail "ROOT_DIR must be an absolute path"
[[ "$ROOT_DIR" != *$'\n'* && "$ROOT_DIR" != *$'\r'* ]] || fail "ROOT_DIR contains control characters"
[[ "$ROOT_DIR" != *[[:space:]]* ]] || fail "ROOT_DIR must not contain whitespace"
case "$SKIP_UFW" in
  0|1) ;;
  *) fail "SKIP_UFW must be 0 or 1" ;;
esac
if [ -n "$DEPLOY_SSH_KEY" ]; then
  [[ "$DEPLOY_SSH_KEY" == ssh-ed25519\ * ]] || fail "DEPLOY_SSH_KEY must be an Ed25519 public-key line"
  [[ "$DEPLOY_SSH_KEY" != *$'\n'* && "$DEPLOY_SSH_KEY" != *$'\r'* ]] || fail "DEPLOY_SSH_KEY must contain one line"
fi

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl unzip rsync sqlite3 ufw

case "$(uname -m)" in
  x86_64) bun_archive="bun-linux-x64" ;;
  aarch64|arm64) bun_archive="bun-linux-aarch64" ;;
  *) fail "unsupported CPU architecture: $(uname -m)" ;;
esac
temporary_directory="$(mktemp -d)"
cleanup() { rm -rf -- "$temporary_directory"; }
trap cleanup EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${bun_archive}.zip" \
  -o "$temporary_directory/bun.zip"
unzip -q "$temporary_directory/bun.zip" -d "$temporary_directory/bun"
bun_binary="$(find "$temporary_directory/bun" -type f -name bun -perm -u+x -print -quit)"
[ -n "$bun_binary" ] || fail "Bun archive did not contain an executable"
install -o root -g root -m 0755 "$bun_binary" /usr/local/bin/bun
[ "$(/usr/local/bin/bun --version)" = "$BUN_VERSION" ] || fail "installed Bun version does not match $BUN_VERSION"

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
else
  usermod --shell /usr/sbin/nologin "$APP_USER"
fi
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
else
  usermod --shell /bin/bash "$DEPLOY_USER"
fi
getent group systemd-journal >/dev/null 2>&1 && usermod --append --groups systemd-journal "$DEPLOY_USER"

deploy_home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
[ -n "$deploy_home" ] || fail "could not determine deploy home"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "$deploy_home/.ssh"
authorized_keys="$deploy_home/.ssh/authorized_keys"
touch "$authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "$authorized_keys"
chmod 0600 "$authorized_keys"
if [ -n "$DEPLOY_SSH_KEY" ]; then
  key_file="$temporary_directory/deploy-key.pub"
  printf '%s\n' "$DEPLOY_SSH_KEY" > "$key_file"
  ssh-keygen -lf "$key_file" >/dev/null || fail "DEPLOY_SSH_KEY is not a valid public key"
  if ! grep -Fqx -- "$DEPLOY_SSH_KEY" "$authorized_keys"; then
    printf '%s\n' "$DEPLOY_SSH_KEY" >> "$authorized_keys"
  fi
fi

install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0755 "$ROOT_DIR"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0755 "$ROOT_DIR/releases"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$ROOT_DIR/data" "$ROOT_DIR/cache"
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$ROOT_DIR/data/backups"
if [ ! -e "$ROOT_DIR/bot.env" ]; then
  install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0600 /dev/null "$ROOT_DIR/bot.env"
else
  chown "$DEPLOY_USER:$DEPLOY_USER" "$ROOT_DIR/bot.env"
  chmod 0600 "$ROOT_DIR/bot.env"
fi

install -o root -g root -m 0644 "$SCRIPT_DIR/shitpost-cms.service" /etc/systemd/system/shitpost-cms.service
systemctl daemon-reload
systemctl enable shitpost-cms.service

sudoers_file=/etc/sudoers.d/shitpost-cms-deploy
temporary_sudoers="$temporary_directory/shitpost-cms-deploy.sudoers"
printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl restart shitpost-cms.service\n' "$DEPLOY_USER" > "$temporary_sudoers"
install -o root -g root -m 0440 "$temporary_sudoers" "$sudoers_file"
visudo -c -f "$sudoers_file"

if [ "$SKIP_UFW" = 0 ]; then
  ufw allow OpenSSH
  ufw --force enable
fi

if ! grep -Eq '^[[:space:]]*(ssh-|ecdsa-|sk-ssh-|cert-ssh-)' "$authorized_keys"; then
  fail "no deploy SSH public key is installed; set DEPLOY_SSH_KEY and rerun"
fi

printf '%s\n' "Provisioning complete." \
  "Root directory: $ROOT_DIR" \
  "Application user: $APP_USER" \
  "Deploy user: $DEPLOY_USER" \
  "Bun: $(/usr/local/bin/bun --version)" \
  "The service is enabled but was not started." \
  "Next: write bot.env through the protected deployment workflow, then run workflow_dispatch."
printf '%s\n' "Installed deploy-key fingerprints:"
ssh-keygen -lf "$authorized_keys" || true
