# VPS deployment runbook

This runbook assumes a fresh Debian stable or Ubuntu LTS VPS, systemd, outbound HTTPS/DNS access, and SSH access for an administrator. The bot does not listen on an inbound application port.

## 1. Provision a host

Generate a dedicated, passphrase-free Ed25519 key for GitHub Actions. Keep the private file outside the repository:

```sh
umask 077
ssh-keygen -t ed25519 -f ./shitpost-cms-ci -C shitpost-cms-github-actions -N ''
ssh-keygen -lf ./shitpost-cms-ci.pub -E sha256
```

Copy only the provisioner and its systemd unit to the host. The provisioner must be run as root and does not download or execute application release code:

```sh
scp -i ./administrator_key deploy/provision.sh deploy/shitpost-cms.service root@VPS_HOST:/root/
ssh -i ./administrator_key root@VPS_HOST \
  "DEPLOY_SSH_KEY='$(tr -d '\n' < ./shitpost-cms-ci.pub)' bash /root/provision.sh"
```

Before adding `VPS_KNOWN_HOSTS` to GitHub, obtain the host key from the provider console or another trusted out-of-band channel. If using `ssh-keyscan`, treat its output as an observation to compare, not as automatic trust:

```sh
ssh-keyscan -t ed25519 VPS_HOST > ./vps_known_hosts
ssh-keygen -lf ./vps_known_hosts -E sha256
```

Compare that fingerprint with the VPS provider console. Do not run `ssh-keyscan` in the deployment workflow.

Provisioning creates:

- `/srv/shitpost-cms/releases` and `/srv/shitpost-cms/current` for code;
- `/srv/shitpost-cms/data` and `/srv/shitpost-cms/data/backups` for SQLite and backups;
- `/srv/shitpost-cms/cache` for the application user’s writable cache;
- `/srv/shitpost-cms/bot.env` with mode `0600`;
- the `shitpost-cms` system user and restricted `deploy` SSH user;
- the hardened `shitpost-cms.service` and a sudo rule permitting only service restart.

It enables the service but deliberately does not start it before the first release exists.

## 2. Configure the GitHub `production` Environment

Create an Environment named `production`, preferably with required reviewers during staging and the first production deployments.

Add these Environment secrets:

```text
VPS_SSH_KEY          contents of ./shitpost-cms-ci
VPS_KNOWN_HOSTS      contents of ./vps_known_hosts
BOT_TOKEN            production Telegram bot token
ADMIN_USER_ID        numeric Telegram admin ID
QUEUE_CHANNEL_ID     numeric private queue channel ID
TARGET_CHANNEL_ID    numeric destination channel ID
```

Add these Environment variables:

```text
VPS_HOST             exact DNS name or IPv4 address used by the host key
VPS_USER             deploy
BOT_LOG_LEVEL        info
```

The workflow validates every value before creating SSH files or touching the VPS. The bot token and channel IDs are never written to a release or passed as command-line arguments. `VPS_SSH_KEY` must be passphrase-free because the job is non-interactive.

## 3. Deploy and inspect

A push to `master` that changes deployable paths queues one deployment. The concurrency group never cancels an active deployment. A controlled redeploy can be started from the GitHub Actions UI with `workflow_dispatch`, or with GitHub CLI:

```sh
gh workflow run deploy.yml --ref master
```

The workflow checks out the triggering SHA, installs Bun `1.3.4` with a frozen lockfile, typechecks, runs unit tests, enforces the coverage gate, runs fake-root deployment tests, validates production configuration, uploads the exact SHA release, and waits for stable readiness.

For host inspection, use the administrator account and the same verified known-host file:

```sh
ssh -i ./administrator_key -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=./vps_known_hosts \
  deploy@VPS_HOST \
  'readlink -f /srv/shitpost-cms/current; systemctl is-active shitpost-cms.service; systemctl show -p MainPID --value shitpost-cms.service; cat /run/shitpost-cms/ready.json; journalctl -u shitpost-cms.service -n 80 --no-pager'
```

The readiness record is non-secret and must show `state=ready`, the expected full release SHA, and the current systemd `MainPID`. The application user writes `stopping` before a graceful restart and removes the record on clean exit.

## 4. Code rollback

Use a retained release whose directory name is a full lowercase SHA. Do not point `current` at an arbitrary path, a symlink, or a release outside `/srv/shitpost-cms/releases`:

```sh
ROLLBACK_SHA=RETAINED_40_CHARACTER_SHA
ssh -i ./administrator_key -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=./vps_known_hosts \
  deploy@VPS_HOST \
  "set -euo pipefail; printf '%s' '$ROLLBACK_SHA' | grep -Eq '^[0-9a-f]{40}$'; test -d '/srv/shitpost-cms/releases/$ROLLBACK_SHA'; ln -s '/srv/shitpost-cms/releases/$ROLLBACK_SHA' /srv/shitpost-cms/current.manual.tmp; mv -Tf /srv/shitpost-cms/current.manual.tmp /srv/shitpost-cms/current; /usr/bin/sudo -n /usr/bin/systemctl restart shitpost-cms.service"
```

