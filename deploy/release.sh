#!/usr/bin/env bash
set -euo pipefail

PATH=/usr/local/bin:/usr/bin:/bin
export PATH
umask 022

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly ROOT_DIR="$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)"
readonly RELEASES_DIR="$ROOT_DIR/releases"
readonly CURRENT_LINK="$ROOT_DIR/current"
readonly SERVICE_NAME="shitpost-cms.service"
readonly ENV_FILE="$ROOT_DIR/bot.env"
readonly STAGED_ENV_FILE="$ROOT_DIR/bot.env.next"
readonly ENV_BACKUP="$ROOT_DIR/.bot.env.before.$$"
environment_changed=0

fail() {
  printf 'release activation failed: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "exactly one release SHA is required"
readonly SHA="$1"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "release SHA must be 40 lowercase hexadecimal characters"
readonly RELEASE_DIR="$RELEASES_DIR/$SHA"
[ -d "$RELEASE_DIR" ] || fail "release directory does not exist"
[ ! -L "$RELEASE_DIR" ] || fail "release directory must not be a symlink"
[ "$(readlink -f "$RELEASE_DIR")" = "$RELEASE_DIR" ] || fail "release directory path is not canonical"

exec 9>"$ROOT_DIR/.deploy.lock"
flock -n 9 || fail "another deployment is already in progress"

require_file() { [ -f "$RELEASE_DIR/$1" ] || fail "release is missing $1"; }
require_file package.json
require_file bun.lock
require_file src/index.ts
require_file deploy/check-ready.ts
require_file deploy/prestart-backup.sh
require_file release-manifest.json

[ -f "$STAGED_ENV_FILE" ] || fail "staged bot environment is missing"
[ ! -L "$STAGED_ENV_FILE" ] || fail "staged bot environment must not be a symlink"
grep -Fqx "RELEASE_SHA=$SHA" "$STAGED_ENV_FILE" || fail "staged bot environment does not match requested release"

manifest_sha="$(/usr/local/bin/bun -e 'const manifest = JSON.parse(await Bun.file(process.argv[1]).text()); if (typeof manifest.sha !== "string") process.exit(2); console.log(manifest.sha)' "$RELEASE_DIR/release-manifest.json")" \
  || fail "release manifest is not valid JSON"
[ "$manifest_sha" = "$SHA" ] || fail "release manifest SHA does not match requested SHA"
[ "$(/usr/local/bin/bun --version)" = "1.3.4" ] || fail "host Bun must be exactly 1.3.4"

if [ -e "$RELEASE_DIR/.env" ] || [ -e "$RELEASE_DIR/data" ]; then
  fail "release contains a forbidden .env or data path"
fi

previous_target=""
if [ -e "$CURRENT_LINK" ] || [ -L "$CURRENT_LINK" ]; then
  [ -L "$CURRENT_LINK" ] || fail "current exists but is not a symlink"
  previous_target="$(readlink -f "$CURRENT_LINK")"
  [ -d "$previous_target" ] || fail "current symlink target is missing"
  previous_name="${previous_target##*/}"
  [ "$(dirname "$previous_target")" = "$RELEASES_DIR" ] || fail "current points outside releases"
  [[ "$previous_name" =~ ^[0-9a-f]{40}$ ]] || fail "current points to an invalid release name"
  previous_manifest_sha="$(/usr/local/bin/bun -e 'const manifest = JSON.parse(await Bun.file(process.argv[1]).text()); if (typeof manifest.sha !== "string") process.exit(2); console.log(manifest.sha)' "$previous_target/release-manifest.json")" \
    || fail "current release manifest is not valid JSON"
  [ "$previous_manifest_sha" = "$previous_name" ] || fail "current release manifest does not match its directory"
fi

(cd "$RELEASE_DIR" && /usr/local/bin/bun install --frozen-lockfile --production)

prepare_environment() {
  rm -f -- "$ENV_BACKUP" || return 1
  if [ -e "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
    [ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || return 1
    cp -p -- "$ENV_FILE" "$ENV_BACKUP" || return 1
  fi
  mv -f -- "$STAGED_ENV_FILE" "$ENV_FILE" || return 1
  environment_changed=1
  chmod 0600 "$ENV_FILE" || return 1
}

restore_environment() {
  if [ -e "$ENV_BACKUP" ] || [ -L "$ENV_BACKUP" ]; then
    mv -f -- "$ENV_BACKUP" "$ENV_FILE"
  elif [ "$environment_changed" -eq 1 ]; then
    rm -f -- "$ENV_FILE"
  fi
  environment_changed=0
}

discard_environment_backup() {
  rm -f -- "$ENV_BACKUP"
}

restart_release() {
  local target="$1"
  local temporary_link="$ROOT_DIR/.current.tmp.$$"
  rm -f -- "$temporary_link"
  ln -s "$target" "$temporary_link"
  mv -Tf "$temporary_link" "$CURRENT_LINK"
  /usr/bin/sudo -n /usr/bin/systemctl restart "$SERVICE_NAME"
}

activate_new_release() {
  prepare_environment && restart_release "$RELEASE_DIR"
}

show_failure() {
  /usr/bin/systemctl status --no-pager "$SERVICE_NAME" || true
  /usr/bin/journalctl -u "$SERVICE_NAME" -n 80 --no-pager || true
}

wait_for_ready() {
  local expected_sha="$1"
  local checker_release_dir="$2"
  local deadline=$(( $(date +%s) + 60 ))
  local successes=0
  local stable_pid=""
  while [ "$(date +%s)" -le "$deadline" ]; do
    if /usr/bin/systemctl is-active --quiet "$SERVICE_NAME"; then
      local main_pid
      main_pid="$(/usr/bin/systemctl show -p MainPID --value "$SERVICE_NAME" 2>/dev/null || true)"
      if [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] && [ "$main_pid" = "$stable_pid" ]; then
        if READINESS_MAX_AGE_MS=60000 /usr/local/bin/bun "$checker_release_dir/deploy/check-ready.ts" "$expected_sha" "$main_pid"; then
          successes=$((successes + 1))
          [ "$successes" -ge 5 ] && return 0
        else
          successes=0
        fi
      else
        stable_pid="$main_pid"
        successes=0
      fi
    else
      stable_pid=""
      successes=0
    fi
    sleep 2
  done
  return 1
}

rollback_to_previous() {
  local previous_name="${previous_target##*/}"
  printf 'rolling back to %s\n' "$previous_name" >&2
  restore_environment || return 1
  restart_release "$previous_target" && wait_for_ready "$previous_name" "$previous_target"
}

if ! activate_new_release; then
  printf 'new release activation failed: %s\n' "$SHA" >&2
  show_failure
  if [ -n "$previous_target" ]; then
    if rollback_to_previous; then
      printf 'rollback became ready: %s\n' "${previous_target##*/}" >&2
      discard_environment_backup
    else
      printf 'rollback failed; operator intervention is required\n' >&2
      show_failure
    fi
  else
    printf 'no previous release exists; failed service left for diagnosis\n' >&2
  fi
  exit 1
fi

if ! wait_for_ready "$SHA" "$RELEASE_DIR"; then
  printf 'new release did not become ready: %s\n' "$SHA" >&2
  show_failure
  if [ -n "$previous_target" ]; then
    if rollback_to_previous; then
      printf 'rollback became ready: %s\n' "${previous_target##*/}" >&2
      discard_environment_backup
    else
      printf 'rollback failed; operator intervention is required\n' >&2
      show_failure
    fi
  else
    printf 'no previous release exists; failed service left for diagnosis\n' >&2
  fi
  exit 1
fi

discard_environment_backup

current_target="$(readlink -f "$CURRENT_LINK")"
[ "$current_target" = "$RELEASE_DIR" ] || fail "current symlink changed unexpectedly"

release_mtime() {
  stat -c '%Y' "$1" 2>/dev/null || stat -f '%m' "$1"
}

kept_non_current=0
while read -r _mtime candidate; do
  [ -n "${candidate:-}" ] || continue
  [ "$candidate" = "$current_target" ] && continue
  [ -d "$candidate" ] || continue
  [ ! -L "$candidate" ] || continue
  candidate_name="${candidate##*/}"
  [ "$(dirname "$candidate")" = "$RELEASES_DIR" ] || continue
  [[ "$candidate_name" =~ ^[0-9a-f]{40}$ ]] || continue
  if [ "$kept_non_current" -lt 2 ]; then
    kept_non_current=$((kept_non_current + 1))
    continue
  fi
  rm -rf -- "$candidate"
done < <(
  for candidate in "$RELEASES_DIR"/*; do
    [ -d "$candidate" ] || continue
    [ ! -L "$candidate" ] || continue
    candidate_name="${candidate##*/}"
    [[ "$candidate_name" =~ ^[0-9a-f]{40}$ ]] || continue
    printf '%s %s\n' "$(release_mtime "$candidate")" "$candidate"
  done | sort -nr
)

printf 'release ready: %s\n' "$SHA"
