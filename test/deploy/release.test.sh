#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
FAKE_ROOT="$(realpath "$(mktemp -d /tmp/queuebot-release-test.XXXXXX)")"
readonly FAKE_BIN="$FAKE_ROOT/bin"
readonly REAL_BUN="$(command -v bun)"

PATH=/usr/local/bin:/usr/bin:/bin
export PATH

cleanup() { rm -rf -- "$FAKE_ROOT"; }
trap cleanup EXIT

mkdir -p "$FAKE_BIN" "$FAKE_ROOT/releases"
printf '%s\n' 'RELEASE_SHA=development' > "$FAKE_ROOT/bot.env"
chmod 0600 "$FAKE_ROOT/bot.env"

cat > "$FAKE_BIN/bun" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = install ]; then
  mkdir -p node_modules
  exit 0
fi
exec "$REAL_BUN" "\$@"
EOF
cat > "$FAKE_BIN/flock" <<'EOF'
#!/usr/bin/env bash
if [ -f "${FAKE_ROOT:?}/lock-busy" ]; then
  exit 1
fi
exit 0
EOF
cat > "$FAKE_BIN/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$FAKE_BIN/date" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = +%s ]; then
  count_file="$FAKE_ROOT/date.count"
  count=0
  [ -f "$count_file" ] && count=$(cat "$count_file")
  count=$((count + 1))
  printf '%s\n' "$count" > "$count_file"
  printf '%s\n' "$((count * 10))"
else
  /bin/date "$@"
fi
EOF
cat > "$FAKE_BIN/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = -Tf ]; then
  shift
  source_path="$1"
  target_path="$2"
  rm -f "$target_path"
  /bin/mv -f "$source_path" "$target_path"
else
  /bin/mv "$@"
fi
EOF
cat > "$FAKE_BIN/readlink" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = -f ]; then
  realpath "$2"
else
  /usr/bin/readlink "$@"
fi
EOF
cat > "$FAKE_BIN/sudo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = -n ] && shift
exec "$@"
EOF
cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root=${FAKE_ROOT:?}
state_file="$root/systemctl.state"
pid_file="$root/systemctl.pid"
case "${1:-}" in
  restart)
    if [ -f "$root/fail-next-restart" ]; then
      rm -f "$root/fail-next-restart"
      exit 1
    fi
    current="$(realpath "$root/current")"
    sha="${current##*/}"
    now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    pid=4000
    [ -f "$pid_file" ] && pid=$(( $(cat "$pid_file") + 1 ))
    printf '%s\n' "$pid" > "$pid_file"
    printf 'active\n%s\n' "$pid" > "$state_file"
    if [ -f "$current/ready.marker" ]; then
      printf '{"schemaVersion":1,"state":"ready","releaseSha":"%s","pid":%s,"processStartedAt":"%s","changedAt":"%s","botId":99}\n' "$sha" "$pid" "$now" "$now" > "$root/ready.json"
    else
      printf '{"schemaVersion":1,"state":"starting","releaseSha":"%s","pid":%s,"processStartedAt":"%s","changedAt":"%s"}\n' "$sha" "$pid" "$now" "$now" > "$root/ready.json"
    fi
    ;;
  is-active)
    [ "$(sed -n '1p' "$state_file" 2>/dev/null || true)" = active ]
    ;;
  show)
    cat "$pid_file"
    ;;
  status)
    printf 'fake systemd status: %s\n' "$(sed -n '1p' "$state_file" 2>/dev/null || echo inactive)"
    ;;
  *)
    printf 'unsupported fake systemctl command\n' >&2
    exit 2
    ;;
