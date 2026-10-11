# Telegram Channel Queue Bot — Implementation Plan

Status: **implementation-ready**  
Last researched: 2026-10-04

## 1. Objective

Build a Bun + TypeScript bot that treats a private Telegram channel as a FIFO queue and publishes one logical post at each configured wall-clock slot to a destination channel.

For every queued post:

- If its original source is a whitelisted channel, forward it so Telegram keeps the source attribution.
- If its original source is a non-whitelisted channel, copy it so Telegram removes the source attribution.
- If its original source is a user, copy it and append `by <name>` using a configured alias when one exists, otherwise the Telegram display name.
- After successful publication, delete the source post from the queue channel.
- Let the single administrator identified by `ADMIN_USER_ID` manage the publication slots, channel whitelist, author aliases, and queue status in a private chat with the bot.

The implementation should be a single always-on process, use long polling, keep dependencies small, and be covered by `bun test` unit tests.

## 2. Important Telegram constraints

These constraints are architectural, not framework-specific.

1. **A Bot API bot cannot list or reconcile arbitrary channel history.** It learns about new queue posts through `channel_post` updates. Telegram retains unconsumed updates for no longer than 24 hours. The bot must therefore be continuously operated and persist every queue update before its handler returns. If it is offline for more than 24 hours, an admin-assisted recovery flow is required. [Bot API: updates and `getUpdates`](https://core.telegram.org/bots/api#getupdates)

2. **Bot API deletion has a 48-hour age limit.** Even with channel admin rights, a bot cannot delete an ordinary queue post after that limit. Because the product must support an indefinitely old logical queue, the bot will renew each physical queue message before it reaches 48 hours: create a replacement inside the same private queue channel, durably swap the stored source IDs, then delete the old physical messages. SQLite—not visible channel order—remains the authority for logical FIFO order. [Bot API: `deleteMessage`](https://core.telegram.org/bots/api#deletemessage)

3. **Copying removes attribution; forwarding preserves it.** `copyMessages` is explicitly equivalent to forwarding without a link to the original and preserves album grouping. This directly implements the whitelist policy. [Bot API: `copyMessages`](https://core.telegram.org/bots/api#copymessages), [Bot API: `forwardMessages`](https://core.telegram.org/bots/api#forwardmessages)

4. **Some content cannot be copied.** Service messages, paid media, giveaways, giveaway winners, and invoices cannot be copied; some protected content cannot be forwarded. Such items must remain in the queue and produce an admin alert instead of being deleted. [Bot API: `copyMessages`](https://core.telegram.org/bots/api#copymessages), [Telegram content protection](https://core.telegram.org/api/content-protection)

5. **User origins are not always identifiable.** `forward_origin` may contain a known user, only a hidden-user display string, a chat, or a channel. A hidden user has no stable ID, so a durable custom alias cannot safely be attached to that person. [Bot API: `MessageOrigin`](https://core.telegram.org/bots/api#messageorigin)

6. **Exactly-once delivery is not fully achievable with the Bot API.** Publishing to Telegram and committing local SQLite state cannot be one atomic transaction. The design prefers no data loss and reduces duplicate risk, but a process/network failure after Telegram accepted a post and before the response was durably recorded can leave an uncertain outcome requiring admin review.

### Operational consequence

The selected Bot API design requires a monitored process and downtime under 24 hours. The physical messages also have to be renewed before they become 48 hours old. A 36-hour renewal target leaves a 12-hour safety margin. Downtime that crosses both the renewal deadline and 48-hour deletion deadline can still strand old physical messages, so the bot must alert the admin well before the safety margin expires.

There is one pre-implementation validation gate: forwarding an already-forwarded message inside the queue must retain the original `MessageOriginChannel`/`MessageOriginUser`. If Telegram instead changes the origin to the queue channel, the Bot API cannot satisfy both indefinite retention and later source-preserving publication. That result must be reported before implementation proceeds; the fallback choices would be MTProto or relaxing source attribution.

## 3. TypeScript Telegram framework investigation

### Provenance methodology

The requested maintainer-origin filter cannot be applied by guessing nationality from a person's name, language, or commit history. The shortlist below uses only public, self-declared current maintainer locations and project ownership. A missing or ambiguous signal is treated as **unverified** and not shortlisted; it is not a claim about anyone's nationality.

The comparison is scoped to active TypeScript-capable Telegram Bot API libraries with meaningful adoption or current development. MTProto libraries are discussed separately because they solve a different problem.

### Shortlisted options

| Option | Current evidence | Dependency/Bun fit | Assessment for this bot |
| --- | --- | --- | --- |
| **grammY** | TypeScript-first, current 1.x line, active project, strong docs. The package currently declares four runtime dependencies. It documents a Bun webhook adapter and has Bun examples. The named primary author publicly lists Kiel, Germany. [repository](https://github.com/grammyjs/grammY), [package](https://github.com/grammyjs/grammY/blob/main/package.json), [Bun adapter](https://grammy.dev/guide/deployment-types), [maintainer profile](https://github.com/KnorpelSenf) | Works on Bun. One direct app dependency, four transitive runtime dependencies in the current package. Mature middleware and excellent Telegram types. | **Recommended stable framework.** It gives reliable update filtering and API typing without bringing in a scheduler, database library, web server, or conversation plugin. |
| **node-telegram-bot-api** | Long-running project recently rewritten in TypeScript. Current development has a runtime-agnostic core, explicit Bun exports/storage, Bun unit tests, and no declared runtime dependencies on the v2 branch; current package metadata is `2.2.0-rc2`. The repository owner publicly lists Madrid, Spain. [repository](https://github.com/yagop/node-telegram-bot-api), [package](https://github.com/yagop/node-telegram-bot-api/blob/master/package.json), [owner profile](https://github.com/yagop) | Excellent minimal-dependency and Bun fit. However, the attractive new API is still a release candidate and has had recent major API churn. | **Best low-dependency alternative** after a stable v2 release, or if an RC is explicitly acceptable. Do not make a production plan depend on the RC by default. |
| **Telegraf** | Established TypeScript-capable framework with broad adoption. Current v4.16.3 declares eight runtime dependencies and documents Telegram Bot API 7.1 support; its release notes describe v4 as the last major v4 update while v5 was planned. The current named maintainer publicly lists Chennai, India. [repository](https://github.com/telegraf/telegraf), [package](https://github.com/telegraf/telegraf/blob/v4/package.json), [releases](https://github.com/telegraf/telegraf/releases), [maintainer profile](https://github.com/MKRhere) | Usually works under Bun's Node compatibility, but it carries more compatibility-era dependencies and its stable line is behind the newest Bot API surface. | Viable, but weaker than grammY here because this bot needs current `MessageOrigin`, multi-copy/forward, and minimal dependencies more than Telegraf's larger ecosystem. |
| **Direct Bot API over Bun `fetch`** | Not a framework. Implement `getUpdates` and the small set of Bot API methods directly, using local narrow TypeScript interfaces or a types-only package. [Bot API](https://core.telegram.org/bots/api) | Zero runtime dependencies and total control. Requires implementing polling offsets, 429 handling, API errors, update routing, and test doubles correctly. | Viable because the bot is small, but the saved dependency is not worth owning subtle polling/error plumbing. Keep this as a fallback, not the default. |

### Investigated but not shortlisted

- **Puregram** is active and TypeScript-native, but the public project/maintainer pages inspected did not provide a reliable declared location with which to apply the requested provenance criterion. It also targets Node.js >=22 in its current documentation rather than explicitly presenting Bun as a supported runtime. This is an uncertainty-based omission, not a statement about maintainer nationality. [repository](https://github.com/puregram/puregram), [maintainer profile](https://github.com/nitreojs)
- **MTCute** explicitly supports Bun and can authenticate bots, but it is an MTProto client/framework rather than a Bot API framework. It needs Telegram application credentials and persistent login/session machinery. Consider it only if channel history reconciliation and deletion beyond Bot API limits are required. [repository](https://github.com/mtcute/mtcute), [Bun setup](https://github.com/mtcute/mtcute/blob/master/docs/guide/index.md#bun)

### Framework decision

Confirmed choice: use **grammY**, pinned to an exact version in `bun.lock`, with no grammY plugins. Use Bun built-ins for SQLite, environment loading, timers, `fetch`, and testing.

Expected dependencies:

- Runtime: `grammy` only.
- Development: `typescript` and `@types/bun` only.
- No ORM, migration tool, cron package, validation package, logger, or test framework.

Before implementation, run a small Bun compatibility spike that starts grammY against an injected/fake update source and type-checks calls to `copyMessages`, `forwardMessages`, `deleteMessages`, and `editMessageText`/`editMessageCaption`. If that spike exposes a current incompatibility, stop and report the exact issue. grammY is a confirmed product decision and must not be silently replaced; prefer a small local adapter workaround only when it is isolated, tested, and approved.

## 4. Proposed behavior

### 4.1 Queue ingestion

- The bot is an administrator in `QUEUE_CHANNEL_ID` and listens only to `channel_post` and `edited_channel_post` updates from that exact chat.
- Each ordinary message becomes one queue item.
- Messages sharing a `media_group_id` are buffered briefly and persisted as one ordered queue item. An album is one atomic logical post and is later published, renewed, and deleted as a unit.
- Ingestion is idempotent on `(queue_chat_id, message_id)` so Telegram retries cannot create duplicate items.
- Persist the minimal source snapshot needed later: message IDs, media-group ID, text/caption, entities, `forward_origin`, received timestamp, and the original update JSON for forward compatibility/debugging. The actual media remains in the private queue channel and is referenced by message ID.
- An edit updates the stored snapshot while the item is still queued. An edit after publication is ignored and logged.
- The Bot API does not emit ordinary channel-post deletion updates and has no method to read one arbitrary message or list channel history. A deletion performed directly in the Telegram channel therefore cannot update SQLite immediately.
- Reconcile a manually deleted source lazily at the first operation that proves it is missing—normally its next publication attempt or physical-message renewal. Remove the logical item from SQLite at that point and notify the admin.
- If any message of an album is found missing, treat the album as deleted: best-effort delete its remaining physical messages and remove the entire logical item from SQLite.
- Provide **Delete from queue** in the bot's admin UI. That path deletes the Telegram source and SQLite row together and is the documented way to get immediate, deterministic synchronization.

### 4.2 Origin policy

Apply one deterministic pure function to the first message in the logical item:

| `forward_origin` | Policy |
| --- | --- |
| `channel` and `origin.chat.id` is whitelisted | `forwardMessage` / `forwardMessages`; preserve Telegram attribution |
| `channel` and not whitelisted | `copyMessage` / `copyMessages`; no attribution |
| `user` | Copy; append `by <alias>` when an alias matches stable user ID, otherwise Telegram first + optional last name |
| `hidden_user` | Copy; append `by <sender_user_name>`; aliases are unavailable because Telegram supplies no stable identity |
| `chat` | Copy without attribution unless a future product decision adds chat whitelisting |
| absent | Copy without attribution; this is the confirmed behavior for posts composed directly in the queue |

Alias lookup order:

1. stable Telegram user ID;
2. last-seen normalized username only to resolve an admin's alias-management input to that stable ID;
3. Telegram display name (`first_name` plus optional `last_name`) when no alias exists;
4. `sender_user_name` for a hidden user;
5. `Unknown` only if Telegram supplied no usable display string.

Store both stable ID and last-seen username when possible. Usernames are mutable and must not be the canonical key once an ID has been observed. A username is never used as the public byline unless it is itself the configured alias; the default is the user's Telegram display name.

### 4.3 Appending the byline

- Append plain text `\n\nby <name>` without parse mode, avoiding injection through aliases or Telegram names.
- For a text message, copy it, then edit the copied text with the original entities plus the plain byline.
- For one media message, call `copyMessage` with a replacement caption containing the original caption plus byline.
- For an album, call `copyMessages` to preserve grouping, then edit the caption of the designated caption-bearing item.
- Preserve original entity offsets exactly and add no entity to the byline in v1.
- If the combined text/caption exceeds Telegram's limit, leave the item queued, mark it `needs_edit`, and tell the admin. Do not truncate user content silently.

### 4.4 Publishing state machine

Use these durable states:

```text
collecting -> queued -> publishing -> published_cleanup_pending -> done
                 |          |                    |
                 |          +-> uncertain_publish+-> cleanup retry
                 +-> blocked / needs_edit / needs_review

Any source-bearing non-active state
  -> renewing -> renewed_cleanup_pending -> previous logical state
             +-> uncertain_renewal
```

Publication sequence:

1. Atomically claim the oldest `queued` item in SQLite as `publishing`.
2. Decide forward/copy/byline behavior from the stored origin and current whitelist/alias state.
3. Publish the complete item to `TARGET_CHANNEL_ID`.
4. Immediately persist every destination message ID and transition to `published_cleanup_pending`.
5. Delete all source message IDs with `deleteMessages`.
6. Transition to `done` and retain a compact audit row; do not retain full message content indefinitely.

Failure rules:

- Never delete the queue source until every destination message has succeeded.
- A publish error returns the item to `queued` with attempt/error metadata, except permanent unsupported/length errors, which use explicit states and alert the admin. A confirmed missing source is removed from SQLite as a manual deletion, with an admin notification.
- Honor Telegram `retry_after` for 429 errors; otherwise use bounded exponential retry for transient network/5xx failures.
- If publication succeeded but deletion failed, remain in `published_cleanup_pending`; retry cleanup without republishing.
- On startup, clean up rows with recorded destination IDs. A `publishing` row with no recorded result is `uncertain`; do not automatically duplicate it. Present admin actions: “mark published and delete source” or “retry publication.”

### 4.5 Physical queue-message renewal

Logical queue items may remain indefinitely, but their current physical Telegram messages must stay young enough to delete.

- Run a maintenance scan independently of publication slots.
- At a default physical age of 36 hours, claim the logical item as `renewing`.
- For a forwarded item, call `forwardMessage`/`forwardMessages` from the queue channel back into the same queue channel so its original Telegram origin is retained.
- For an original post composed directly in the queue, call `copyMessage`/`copyMessages`; keep the stored logical origin as `absent` even though later Telegram updates for the bot-created replacement may differ.
- Persist the new source message IDs and renewal generation in one SQLite transaction before deleting the old source IDs.
- Delete the old physical source only after every replacement message succeeds and the new IDs are durable.
- Keep `queue_items.enqueued_at` and its logical sequence unchanged, so renewal never changes publication order even though the replacement appears at the bottom of the private channel.
- Ignore `channel_post` updates for bot-created renewal messages by matching a pending renewal operation/new message IDs, so renewal does not create duplicate logical queue entries.
- If replacement succeeds and deletion fails, retry deletion without renewing or publishing again.
- If renewal proves that a source is missing, remove its logical item from SQLite as described in queue ingestion. If renewal repeatedly fails for another reason or any source approaches 46 hours, send a high-priority admin alert and pause neither ingestion nor other safe renewals.
- Batch albums with the multi-message methods and honor Telegram rate limits. A queue large enough that all items cannot be renewed inside the safety window is an operational capacity error and must be surfaced.

Renewal crash states mirror publishing states: `renewing`, `renewed_cleanup_pending`, and `renewal_uncertain`. Never delete the last known usable physical copy.

### 4.6 Scheduling

Use recurring UTC wall-clock slots rather than an elapsed interval.

- Persist `enabled`, an ordered unique set of UTC `HH:MM` slots, `next_publish_at`, and `last_publish_at` in SQLite.
- Start paused until the admin configures at least one slot and taps **Start**.
- Use one in-process async timer loop; do not add a cron dependency.
- Guard the tick with both an in-memory mutex and a SQLite claim so overlapping manual/scheduled triggers cannot publish two items.
- One tick publishes one logical item (an album counts as one).
- Calculate each next occurrence in UTC; there is no daylight-saving conversion. If the queue is empty, advance to the next configured slot normally.
- If a tick was missed during a restart, run one overdue tick immediately and schedule the next configured UTC slot; do not burst all missed ticks.
- Manual **Publish next now** does not move the regular schedule.
- Show the projected publication slot for visible queue items. Physical age is tracked separately because renewal decouples it from logical queue age.

### 4.7 Admin private-chat UX

Every handler starts with both checks:

- `ctx.from.id === ADMIN_USER_ID`
- `ctx.chat.type === "private"`

Ignore or tersely reject all other callers. Do not rely only on hidden menu buttons for authorization.

`/start` and `/manage` render an inline-keyboard dashboard:

- **Queue**: count, oldest logical age, oldest physical-copy age, next run, preview first few items, publish next now, delete an item from Telegram and SQLite, retry/resolve blocked and uncertain items.
- **Schedule**: show status as UTC; add/remove daily `HH:MM` UTC wall-clock slots; pause/resume.
- **Whitelist**: list entries; add by `@public_handle` or numeric `-100…` channel ID; remove via buttons.
- **Author names**: list known users; choose a recently observed author; set/change/remove alias; add by user ID or an already-seen `@username`.
- **Recovery**: enqueue a missed queue message from a pasted private-channel message link or explicit message ID.

Whitelist add flow:

1. Accept `@handle` or numeric ID.
2. Resolve with `getChat`.
3. Require `type === "channel"`.
4. Show title, handle, and canonical numeric ID for confirmation.
5. Store the numeric ID as the canonical whitelist key and the handle/title only as display metadata.

Author alias flow:

- The bot indexes `MessageOriginUser` identities observed in queue posts.
- An arbitrary Telegram username cannot always be resolved to a user by the Bot API. `@username` alias entry therefore works only after that user has been observed; otherwise the UI explains how to queue/forward a sample first or enter a numeric user ID.
- Hidden-user forward origins can display a name but cannot be assigned a stable alias.

Recovery flow for >24-hour downtime:

- Admin pastes a queue message link or ID.
- The bot temporarily forwards the specified source to the admin chat, uses the returned `Message` to recover origin metadata, stores the queue record, and deletes the temporary preview.
- Albums require the admin to provide the complete message-ID range/list in v1.
- The bot cannot discover which IDs were missed by itself, so monitoring remains required.

## 5. Persistence design

Use `bun:sqlite` with WAL mode, foreign keys, and small hand-written numbered migrations.

Proposed tables:

- `schema_migrations(version, applied_at)`
- `settings(key PRIMARY KEY, value_json, updated_at)`
- `queue_items(id, logical_sequence, queue_chat_id, media_group_id, first_message_id, origin_type, origin_chat_id, origin_user_id, origin_username, origin_display_name, status, attempts, renewal_generation, last_renewed_at, last_error, destination_message_ids_json, enqueued_at, claimed_at, published_at, completed_at)`
- `queue_messages(item_id, message_id, ordinal, snapshot_json, PRIMARY KEY(item_id, message_id))`
- `channel_whitelist(chat_id PRIMARY KEY, username, title, added_at)`
- `known_authors(user_id PRIMARY KEY, username, display_name, first_seen_at, last_seen_at)`
- `author_aliases(user_id PRIMARY KEY, nickname, updated_at)`
- `admin_prompts(admin_id PRIMARY KEY, state_json, expires_at)` for restart-safe force-reply/menu flows

Indexes:

- active queue selection by `(status, logical_sequence)`;
- logical FIFO by immutable `logical_sequence`;
- unique queue source `(queue_chat_id, message_id)` through `queue_messages`;
- case-insensitive/normalized lookup for known usernames.

Data retention:

- Keep active/full snapshots while an item needs work.
- After `done`, retain IDs, origin decision, timestamps, and destination IDs for a configurable short audit period, then remove message body/update JSON.

## 6. Configuration

Required environment variables:

```dotenv
BOT_TOKEN=
ADMIN_USER_ID=
QUEUE_CHANNEL_ID=
TARGET_CHANNEL_ID=
```

Optional:

```dotenv
DATABASE_PATH=./data/bot.sqlite
LOG_LEVEL=info
```

Validation at startup must reject missing tokens, non-integer IDs, queue/target equality, and a relative database path that escapes the project working directory. Do not log the bot token or complete incoming update payloads in normal operation.

Startup checks:

- `getMe` succeeds;
- `getChat` confirms both configured chats are channels;
- `getChatMember` confirms the bot is an administrator;
- queue rights include posting and deleting messages, because renewal writes replacements and removes old generations;
- destination rights include posting and the rights needed to edit bylined copies and delete partial/rollback outputs;
- send the admin one actionable error and refuse to start the scheduler if rights are insufficient.

## 7. Proposed source layout

```text
.
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── telegram.ts              # narrow framework/API adapter
│   ├── db/
│   │   ├── database.ts
│   │   ├── migrations.ts
│   │   └── repositories.ts
│   ├── domain/
│   │   ├── origin-policy.ts
│   │   ├── byline.ts
│   │   └── queue-item.ts
│   ├── handlers/
│   │   ├── admin.ts
│   │   └── queue-channel.ts
│   └── services/
│       ├── ingestion.ts
│       ├── publisher.ts
│       ├── scheduler.ts
│       └── recovery.ts
├── test/
│   ├── fixtures/
│   ├── origin-policy.test.ts
│   ├── ingestion.test.ts
│   ├── publisher.test.ts
│   ├── scheduler.test.ts
│   ├── admin.test.ts
│   └── recovery.test.ts
├── data/.gitkeep
├── .env.example
├── .gitignore
├── bunfig.toml
├── package.json
├── tsconfig.json
└── README.md
```

Keep grammY objects at the boundary. Domain and service code depends on a narrow internal `TelegramGateway` interface, which makes the difficult behavior testable without network calls and makes a later framework swap inexpensive.

## 8. Testing strategy with Bun

All tests use `bun:test`, a temporary SQLite database, injected clock/timer, and a fake `TelegramGateway`. Unit tests must not call Telegram.

### Domain tests

- Every `MessageOrigin` variant maps to the correct policy.
- Whitelist matching uses numeric channel ID, not mutable handle.
- Alias precedence is user ID -> observed username -> display name.
- Hidden users never accidentally match another person's alias.
- Byline generation is plain-text safe and handles text/caption limits.

### Ingestion tests

- Queue-channel filtering rejects all other chats/update kinds.
- Duplicate updates are idempotent.
- Albums are grouped in message-ID order and become one item.
- Edits refresh queued snapshots.
- Known users are indexed or refreshed.

### Publisher tests

- Whitelisted channel uses forward; non-whitelisted channel uses copy.
- User origin copies and appends configured alias or display name.
- Direct queue posts copy without a byline.
- Albums use bulk methods, retain order, and delete as a unit.
- Source deletion occurs only after all destination calls succeed.
- Publish success + delete failure retries cleanup without republishing.
- 429, transient, permanent, protected, and unsupported-content errors enter the correct state; a confirmed missing source is removed as a manual deletion.
- Crash-recovery states never silently duplicate or drop an item.

### Scheduler tests

- Pause/resume, UTC wall-clock slot changes, empty queue, manual publish, and restart behavior.
- Only one concurrent tick can claim an item.
- A missed tick publishes at most one item on restart.
- Physical-copy age and renewal scheduling warn before the 48-hour deletion limit, independent of logical queue age.

### Admin/security tests

- Every command and callback is rejected for wrong user ID or non-private chat.
- Whitelist handle/ID validation and confirmation.
- Alias add/change/remove and unknown username guidance.
- Callback data is length-bounded and stale/tampered callback values fail closed.
- Recovery parses only links belonging to the configured queue channel.
- Bot-managed queue deletion removes Telegram messages and SQLite state together.
- A source found missing during publication/renewal removes its SQLite logical item; a partially deleted album removes its remaining physical messages and the whole logical item.

### Quality gates

```sh
bun test
bunx tsc --noEmit
```

Add a small optional manual sandbox checklist for a separate Telegram test bot and two disposable private channels; never run it in normal unit tests.

## 9. Implementation phases

1. **Compatibility spike and scaffold**
   - Pin Bun/TypeScript/grammY versions.
   - Verify the required Telegram methods and Bun runtime behavior.
   - Add config validation, logging utility, graceful shutdown, and empty test harness.

2. **SQLite and pure domain rules**
   - Add migrations/repositories.
   - Implement origin classification, whitelist lookup, alias resolution, byline construction, and state transitions.
   - Cover these with unit tests first.

3. **Queue ingestion and renewal proof**
   - Handle channel posts, album collection, edits, idempotency, and known-author indexing.
   - In disposable channels, prove that re-forwarding retains the original channel/user origin and that an original queue post can be renewed by copying without changing its stored logical origin.
   - Stop and report the product tradeoff if the origin-preservation proof fails.
   - Add queue/status tests.

4. **Publisher and cleanup**
   - Implement forward/copy paths, byline editing, bulk album handling, durable results, retries, cleanup-only recovery, and admin alerts.
   - Add the failure-matrix tests before enabling the scheduler.

5. **Admin UX**
   - Implement the dashboard, schedule controls, whitelist flows, alias flows, queue inspection, and uncertain-item resolution.
   - Set private-chat bot commands for the admin.

6. **Scheduler, renewal worker, and missed-update recovery**
   - Add persisted wall-clock slots, locking, physical-message renewal/cleanup alerts, manual publish, and link/ID recovery.

7. **Operational documentation and Telegram sandbox verification**
   - Document BotFather setup, channel rights, env config, backup/restore, upgrades, 24/48-hour constraints, and recovery.
   - Verify every origin branch, an album, a retry, and source deletion in disposable channels.

## 10. Acceptance criteria

- A new queue post is durably indexed once, including after duplicate Telegram updates.
- At each enabled wall-clock slot, exactly one locally known logical item is selected FIFO.
- A whitelisted channel origin remains visibly forwarded from that channel.
- A non-whitelisted channel origin has no source attribution.
- A known user origin has `by <configured alias>`; an unaliased known/hidden user uses Telegram's supplied display name.
- An album remains one grouped album and counts as one queue item.
- The source is deleted only after confirmed publication of the complete item.
- Restart after successful publication but before deletion performs cleanup only.
- Blocked and uncertain items are visible and actionable in the admin chat.
- Only the configured admin can read or mutate bot settings.
- Whitelist entries can be added by public handle or numeric channel ID and are stored canonically by ID.
- Alias entries can be managed for observed users without hardcoded names.
- UTC wall-clock slots survive restart and scheduling can be paused/resumed in private chat.
- Daily publication slots are interpreted strictly as UTC and are configurable by the admin.
- **Delete from queue** removes both the physical Telegram source and SQLite record immediately; a deletion made directly in the Telegram channel is removed from SQLite when the next publish/renewal operation detects it.
- `bun test` and `bunx tsc --noEmit` pass.
- Logical queue items may remain longer than 48 hours while their physical Telegram messages are safely renewed before the deletion deadline.
- Documentation explicitly states the 24-hour update-retention, 48-hour deletion limit, renewal mechanism, visible channel reordering, and downtime risk.

## 11. Confirmed decisions and fixed defaults

Confirmed decisions:

- Use daily wall-clock slots.
- Treat a media album as one atomic queue item.
- Copy original posts composed in the queue with no attribution.
- Use the Bot API and renew physical queue messages so logical items can remain longer than 48 hours.
- Use grammY.
- Interpret every admin-configured publication slot in UTC.
- Accept that renewal moves a physical post to the bottom of the queue channel while SQLite preserves logical FIFO.
- After restart, publish at most one overdue item immediately; do not burst catch-up.
- If appending a byline would exceed Telegram's text/caption limit, leave the item queued and alert the admin rather than truncating content or publishing a separate byline.
- Prefer the bot's **Delete from queue** action for immediate Telegram/SQLite consistency. Direct channel deletion is reconciled lazily because the Bot API supplies no deletion update or history lookup.

## 12. Normative product rules and invariants

This section is normative. If an earlier summary is less precise, these rules win.

### 12.1 Terminology

- **Logical item**: one publishable unit in SQLite. It is either one Telegram message or one media album.
- **Physical source**: the current Telegram message ID or ordered list of message IDs in the private queue channel that backs a logical item.
- **Generation**: an integer starting at `0` and incremented every time a physical source is renewed.
- **Publication output**: every destination-channel message created for one logical item. Usually one message or one album; a user-origin message that cannot carry a caption may also create a second attribution message.
- **Slot occurrence**: one concrete UTC instant derived from a configured daily `HH:MM` slot, for example `2026-10-04T18:30:00Z`.
- **Current source**: the physical message IDs whose generation matches `queue_items.source_generation`. Older IDs are stale cleanup candidates only.

### 12.2 Hard invariants

1. `logical_sequence` is immutable except for an explicit, confirmed admin **Move to end** action.
2. At most one active publication or renewal operation may own a logical item.
3. A source is never deleted before a usable replacement or complete publication output has been durably recorded.
4. A publication output is never intentionally created twice. When the result of an API call is uncertain, automation stops for that item and asks the admin rather than guessing.
5. A scheduled slot publishes at most one logical item. Albums still count as one item.
6. The oldest unresolved logical item controls FIFO. Later items do not pass a blocked, `needs_edit`, or uncertain head item unless the admin explicitly deletes it or moves it to the end.
7. Whitelist and alias policy is evaluated at publication time, not enqueue time. Changes therefore apply to posts that are already waiting.
8. Origin identity is captured at first ingestion and never replaced by the queue channel's identity during renewal.
9. Telegram message IDs are always stored together with their chat ID; a bare message ID is never treated as globally unique.
10. All timestamps used for scheduling and leases are UTC Unix epoch milliseconds. Telegram's second-resolution `date`/`edit_date` values are converted once at the boundary.
11. No SQLite transaction remains open while awaiting a Telegram network call.
12. Unknown Telegram message types fail closed into admin review; they are never silently published or deleted.

### 12.3 FIFO behavior when the head cannot publish

- A transient failure keeps the head item in place with `retry_not_before`. The current slot may retry within its short retry budget; otherwise the next slot tries the same head item.
- A permanent content/permission/length failure changes the head to `blocked` or `needs_edit`. Future slots report that the queue is blocked and publish nothing.
- The admin can **Retry now**, **Delete**, or **Move to end**. Moving to end assigns a new sequence in one transaction and records an audit event.
- An item manually deleted in Telegram is removed when absence is proven, allowing the next item to become head.

## 13. Telegram content and attribution matrix

Telegram limits ordinary text to 4096 characters and media captions to 1024 characters after entity parsing. Callback data is limited to 64 bytes. Media groups contain 2–10 supported media items. The implementation must validate these limits before making an API call. [Bot API: `sendMessage`](https://core.telegram.org/bots/api#sendmessage), [Bot API: media captions](https://core.telegram.org/bots/api#sendphoto), [Bot API: inline keyboard](https://core.telegram.org/bots/api#inlinekeyboardbutton), [Bot API: `sendMediaGroup`](https://core.telegram.org/bots/api#sendmediagroup)

### 13.1 Source-origin decision table

Evaluate the semantic origin saved at initial ingestion:

| Semantic origin | Current policy lookup | Destination operation | Added byline |
| --- | --- | --- | --- |
| Channel | Channel ID currently whitelisted | Forward current physical source | No |
| Channel | Channel ID not currently whitelisted | Copy current physical source | No |
| Known user | Alias exists for stable user ID | Copy, then add `by <alias>` | Yes |
| Known user | No alias | Copy, then add `by <first_name> <last_name?>` | Yes |
| Hidden user | No stable lookup possible | Copy, then add `by <sender_user_name>` | Yes |
| Chat/group/anonymous admin | No v1 whitelist support | Copy | No |
| No forward origin | None | Copy | No |
| Unknown future origin variant | None | Block for review | No automatic publication |

Additional rules:

- Whitelisting is only for `MessageOriginChannel`. A group, supergroup, or anonymous `MessageOriginChat` never qualifies accidentally.
- The canonical whitelist comparison is exact signed numeric channel ID. Handles and titles are display metadata only.
- The original channel's `author_signature` is not a user identity and does not invoke user alias behavior.
- If messages inside one album have inconsistent semantic origins, mark the whole item `needs_review`; do not apply the first message's policy to the rest.
- A changed or removed channel handle does not affect an existing whitelist entry.
- A changed user username does not detach an alias because aliases are keyed by stable user ID.

### 13.2 Content-type behavior

| Message content | Whitelisted channel | Other channel/direct queue post | User origin |
| --- | --- | --- | --- |
| Text | Forward | Copy | Copy, then edit text to append byline |
| Photo, video, animation, audio, document, voice with/without caption | Forward | Copy | Copy with replacement caption containing original caption + byline |
| Media album | Forward all IDs with `forwardMessages` | Copy all IDs with `copyMessages` | Copy album, then edit the caption-bearing destination item |
| Sticker, video note, contact, location, venue, dice | Forward | Copy | Copy content, then send a separate plain-text `by <name>` message immediately after it |
| Poll with known/copyable data | Forward | Copy | Copy poll, then send separate byline message |
| Quiz poll whose correct option is unknown to the bot | Forward only if Telegram permits | Block copy path | Block and alert |
| Paid media, invoice, giveaway/winner, service message | Block unless the compatibility spike proves the exact required operation is supported | Block | Block |
| Protected content | Block if forwarding/copying fails | Block | Block |
| Unknown/new Bot API content | Block | Block | Block |

For captionless user-origin content, the separate byline message is part of the same logical publication output. If sending it fails, attempt to delete the content message and leave the source queued. If cleanup is uncertain, transition to `uncertain_publish` rather than producing content without required attribution.

### 13.3 Byline construction and entity preservation

- The exact suffix is `\n\nby ${name}` for text/captions and `by ${name}` for a separate attribution message.
- Trim leading/trailing whitespace from an alias and collapse embedded line breaks/tabs to one space.
- Alias length: 1–64 Unicode code points after normalization; reject C0/C1 control characters and bidi override/isolate control characters. Emoji and ordinary non-Latin text are allowed.
- Telegram names are data, never markup. Do not set `parse_mode`; pass explicit `entities`/`caption_entities` from the stored snapshot.
- Telegram entity offsets use UTF-16 code units. Existing text is not modified before the suffix, so existing offsets and lengths remain unchanged. Use JavaScript string length for the append offset and validate every stored entity is within bounds before sending.
- Preserve `show_caption_above_media` when the Bot API method permits it.
- For an album, append to the existing caption-bearing member. If none has a caption, put the byline on the first member. More than one non-empty album caption is treated as `needs_review` because client rendering is inconsistent.
- Preflight the final text/caption against the 4096/1024 limits. If it does not fit, set `needs_edit`, leave the source untouched, and show the exact number of characters that must be removed.
- A source with malformed/out-of-range entities is copied without modifying the destination only for non-user policies. A user-origin source requires review because dropping entities or the byline would change required output.

### 13.4 Inline keyboards, replies, and ancillary metadata

- V1 does not promise to preserve arbitrary inline keyboards from queued posts. Telegram forwarding/copying may omit them, and callback data can target another bot. Detect `reply_markup` in the snapshot and show a warning in queue preview.
- Do not recreate callback buttons owned by another bot.
- Do not carry `reply_to_message`, external replies, quotes, or queue-channel discussion context into the destination unless Telegram's forward/copy operation does so automatically.
- Preserve spoilers, entities, media metadata, and link previews through Telegram's native copy/forward path; do not download and re-upload files.
- `disable_notification` is `false` for scheduled publication and configurable only as a future feature. Renewal inside the private queue uses `disable_notification: true`.
- Do not set `protect_content` on destination messages unless a future explicit setting requires it.

## 14. Detailed processing algorithms

### 14.1 Startup sequence

1. Parse and validate environment variables without printing secrets.
2. Create the data directory with owner-only permissions when possible.
3. Open SQLite, enable `foreign_keys`, `journal_mode=WAL`, and a finite busy timeout.
4. Apply numbered migrations in one transaction per migration.
5. Acquire the singleton runtime lease; exit if another healthy process owns it.
6. Construct grammY and call `getMe`; save the bot ID/username in memory.
7. Validate queue and destination chats and required administrator rights.
8. Recover expired operation leases and classify incomplete operations.
9. Finalize stale `collecting` albums whose quiet/max deadline elapsed.
10. Start the renewal worker and scheduler in paused execution mode.
11. Start grammY long polling with explicit allowed updates: `message`, `callback_query`, `channel_post`, and `edited_channel_post`. Do not use `drop_pending_updates`.
12. After polling is healthy, enable scheduled/renewal execution and send one deduplicated startup-health alert only if action is required.

### 14.2 Single-message ingestion

1. Reject updates whose chat ID is not `QUEUE_CHANNEL_ID`.
2. If `(chat_id, message_id)` is in the self-generated-message suppression table, attach it to its operation and do not create a new logical item.
3. Classify content and capture semantic origin, text/caption/entities, content type, Telegram date/edit date, and a redacted snapshot.
4. In `BEGIN IMMEDIATE`, recheck source uniqueness, allocate `logical_sequence = max + 1`, insert `queue_items`, insert `queue_messages`, upsert a known author, and commit.
5. A duplicate update becomes a no-op. A conflicting duplicate—same message ID but materially different immutable fields—is logged as data corruption and quarantined.

### 14.3 Album collection

- Key the collector by `(queue_chat_id, media_group_id)`.
- First member creates a `collecting` item and sets `quiet_deadline = now + 2 seconds`, `max_deadline = first_seen + 10 seconds`.
- Every additional member is inserted idempotently and moves the quiet deadline to two seconds after its arrival, never beyond the max deadline.
- Finalize when the quiet deadline expires, when 10 members exist, or on startup if either deadline is already past.
- Sort by Telegram `message_id`, assign ordinal `0..n-1`, validate 2–10 members and consistent semantic origin, then transition to `queued`.
- A one-member media group after the max deadline is `needs_review`, not silently treated as a normal message; this may represent an update gap.
- `collecting` items are not eligible for publication or renewal.

### 14.4 Edit handling

- Match an edit only against the current generation's `(chat_id, message_id)`.
- For `collecting`, `queued`, `blocked`, and `needs_edit`, replace the stored editable snapshot and increment `content_version`.
- For an old generation, ignore the edit and log it at debug level.
- For `publishing` or `renewing`, store the edit and increment `content_version`. The operation compares its captured version before source cleanup. If changed, it deletes any known destination/replacement outputs and retries from the new snapshot when safe.
- An edit arriving after `done` is recorded only as an audit anomaly; it cannot modify already published content.
- There is an unavoidable race if Telegram accepts a publication and an external edit occurs before its update reaches the bot. The README must state that queue posts should not be edited at a scheduled publication instant.

### 14.5 Scheduled publication

1. Materialize a unique `schedule_runs` row for the UTC slot occurrence.
2. Acquire the global publication lease. If another manual/scheduled publication owns it, leave the run pending briefly; never run two publications concurrently.
3. Select the lowest `logical_sequence` source-bearing item.
4. If none exists, mark the run `empty`.
5. If the head is blocked, uncertain, collecting, or before `retry_not_before`, mark the run `blocked` with the item ID; do not select a later item.
6. Claim the head using a random operation token and capture `content_version`, source generation, source IDs, and policy inputs.
7. Execute the content-specific Telegram calls.
8. Persist every known destination ID immediately in `operation_outputs`, then move to cleanup.
9. Recheck operation token, source generation, and content version.
10. Delete current physical sources. If deletion succeeds or reports already absent, mark the item `done` and the schedule run `published`.
11. On failure, use the error rules in Section 18; never consume another logical item for the same slot.

### 14.6 Manual publish

- Uses the same publication algorithm and global lease but creates a `manual` operation rather than a `schedule_runs` occurrence.
- Does not mark any scheduled occurrence handled and does not change the next UTC slot.
- Requires an inline confirmation showing the head item, chosen origin policy, and whether attribution will be preserved, removed, or appended.
- Repeated button presses are idempotent through a one-time callback token and the global lease.

### 14.7 Renewal

1. Wake every 15 minutes and query current physical sources ordered by `physical_created_at`.
2. Normal renewal eligibility begins at 36 hours. Warning begins at 42 hours, high-priority warning at 46 hours, and 47 hours is treated as critical.
3. Skip only items actively publishing/deleting; all other source-bearing states, including blocked and uncertain items, still need renewal.
4. Claim one item with an operation token and captured generation/version.
5. If semantic origin exists, re-forward the current source back into the queue to preserve origin. If origin is absent, copy it.
6. Require the number of returned IDs to equal the number of source IDs. Persist replacement IDs as the next generation before any source deletion.
7. Delete the previous generation. A cleanup failure creates orphan cleanup work but does not revert the new current generation.
8. Continue oldest-first until no eligible source remains or Telegram applies rate limiting.
9. Renewal never changes logical sequence, enqueue time, policy metadata, alias target, or schedule projection.

If a source is older than 48 hours after downtime, still attempt to create a fresh generation. If replacement succeeds but the old source can no longer be deleted, keep its IDs in `orphaned_sources`, continue using the fresh generation, and tell the admin which old Telegram posts require manual cleanup.

### 14.8 Bot-managed queue deletion

1. Admin selects a logical item and receives a confirmation showing all current source IDs and whether it is an album.
2. Acquire the item operation lease.
3. Call `deleteMessages` for all current IDs.
4. If Telegram returns success, treat already-missing IDs as success, set the item `deleted`, remove full snapshots according to retention policy, and record the admin audit event.
5. If the call fails due to rights/network/rate limit, keep the SQLite item and show a retryable error.
6. If messages are older than Telegram's deletable window, set `delete_blocked`; the admin must delete them in the Telegram client and then use **Confirm manually removed** to clear SQLite.

### 14.9 Lazy reconciliation of direct Telegram deletions

- A generic API failure never proves deletion. Only error shapes classified as source absent, or a successful multi-message call returning fewer outputs than inputs, trigger missing-source handling.
- For a single message proven missing, mark the logical item `deleted_external` and remove it from the active queue.
- For an album with any proven-missing member, attempt to delete remaining current members and mark the whole logical item `deleted_external`.
- Notify once with logical item ID, source IDs, and detection operation. Do not repeatedly alert on the same deletion.

### 14.10 Missed-update recovery

Recovery is explicit because the bot cannot enumerate channel history.

1. Admin supplies one private queue message link/ID, or an ordered list/range for a known album.
2. Parse a link locally. For a private-channel `t.me/c/...` link, verify its internal channel component matches the configured queue channel; otherwise reject it.
3. Reject duplicate IDs, non-increasing album IDs, more than 10 album members, or any ID already active in SQLite.
4. Forward each source ID individually to the admin chat. Individual `forwardMessage` calls return full `Message` objects, unlike the bulk methods that return only message IDs; these temporary previews provide content/origin snapshots for recovery.
5. Durably record every temporary preview ID as it arrives so a crash can clean it up later.
6. Validate that all recovered members exist, have compatible content for one album, and have the same semantic origin.
7. Derive semantic origin carefully:
   - an external channel/user/hidden-user origin remains that origin;
   - an origin channel equal to `QUEUE_CHANNEL_ID` means the source was an original queue post or a renewed copy and is stored as semantic origin `absent`;
   - any ambiguity becomes `needs_review` rather than guessing.
8. Insert the logical item at the end of FIFO with generation `0`, preserving the supplied source IDs and their Telegram dates.
9. Delete all temporary admin previews. Preview cleanup failure creates an orphan cleanup record but does not invalidate the recovered queue item.

Recovery cannot prove that the admin supplied every missed post, nor can it infer an album's missing member IDs. The UI must say this explicitly and show the recovered IDs before confirmation.

## 15. Precise scheduling semantics

### 15.1 Slot representation and validation

- Store a slot as `minute_of_day INTEGER` in `[0, 1439]`; render it as zero-padded `HH:MM UTC`.
- Accept admin text only when it matches `^(?:[01][0-9]|2[0-3]):[0-5][0-9]$` after trimming.
- Slots are daily, unique, and sorted. A duplicate add is an idempotent success.
- Require 1–96 slots while scheduling is enabled. This prevents accidental near-continuous publishing while allowing 15-minute granularity.
- Seconds are always `00`. Leap seconds are ignored, matching ordinary Unix time behavior.

### 15.2 Occurrence idempotency

- The primary key of a scheduled run is its exact epoch minute/ISO occurrence, not merely `HH:MM`.
- Before publishing, insert the occurrence row with a unique constraint. If it already exists in a terminal status, do nothing.
- Persist `last_scheduler_scan_at`. On each scan, compute occurrences in `(last_scan, now]` without depending on timer precision.
- Normal timer wakeup may be late; the unique occurrence still runs once.
- Clock moving backward cannot repeat an occurrence because of the unique key. Clock moving forward is handled as missed occurrences.

### 15.3 Restart and missed slots

- On startup, compute missed occurrences since the last scan, capped by the time of the most recent configured slot before `now`.
- Mark all but the newest missed occurrence `skipped_downtime` without publishing.
- Run at most the newest missed occurrence immediately if scheduling was enabled during that occurrence and it has never been terminally recorded.
- Then schedule the next future configured slot. There is never burst catch-up.
- If the queue was empty at a missed occurrence, the immediate recovery run records `empty`; it does not wait for a future item and then publish outside a slot.
- Disabling scheduling records no future runs. Re-enabling begins with the next future slot and does not backfill time spent disabled.

### 15.4 Slot changes

- Adding/removing a slot affects only occurrences strictly after the settings transaction commits.
- Removing the slot whose run is already active does not cancel the active publication.
- Changing slots while paused changes configuration only.
- Manual publish never changes slot history.

## 16. Detailed persistence model

Use migrations rather than constructing tables ad hoc. Suggested schema below is logical; exact SQL names may be refined without changing semantics.

### 16.1 Core tables

`app_state`

- singleton schema/app version, bot ID, created timestamp, last clean shutdown, last scheduler scan, and last successful update timestamp.

`settings`

- typed key/value JSON with a schema version and update timestamp;
- only low-cardinality settings such as `schedule_enabled` and retention days belong here.

`schedule_slots`

- `minute_of_day INTEGER PRIMARY KEY CHECK (minute_of_day BETWEEN 0 AND 1439)`;
- `created_at`, `created_by_admin_id`.

`schedule_runs`

- `occurrence_at INTEGER PRIMARY KEY`;
- status enum: `pending`, `running`, `published`, `empty`, `blocked`, `failed`, `skipped_downtime`;
- optional logical item/operation ID, started/completed timestamps, and error code.

`queue_items`

- integer primary key and unique immutable `logical_sequence`;
- status enum: `collecting`, `queued`, `publishing`, `published_cleanup_pending`, `renewing`, `renewed_cleanup_pending`, `blocked`, `needs_edit`, `needs_review`, `uncertain_publish`, `uncertain_renewal`, `delete_blocked`, `done`, `deleted`, `deleted_external`;
- `content_type`, `media_group_id`, semantic origin columns, `content_version`, `source_generation`;
- enqueue/physical/renewal timestamps, retry fields, last error classification, completion timestamp;
- CHECK constraints ensuring user/channel origin IDs appear only with compatible origin types.

`queue_messages`

- `(item_id, source_generation, telegram_message_id)` composite uniqueness;
- ordinal, Telegram date/edit date, content type, text/caption, entities JSON, redacted snapshot JSON;
- `is_current` is derived from generation rather than stored as an independent truth;
- foreign key to item with controlled cascade on final retention purge.

`operations`

- random text operation ID, type (`publish`, `manual_publish`, `renew`, `delete`, `recover`), item ID, state, captured version/generation, lease owner/expiry, created/updated timestamps, normalized error.

`operation_outputs`

- operation ID, output kind (`destination`, `replacement`, `temporary_preview`), chat ID, Telegram message ID, ordinal, recorded timestamp;
- unique `(chat_id, telegram_message_id)`.

`orphaned_sources`

- old generation IDs that could not be deleted, reason, first/last cleanup attempt, resolved timestamp.

### 16.2 Policy and admin tables

`channel_whitelist`

- signed channel ID primary key, last-known handle/title, who added it, timestamps;
- removing a row affects future publication decisions immediately.

`known_authors`

- stable user ID primary key, current normalized username, first/last/display names, first/last seen timestamps;
- a partial unique index on normalized current username; when a username moves to another observed user, clear it from the old row before assigning it.

`author_aliases`

- user ID primary key and foreign key to known author, normalized alias, timestamps, admin ID;
- aliases survive username changes.

`admin_prompts`

- admin ID, prompt kind, JSON payload, expected reply-to message ID, created/expiry timestamps;
- one active prompt per admin; `/cancel` deletes it.

`callback_tokens`

- short random token primary key, admin ID, action, payload JSON, expiry, consumed timestamp;
- avoids exposing large or forgeable state in Telegram's 64-byte callback field.

`admin_alerts`

- deduplication key, severity, first/last seen, last sent, occurrence count, resolved timestamp.

`audit_events`

- append-only compact event type, actor (`system` or admin ID), item/operation IDs, metadata JSON, timestamp;
- never store `BOT_TOKEN` or full private message bodies here.

`runtime_leases`

- singleton process ownership and heartbeat expiry, plus the global publication lock.

### 16.3 Database rules

- Use foreign keys and explicit `ON DELETE` behavior; do not rely on manual multi-table cleanup.
- Use `BEGIN IMMEDIATE` for sequence allocation, claims, settings mutations, and state transitions.
- Configure a busy timeout and treat persistent `SQLITE_BUSY` as a health failure, not an infinite retry.
- Validate JSON on read and include a schema version inside stored snapshots/payloads.
- Migration files are forward-only and covered by tests from an empty database and every supported previous schema.
- Production startup creates a timestamped backup before a migration that rewrites/drops data.
- Default audit retention: 30 days. Active/uncertain/blocked items are never purged automatically.

## 17. Concurrency, leases, and crash recovery

### 17.1 Process model

- Official deployment is exactly one long-running Bun process and one SQLite database on local durable storage.
- A heartbeat-based singleton lease prevents accidental second instances. Lease duration: 60 seconds; refresh every 20 seconds.
- Losing the singleton lease disables scheduler/renewal immediately and terminates the process after in-flight work reaches a safe checkpoint.
- Long-poll updates are fed through an application-level sequential dispatcher before handlers mutate state. Admin callbacks and background workers still use database compare-and-swap claims.

### 17.2 Item operation lease

- Claim fields include operation ID, captured status/version/generation, and lease expiry.
- Initial item lease: 5 minutes; refresh during Telegram 429 waits.
- Every post-network state mutation uses `WHERE operation_id = ? AND content_version = ? AND source_generation = ?`.
- A failed compare-and-swap means external state changed; known new outputs are cleaned up and the operation stops.

### 17.3 Crash matrix

| Crash point | Durable evidence | Startup behavior |
| --- | --- | --- |
| Before Telegram call | Operation only, no outputs | Expire lease and safely return item to previous state |
| Telegram definitely rejected | Normalized error recorded | Apply retry/permanent rule |
| Telegram may have accepted but no response/output IDs | No IDs, ambiguous transport error | `uncertain_publish`/`uncertain_renewal`; admin review |
| Output IDs recorded, source not deleted | Complete output rows | Cleanup only; never resend |
| Some multi-step outputs recorded | Partial output rows | Delete known outputs, then retry only if cleanup is confirmed |
| New renewal generation recorded, old source remains | Current generation + orphan IDs | Continue from new generation; retry old cleanup |
| Source deleted, final SQLite commit missing | Output IDs recorded and operation cleanup state | Mark done during recovery; source absence is expected |

No automatic retry is allowed after an ambiguous timeout on a non-idempotent Telegram send. The admin UI shows known facts and offers:

- **Destination is correct — finish cleanup**;
- **Nothing was published — retry**;
- **Open destination channel** and **Open queue source** links when constructible;
- **Delete known partial outputs**.

### 17.4 Graceful shutdown

On `SIGINT`/`SIGTERM`:

1. disable new scheduler/renewal claims;
2. stop long polling without dropping pending updates;
3. allow the active operation up to 30 seconds to reach a durable checkpoint;
4. record a non-clean shutdown if the deadline expires;
5. checkpoint WAL when safe, release the runtime lease, and close SQLite.

## 18. Telegram API errors, retries, and partial results

### 18.1 Central error classifier

Wrap grammY `GrammyError` and transport errors in a small application error union:

- `rate_limited(retry_after)`;
- `transient_network`;
- `transient_server`;
- `source_missing`;
- `content_protected`;
- `unsupported_content`;
- `permission_denied`;
- `invalid_content_or_entities`;
- `destination_unavailable`;
- `ambiguous_send_result`;
- `unknown_permanent`.

Classification uses HTTP status, Telegram error code, method name, and narrowly tested description patterns. Never classify every HTTP 400 as “source deleted.” Store the raw Telegram description only in restricted debug/audit context and redact message content/token-like strings.

### 18.2 Retry policy

- 429: honor `retry_after` plus 0–500 ms jitter and refresh the lease. Cap one operation's wait at five minutes; beyond that requeue for the next slot/maintenance pass.
- Network failure before request bytes were sent: retry up to three times at roughly 1s, 2s, 4s plus jitter.
- Connection reset/timeout after bytes may have been sent: ambiguous; do not automatically retry a send/copy/forward.
- Telegram 5xx: up to three bounded retries unless the client cannot prove the prior request was rejected; ambiguous cases stop.
- Permission/protected/unsupported/entity errors: no automatic retry until config/content changes or admin presses **Retry now**.
- Cleanup deletions are safe to retry because deleting an already-absent message is an acceptable result.

### 18.3 Multi-message partial results

Telegram documents that missing members may be skipped by `forwardMessages`/`copyMessages`, so output count can be lower than input count. Album publication is therefore not transactionally atomic at the API level. [Bot API: `forwardMessages`](https://core.telegram.org/bots/api#forwardmessages), [Bot API: `copyMessages`](https://core.telegram.org/bots/api#copymessages)

- Require returned output count to equal input count before treating an album as successful.
- If fewer IDs are returned, immediately record and delete all returned destination/replacement IDs, then apply missing-source reconciliation.
- If Telegram reports an error but may have emitted some album members without returning their IDs, mark the operation uncertain; do not retry automatically.
- Preserve strict increasing input message IDs as required by the Bot API.
- Never map output IDs to source ordinals unless counts match exactly.

### 18.4 Admin alert policy

- Immediate alerts: uncertain send, permissions lost, renewal source >=46h, database/migration failure, singleton conflict, corrupt state.
- Normal alerts: head blocked, byline overflow, unsupported content, external deletion detected.
- Deduplicate on `(category, item_id or subsystem)`. Repeat unresolved immediate alerts at most every six hours; normal alerts at most daily.
- Send a resolution message when an immediate condition clears.

## 19. Admin interaction specification

### 19.1 Commands

| Command | Behavior |
| --- | --- |
| `/start` or `/manage` | Render/update main dashboard |
| `/queue` | Paginated logical FIFO view |
| `/schedule` | View/add/remove UTC slots and pause/resume |
| `/whitelist` | List/add/remove source channels |
| `/authors` | List observed authors and manage aliases |
| `/health` | Runtime, polling, DB, rights, renewal, queue, next-slot status |
| `/recover` | Begin explicit message-ID/link recovery flow |
| `/cancel` | Cancel the active prompt/confirmation |

Register commands for the admin's private chat after the first `/start`. All command, message, and callback handlers repeat the numeric admin-ID/private-chat authorization check.

### 19.2 Dashboard

Show:

- scheduling enabled/paused and sorted UTC slots;
- next slot and whether an overdue recovery run exists;
- active queue count, blocked count, uncertain count;
- head item summary and intended attribution policy;
- oldest logical age and oldest physical source age;
- renewal warning/critical count and orphan cleanup count;
- last successful poll/update, publication, renewal, and database backup;
- bot rights status.

Prefer editing one dashboard message. If edit fails because it is too old/deleted/unchanged, send a new dashboard and store its message ID.

### 19.3 Queue browsing

- Page size: 10 logical items, ordered by `logical_sequence`.
- Display stable short item ID, content type, logical age, current physical age, origin summary, status, and projected UTC slot.
- Do not echo full private content by default. A **Preview** action may copy/forward a temporary preview to the admin and delete it on dismissal/expiry.
- Actions: **Publish now**, **Delete**, **Move to end**, **Retry**, **Resolve uncertain**, **Preview**.
- Destructive actions require a second, one-time confirmation token expiring after 10 minutes.

### 19.4 Schedule flows

- **Add slot** prompts for exact `HH:MM` and displays `UTC` in prompt and confirmation.
- **Remove slot** uses buttons; disabling the last slot automatically pauses scheduling but retains no invalid “enabled with zero slots” state.
- **Pause** leaves slots intact. **Resume** requires at least one slot and previews the next occurrence.

### 19.5 Whitelist flows

- Input is an exact `@handle` or signed numeric chat ID. Strip surrounding whitespace only; reject links and extra tokens in this flow.
- Resolve via `getChat`, require `type=channel`, show canonical ID/title/handle, then confirm.
- A private channel generally requires its numeric ID because it has no public handle.
- Adding an existing channel refreshes metadata and reports “already whitelisted.”
- Removing requires confirmation and affects waiting items immediately.
- Refuse to whitelist the queue or destination channel accidentally; these IDs do not make sense as source-policy entries.

### 19.6 Author alias flows

- Browse observed known users by last seen, display name, username, stable ID, and existing alias.
- Entering `@username` resolves only against `known_authors`; it never claims to query all Telegram users.
- Confirm the resolved stable ID before saving an alias.
- Alias update/removal affects waiting items immediately.
- Hidden-user origins are shown as non-aliasable. Two hidden users with the same display string are never merged.

### 19.7 Prompt and callback safety

- Prompts expire after 15 minutes and must be replies to the expected bot message when `ForceReply` is used.
- Callback data contains only a version/action prefix and short random token; payload lives in SQLite.
- Validate token ownership, expiry, unconsumed status, current item version, and admin ID.
- Always answer callback queries promptly, even when stale, to clear the Telegram loading spinner.
- Treat arbitrary callback payloads as untrusted input and fail closed.

## 20. Security and privacy

- Authenticate the administrator exclusively by numeric `ADMIN_USER_ID`; never by username or display name.
- Restrict management to a private chat with the bot.
- Keep `.env`, SQLite database, WAL/SHM files, backups, and logs out of Git. `.gitignore` must cover them.
- Create the data directory with mode `0700` and database/backups with `0600` where the platform permits.
- Never log `BOT_TOKEN`, authorization URLs containing it, full update JSON, private message bodies, captions, contact phone numbers, or precise locations in normal logs.
- Snapshot JSON should retain only fields needed to reproduce content/policy. Sensitive content types such as contact/location are still present in Telegram; avoid duplicating their data in audit logs.
- Sanitize all user-controlled text shown in admin messages. Prefer plain text; if HTML is used, escape every value.
- Cap inbound admin text length before parsing and use strict numeric/handle/time formats.
- Do not follow arbitrary URLs supplied in messages. Queue recovery parses Telegram links locally and validates their channel component against `QUEUE_CHANNEL_ID`.
- Backups contain private queue metadata and must receive the same permissions/retention as the live database.
- Dependency policy: exact versions in `package.json`/`bun.lock`, review lockfile changes, and no install-time scripts except those explicitly reviewed.

## 21. Observability and operations

### 21.1 Structured logging

Use dependency-free newline-delimited JSON through `console` with fields:

- timestamp, level, event name;
- item/operation/run ID;
- Telegram method and sanitized error class/code;
- duration and attempt count;
- source/destination chat role, never token or body.

Core events include ingestion, album finalization, claim, publish result, cleanup result, renewal result, schedule run, external deletion, admin mutation, rights check, lease loss, migration, and shutdown.

### 21.2 Health definition

Healthy means:

- singleton lease owned and refreshed;
- last successful long poll/update cycle within an expected window;
- SQLite writable and WAL checkpoint not persistently failing;
- queue/destination rights valid at the last check;
- no current source older than 46 hours;
- no unresolved critical/uncertain operation;
- scheduler next occurrence computable when enabled.

Run rights checks at startup and every six hours. `/health` performs a fresh read-only check when requested but does not post test messages.

### 21.3 Backups and restore

- Document a daily SQLite backup using a safe SQLite backup/VACUUM mechanism after a WAL checkpoint; do not copy only the main database while ignoring active WAL state.
- Retain seven daily backups by default.
- Restore procedure: stop bot, preserve current files, restore DB, run integrity check, start bot, inspect uncertain operations and physical source ages before enabling workers.
- An SQLite backup cannot reconstruct Telegram updates missed for over 24 hours; use recovery links/IDs for those.

### 21.4 Capacity assumptions

- One process, one queue channel, one destination channel, one admin.
- Expected queue size should be comfortably renewable inside 12 hours. At 2–10 messages per album and Bot API rate limits, thousands of items require load testing.
- Before production, run a capacity simulation using fake gateway latency/rate limits and calculate worst-case time to renew the configured maximum queue.
- If estimated renewal completion exceeds the 12-hour safety margin, alert and stop accepting the configuration as healthy; do not silently risk undeletable sources.

## 22. Expanded verification matrix

In addition to Section 8, tests must cover the following.

### 22.1 Text, entities, and names

- Empty caption plus byline; maximum-fitting and one-character-over text/caption.
- Emoji/surrogate pairs before and inside entities; combining characters; RTL ordinary text.
- Rejection of control/bidi override characters in aliases.
- Overlapping/nested entities, custom emoji entities, and malformed out-of-bounds entities.
- First-name only, first + last, no username, changed username, deleted-user-like display, bot user, hidden user.
- Alias change/removal between enqueue and publication.

### 22.2 Origin and whitelist

- Channel ID match despite changed handle/title.
- Same-looking handle with different numeric ID does not match.
- Channel, user, hidden user, chat, and absent origin.
- Mixed-origin album enters review.
- Whitelist add/remove while item waits changes the eventual operation.
- Queue/destination IDs cannot be whitelist entries.

### 22.3 Message types

- Text and every captionable media kind with/without caption.
- Album with caption on first member, later member, no member, and invalid multiple captions.
- Captionless sticker/video note/contact/location/venue/dice/poll uses two-message user attribution output.
- Quiz poll copy failure, protected content, paid media, giveaway, invoice, service, and unknown future type.
- Source reply/quote/inline keyboard does not create unsafe reconstructed metadata.

### 22.4 Albums and partial API behavior

- 2 and 10 members; 11th member quarantines collection.
- Out-of-order arrival, duplicates, delayed last member, restart while collecting.
- Multi-call returns equal, fewer, empty, throws before send, and throws ambiguously after partial send.
- Partial destination outputs are deleted before retry.
- A missing member removes the whole logical album and best-effort cleans remaining source members.

### 22.5 Scheduling

- Midnight `00:00`, end-of-day `23:59`, duplicate slots, invalid formats.
- Timer early/late wakeups and repeated scans of the same minute.
- Process down across one slot, several slots, midnight, and many days.
- Clock moves forward/backward; unique run prevents duplicates.
- Pause/resume and slot edits immediately before/at/after a boundary.
- Concurrent manual publish and scheduled slot produce at most one active publication and no item duplication.

### 22.6 Renewal and age limits

- Exact 36h eligibility and 42/46/47h warnings.
- Renewal retains origin metadata and logical sequence.
- Original direct post remains semantically originless after copy renewal.
- Crash at every renewal checkpoint.
- Replacement succeeds but old deletion fails/ages past 48h, producing orphan cleanup.
- Bot-created renewal updates are suppressed, including restart/race scenarios.
- Large-queue rate-limit simulation meets or fails the safety margin deterministically.

### 22.7 Persistence and recovery

- Every migration from empty and previous schema fixtures.
- Unique constraints and foreign-key cascades.
- SQLite busy/disk-full/read-only/corrupt JSON behavior.
- Unclean shutdown at every crash-matrix row.
- Expired vs actively refreshed leases and accidental second instance.
- Audit retention purges bodies only for terminal items, never active/uncertain ones.

### 22.8 Admin and security

- Wrong user, group chat, channel post, forged callback, replayed token, expired prompt, stale item version.
- UTF-8 callback byte length stays <=64.
- HTML/Markdown-looking alias, channel title, and Telegram name cannot inject formatting.
- Destructive confirmation required and double press idempotent.
- Recovery rejects another channel's public/private link and malformed/huge ID lists.
- Logs/snapshots do not contain the token or prohibited sensitive fields.

### 22.9 Test levels and gates

- **Unit:** pure policy, parsing, formatting, scheduler calculation, error classification.
- **Repository:** real temporary SQLite files, migrations, constraints, restart behavior.
- **Service:** fake clock + scripted fake Telegram gateway, including ambiguous failures.
- **Handler:** synthetic grammY updates/callbacks with authorization checks.
- **Manual sandbox:** real disposable bot/queue/destination for Bot API behavior that cannot be faithfully mocked.

Required CI/local commands:

```sh
bun test
bun test --coverage
bunx tsc --noEmit
```

Target at least 90% line coverage for `domain`, `services`, and database state-transition code. Coverage is not a substitute for the manual Telegram compatibility checklist.

## 23. Mandatory real-Telegram compatibility checklist

Before feature implementation is considered safe, use a disposable bot and channels to record these results in `docs/telegram-compatibility.md`:

1. grammY long polling works under the pinned Bun version and receives queue `channel_post`/edit updates.
2. Re-forwarding a forwarded channel post back into the same private queue retains the original channel in `forward_origin`.
3. Re-forwarding a known-user and hidden-user forward retains the correct origin form/name.
4. `forwardMessages` and `copyMessages` preserve an album and return output IDs in source order when all members exist.
5. Behavior when one album source ID is deleted: returned count/error and whether Telegram emits partial destination messages.
6. Copy + edit text preserves entities, custom emoji, link previews where applicable, and accepts the appended byline.
7. Copy with replacement media caption and album caption editing behaves as planned.
8. Captionless user-origin content plus separate attribution message appears acceptably in the destination.
9. Queue renewal messages generate channel-post updates that suppression logic can recognize.
10. Bot can delete queue sources and its destination/renewal outputs with configured rights; test near but not beyond the deletion limit with artificially aged behavior where feasible.
11. Protected/unsupported content produces the expected Bot API errors without source deletion.
12. Private-channel message links/IDs used by recovery are parsed and accessible as planned.

Any failed checklist item updates this plan before implementation. In particular, failure of origin preservation during renewal is a product-level blocker under the chosen Bot API design.

## 24. Implementation deliverables and completion gates

### Gate A — foundations

Deliver config validation, exact dependency lock, SQLite migrations, singleton lease, structured logs, fake clock/gateway, and green foundational tests.

Exit criteria: process starts/stops cleanly, rejects invalid config, and a second instance cannot schedule work.

### Gate B — Telegram proof

Complete Section 23 in disposable channels and commit the results.

Exit criteria: renewal origin preservation, album behavior, byline editing, and deletion assumptions are empirically verified. Stop here if the renewal blocker fails.

### Gate C — ingestion and policy

Deliver single/album ingestion, edits, semantic-origin snapshots, whitelist/author repositories, alias rules, and queue dashboard read view.

Exit criteria: all supported synthetic updates produce deterministic logical items and no duplicate update produces a duplicate item.

### Gate D — publication and cleanup

Deliver policy-driven forward/copy/byline paths, operation/output records, strict FIFO, partial cleanup, retries, uncertain-state UX, and manual publish/delete.

Exit criteria: crash-matrix service tests pass and no known failure path deletes a source prematurely.

### Gate E — scheduler and renewal

Deliver UTC slots/runs, missed-slot behavior, renewal generations, self-update suppression, orphan cleanup, warnings, and capacity calculation.

Exit criteria: deterministic fake-clock tests cover boundaries/restarts, and sandbox renewal works end to end.

### Gate F — admin completion and operations

Deliver all commands/menus/prompts, recovery, health/alerts, backups/restores, permissions documentation, and deployment guide.

Exit criteria: full automated suite/coverage/typecheck pass, sandbox acceptance criteria pass, and the README contains setup, operational limits, recovery, and upgrade procedures.

## 25. Internal module contracts

The implementation should keep Telegram/framework details out of domain and orchestration code.

### 25.1 `TelegramGateway`

Expose only operations the application needs:

```ts
interface TelegramGateway {
  getBotIdentity(): Promise<BotIdentity>;
  getChat(chatIdOrHandle: ChatRef): Promise<ResolvedChat>;
  getBotMembership(chatId: ChatId): Promise<BotMembership>;

  forwardMessages(input: TransferMessagesInput): Promise<SentMessageIds>;
  copyMessages(input: TransferMessagesInput): Promise<SentMessageIds>;
  editText(input: EditTextInput): Promise<void>;
  editCaption(input: EditCaptionInput): Promise<void>;
  sendText(input: SendTextInput): Promise<SentMessageId>;
  deleteMessages(chatId: ChatId, messageIds: readonly MessageId[]): Promise<void>;

  sendAdminMessage(input: AdminMessageInput): Promise<SentMessageId>;
  editAdminMessage(input: EditAdminMessageInput): Promise<void>;
  answerCallbackQuery(input: AnswerCallbackInput): Promise<void>;
}
```

Rules:

- `ChatId` and `MessageId` are branded TypeScript numbers to prevent argument reversal.
- Transfer input requires strictly increasing, non-empty message IDs and rejects more than 100 before calling Telegram.
- The adapter returns normalized IDs only; services never depend on grammY `Context` or raw API result shapes.
- The adapter maps all exceptions into the error union in Section 18 while retaining a safe `cause` for debug logs.
- Admin rendering lives above the gateway; the gateway does not contain business rules.

### 25.2 Repository contracts

`QueueRepository`

- ingest single/member, finalize album, update snapshot;
- select/claim FIFO head with compare-and-swap;
- claim renewal candidates;
- install new source generation;
- record outputs and state transitions;
- mark external/admin deletion;
- list paginated active/history items.

`ScheduleRepository`

- list/add/remove slots;
- materialize unique occurrences;
- record terminal run outcome;
- store/advance last scan.

`PolicyRepository`

- resolve current whitelist membership;
- list/add/remove channels;
- observe user identity;
- resolve/set/remove alias.

`OperationRepository`

- create/refresh/expire leases;
- record outputs one at a time;
- list recoverable/uncertain operations;
- add/resolve orphan cleanup.

Repositories accept an optional transaction object so multi-table invariants commit atomically. They do not call Telegram or render UI.

### 25.3 Service contracts

- `IngestionService`: Telegram update DTO -> durable logical queue mutation.
- `OriginPolicyService`: immutable snapshot + current policy -> pure publication plan.
- `PublicationService`: claim -> Telegram calls -> durable output -> cleanup.
- `RenewalService`: age scan -> generation replacement -> old-generation cleanup.
- `SchedulerService`: UTC clock + slots -> idempotent run -> one publication request.
- `AdminService`: authorized intent -> validated mutation/confirmation -> rendered view model.
- `RecoveryService`: validated source ID/link -> temporary inspection -> queue insertion.
- `HealthService`: aggregate rights, leases, ages, state counts, polling, and database checks.

Every service receives `Clock`, logger, repositories, and gateway through explicit constructors. Avoid global mutable singletons other than the composition root in `src/index.ts`.

### 25.4 Domain types

Use discriminated unions for:

- semantic origin;
- supported content class;
- publication plan (`forward`, `copy`, `copy_with_inline_byline`, `copy_with_separate_byline`, `blocked`);
- item/operation state;
- normalized Telegram error;
- admin prompt state.

Exhaustive `switch` statements must compile with a `never` check so new Bot API/type variants do not fall through silently.

## 26. Build, runtime, and deployment specification

### 26.1 TypeScript/Bun configuration

- ESM project (`"type": "module"`).
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useUnknownInCatchVariables`, and `noFallthroughCasesInSwitch` enabled.
- No transpilation step is required for production; run TypeScript directly with Bun after `tsc --noEmit` in CI/release.
- Define and enforce a minimum tested Bun version in `package.json` engines/documentation and pin it in the deployment image/toolchain.
- Commit `bun.lock` and install with the frozen-lockfile option in CI/deployment.

Suggested scripts:

```json
{
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "start": "bun src/index.ts",
    "test": "bun test",
    "test:coverage": "bun test --coverage",
    "typecheck": "tsc --noEmit",
    "check": "bun run typecheck && bun run test"
  }
}
```

### 26.2 Deployment requirements

- Do not deploy to stateless/serverless execution: the design depends on an always-on long-poll process, in-process timers, and durable local SQLite.
- Deploy exactly one replica with a persistent volume containing the database, WAL/SHM files, and backups.
- Use a supervisor with automatic restart and bounded backoff, such as systemd or one Docker container with a restart policy.
- Ensure the host clock is synchronized. The application displays/configures UTC, but scheduling correctness still depends on system time.
- Provide enough shutdown grace for the 30-second application checkpoint plus supervisor overhead.
- The runtime account needs write access only to the data/log location and no unnecessary host privileges.
- Outbound network access is required only to Telegram API endpoints unless deployment monitoring adds another destination.

### 26.3 Initial Telegram setup

1. Create the bot with BotFather and store the token only in deployment secrets.
2. Add the bot as an administrator to the private queue channel with `can_post_messages` and `can_delete_messages`; posting is needed for renewal and deletion is needed for generation cleanup.
3. Add it as an administrator to the destination channel with `can_post_messages`, `can_edit_messages`, and `can_delete_messages` so byline edits and partial-output rollback have explicit rights rather than relying on narrower implicit own-message behavior.
4. Start a private chat from the configured admin account so the bot can send alerts.
5. Record numeric queue/destination/admin IDs in `.env`.
6. Start with scheduling paused, run `/health`, complete sandbox/rights checks, configure UTC slots, then resume.

### 26.4 README runbook requirements

Document exact procedures for:

- install/start/update/rollback;
- adding/removing channel rights without losing queue safety;
- configuring slots, whitelist, and aliases;
- handling blocked/uncertain items;
- cleaning orphaned >48-hour physical messages;
- recovering messages after >24-hour downtime;
- backup, integrity check, restore, and disaster recovery;
- rotating `BOT_TOKEN`;
- moving the database to a new host without two active pollers;
- interpreting health output and structured logs.