Then inspect the service and readiness record. A code rollback never overwrites SQLite; the next start still makes a pre-start backup. If readiness fails, restore the previous retained release and leave the service stopped for diagnosis.

## 5. Backups and restore

Automatic pre-start backups are stored in `/srv/shitpost-cms/data/backups`. Seven unmarked backups are retained. To protect one from pruning, mark it as root:

```sh
BACKUP=20261005T190000Z-RETAINED_40_CHARACTER_SHA.sqlite
ssh -i ./administrator_key -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=./vps_known_hosts \
  root@VPS_HOST "test -f '/srv/shitpost-cms/data/backups/$BACKUP' && touch '/srv/shitpost-cms/data/backups/$BACKUP.keep'"
```

To restore, stop the unit, preserve the entire current data directory, validate the chosen backup, install it as the application-owned database, and start with scheduling paused:

```sh
BACKUP=/srv/shitpost-cms/data/backups/20261005T190000Z-RETAINED_40_CHARACTER_SHA.sqlite
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ssh -i ./administrator_key -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=./vps_known_hosts \
  root@VPS_HOST "set -euo pipefail; restore_dir=/srv/shitpost-cms/data.restore-$STAMP; systemctl stop shitpost-cms.service; sqlite3 '$BACKUP' 'PRAGMA integrity_check;' | grep -qx ok; install -d -o shitpost-cms -g shitpost-cms -m 0750 \"\$restore_dir\"; install -d -o shitpost-cms -g shitpost-cms -m 0700 \"\$restore_dir/backups\"; install -o shitpost-cms -g shitpost-cms -m 0600 '$BACKUP' \"\$restore_dir/bot.sqlite\"; mv /srv/shitpost-cms/data /srv/shitpost-cms/data.before-restore-$STAMP; mv \"\$restore_dir\" /srv/shitpost-cms/data; systemctl start shitpost-cms.service"
```

Review `/health`, uncertain operations, quarantined updates, terminal orphans, and physical source ages before resuming scheduling. Keep the `data.before-restore-*` directory until the first successful post-restore backup and admin review. Never copy only `bot.sqlite` while WAL is active.

## 6. Rotate credentials or move hosts

For a token rotation, update only the `BOT_TOKEN` Environment secret and run `workflow_dispatch`. The workflow replaces `bot.env` through a temporary file and atomic rename; it does not change code or the database.

For deploy-key rotation:

1. Generate a new Ed25519 key and verify its fingerprint out of band.
2. Rerun provisioning with the new public key; it appends keys idempotently.
3. Update the `VPS_SSH_KEY` Environment secret and run a manual deployment.
4. Confirm the new key works, then remove the old public-key line from `~deploy/.ssh/authorized_keys` as root.

When moving hosts, stop the old unit before copying the data directory or using the same bot token. Provision the new host with a distinct deploy key, transfer a verified stopped database, update `VPS_HOST` and `VPS_KNOWN_HOSTS`, deploy paused, and confirm the old host cannot restart. Never run two long-polling processes for one token.

## 7. Interrupted or incomplete deployments

If the runner disconnects after symlink activation, do not delete data. Inspect `current`, systemd, and `ready.json`; if the selected release is healthy, rerun `workflow_dispatch` for the same SHA to complete pruning and verification. If it is unhealthy, atomically restore a retained release and restart the unit.

An incomplete release that was never current can be removed only after validating its exact SHA path and confirming it is not the current target:

```sh
INCOMPLETE_SHA=40_CHARACTER_SHA
ssh -i ./administrator_key -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=./vps_known_hosts \
  root@VPS_HOST "set -euo pipefail; printf '%s' '$INCOMPLETE_SHA' | grep -Eq '^[0-9a-f]{40}$'; test \"\$(readlink -f /srv/shitpost-cms/current)\" != '/srv/shitpost-cms/releases/$INCOMPLETE_SHA'; test -d '/srv/shitpost-cms/releases/$INCOMPLETE_SHA'; rm -rf -- '/srv/shitpost-cms/releases/$INCOMPLETE_SHA'"
```

The application database, WAL/SHM files, backups, environment file, and cache are never part of release cleanup.

## 8. Enablement gate

Do not enable production scheduling merely because a workflow file exists. First close the P0/P1 findings in `IMPLEMENTATION_REVIEW.md`, complete and record the disposable real-Telegram checklist, raise the coverage gate to 90% for the deployment safety scope, and complete staging deploy/upgrade/forced-rollback/reboot/restore acceptance. Production should first be deployed paused, checked with `/health`, and resumed only after an explicit operator decision.