esac
EOF
cat > "$FAKE_BIN/journalctl" <<'EOF'
#!/usr/bin/env bash
printf 'fake journal\n'
EOF
chmod 0755 "$FAKE_BIN"/*

sed \
  -e "s#/usr/local/bin/bun#${FAKE_BIN}/bun#g" \
  -e "s#/usr/bin/systemctl#${FAKE_BIN}/systemctl#g" \
  -e "s#/usr/bin/journalctl#${FAKE_BIN}/journalctl#g" \
  -e "s#/usr/bin/sudo#${FAKE_BIN}/sudo#g" \
  -e "s#flock -n#${FAKE_BIN}/flock -n#g" \
  -e "s#readlink -f#${FAKE_BIN}/readlink -f#g" \
  -e "s#date +%s#${FAKE_BIN}/date +%s#g" \
  -e "s#mv -Tf#${FAKE_BIN}/mv -Tf#g" \
  -e "s#sleep 2#${FAKE_BIN}/sleep 2#g" \
  "$REPO_DIR/deploy/release.sh" > "$FAKE_ROOT/release-template.sh"
chmod 0755 "$FAKE_ROOT/release-template.sh"

create_release() {
  local sha="$1"
  local ready="${2:-yes}"
  local release_dir="$FAKE_ROOT/releases/$sha"
  mkdir -p "$release_dir/deploy" "$release_dir/src"
  cp "$FAKE_ROOT/release-template.sh" "$release_dir/deploy/release.sh"
  cp "$REPO_DIR/deploy/check-ready.ts" "$release_dir/deploy/check-ready.ts"
  cp "$REPO_DIR/deploy/prestart-backup.sh" "$release_dir/deploy/prestart-backup.sh"
  cp "$REPO_DIR/src/runtime-status.ts" "$release_dir/src/runtime-status.ts"
  printf '%s\n' '{"name":"fake-release","private":true}' > "$release_dir/package.json"
  printf '%s\n' '# fake bun lock' > "$release_dir/bun.lock"
  printf '%s\n' 'export {};' > "$release_dir/src/index.ts"
  printf '{"sha":"%s","bunVersion":"1.3.4","filesChecksum":"test"}\n' "$sha" > "$release_dir/release-manifest.json"
  if [ "$ready" = yes ]; then touch "$release_dir/ready.marker"; fi
}

run_release() {
  local sha="$1"
  printf 'RELEASE_SHA=%s\n' "$sha" > "$FAKE_ROOT/bot.env.next"
  chmod 0600 "$FAKE_ROOT/bot.env.next"
  RUNTIME_STATUS_PATH="$FAKE_ROOT/ready.json" FAKE_ROOT="$FAKE_ROOT" "$FAKE_ROOT/releases/$sha/deploy/release.sh" "$sha"
}

current_sha() { basename "$(realpath "$FAKE_ROOT/current")"; }

sha_a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
sha_b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
sha_c=cccccccccccccccccccccccccccccccccccccccc
sha_d=dddddddddddddddddddddddddddddddddddddddd
sha_e=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
sha_f=abababababababababababababababababababab

create_release "$sha_a" yes
run_release "$sha_a"
test "$(current_sha)" = "$sha_a"

sleep 1
create_release "$sha_b" yes
run_release "$sha_b"
sleep 1
create_release "$sha_c" yes
run_release "$sha_c"
sleep 1
create_release "$sha_d" yes
run_release "$sha_d"
test "$(current_sha)" = "$sha_d"
test -d "$FAKE_ROOT/releases/$sha_b"
test -d "$FAKE_ROOT/releases/$sha_c"
test -d "$FAKE_ROOT/releases/$sha_d"
test ! -e "$FAKE_ROOT/releases/$sha_a"

# Re-activating the current release is a valid no-op deployment.
run_release "$sha_d"
test "$(current_sha)" = "$sha_d"

if "$FAKE_ROOT/releases/$sha_d/deploy/release.sh" "not-a-sha" > "$FAKE_ROOT/malformed-sha.log" 2>&1; then
  printf 'malformed SHA unexpectedly passed validation\n' >&2
  exit 1
fi
grep -q 'release SHA must be 40 lowercase hexadecimal characters' "$FAKE_ROOT/malformed-sha.log"

missing_sha=abababababababababababababababababababab
create_release "$missing_sha" yes
rm -f "$FAKE_ROOT/releases/$missing_sha/package.json"
if run_release "$missing_sha" > "$FAKE_ROOT/missing-artifact.log" 2>&1; then
  printf 'release with a missing artifact unexpectedly passed validation\n' >&2
  exit 1
fi
test "$(current_sha)" = "$sha_d"
grep -q 'release is missing package.json' "$FAKE_ROOT/missing-artifact.log"

forbidden_sha=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd
create_release "$forbidden_sha" yes
mkdir -p "$FAKE_ROOT/releases/$forbidden_sha/data"
if run_release "$forbidden_sha" > "$FAKE_ROOT/forbidden-path.log" 2>&1; then
  printf 'release with a forbidden data path unexpectedly passed validation\n' >&2
  exit 1
fi
test "$(current_sha)" = "$sha_d"
grep -q 'forbidden .env or data path' "$FAKE_ROOT/forbidden-path.log"

staged_sha=1234123412341234123412341234123412341234
create_release "$staged_sha" yes
rm -f "$FAKE_ROOT/bot.env.next"
printf 'RELEASE_SHA=%s\n' "$staged_sha" > "$FAKE_ROOT/staged-env-source"
ln -s "$FAKE_ROOT/staged-env-source" "$FAKE_ROOT/bot.env.next"
if FAKE_ROOT="$FAKE_ROOT" RUNTIME_STATUS_PATH="$FAKE_ROOT/ready.json" "$FAKE_ROOT/releases/$staged_sha/deploy/release.sh" "$staged_sha" > "$FAKE_ROOT/staged-env.log" 2>&1; then
  printf 'symlinked staged environment unexpectedly passed validation\n' >&2
  exit 1
fi
test "$(current_sha)" = "$sha_d"
grep -q 'staged bot environment must not be a symlink' "$FAKE_ROOT/staged-env.log"
rm -f "$FAKE_ROOT/bot.env.next" "$FAKE_ROOT/staged-env-source"

touch "$FAKE_ROOT/lock-busy"
if run_release "$sha_d" > "$FAKE_ROOT/lock-contention.log" 2>&1; then
  printf 'locked deployment unexpectedly passed validation\n' >&2
  exit 1
fi
test "$(current_sha)" = "$sha_d"
grep -q 'another deployment is already in progress' "$FAKE_ROOT/lock-contention.log"
rm -f "$FAKE_ROOT/lock-busy"

create_release "$sha_f" yes
touch "$FAKE_ROOT/fail-next-restart"
if run_release "$sha_f" > "$FAKE_ROOT/failed-activation.log" 2>&1; then
  printf 'activation failure unexpectedly succeeded\n' >&2
  exit 1
fi
test "$(current_sha)" = "$sha_d"
grep -q 'RELEASE_SHA=dddddddddddddddddddddddddddddddddddddddd' "$FAKE_ROOT/bot.env"
grep -q "rollback became ready: $sha_d" "$FAKE_ROOT/failed-activation.log"
test -d "$FAKE_ROOT/releases/$sha_f"

mkdir -p "$FAKE_ROOT/releases/not-a-release"
printf '%s\n' 'must survive pruning' > "$FAKE_ROOT/releases/not-a-release/keep.txt"

create_release "$sha_e" no
if run_release "$sha_e" > "$FAKE_ROOT/failed-deploy.log" 2>&1; then
  printf 'broken release unexpectedly became ready\n' >&2
  exit 1
fi
test "$(current_sha)" = "$sha_d"
grep -q "rollback became ready: $sha_d" "$FAKE_ROOT/failed-deploy.log"
test -d "$FAKE_ROOT/releases/$sha_e"
test -f "$FAKE_ROOT/releases/not-a-release/keep.txt"

symlink_sha=ffffffffffffffffffffffffffffffffffffffff
ln -s "$FAKE_ROOT/releases/$sha_d" "$FAKE_ROOT/releases/$symlink_sha"
if "$FAKE_ROOT/releases/$symlink_sha/deploy/release.sh" "$symlink_sha" > "$FAKE_ROOT/symlink-deploy.log" 2>&1; then
  printf 'symlink release unexpectedly passed validation\n' >&2
  exit 1
fi
grep -q 'must not be a symlink' "$FAKE_ROOT/symlink-deploy.log"

no_previous_sha=1212121212121212121212121212121212121212
create_release "$no_previous_sha" no
rm -f "$FAKE_ROOT/current" "$FAKE_ROOT/bot.env"
if run_release "$no_previous_sha" > "$FAKE_ROOT/no-previous.log" 2>&1; then
  printf 'release without a previous target unexpectedly became ready\n' >&2
  exit 1
fi
test "$(current_sha)" = "$no_previous_sha"
grep -q 'no previous release exists; failed service left for diagnosis' "$FAKE_ROOT/no-previous.log"

printf 'release activation, rollback, pruning, and path validation tests passed\n'
