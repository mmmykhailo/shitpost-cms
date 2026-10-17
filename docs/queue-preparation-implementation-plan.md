# Historical implementation plan: prepared Telegram queue and hidden-sender nicknames

This is the original 2026-10-15 design handoff, not a statement of current implementation status. Its open implementation tasks have been superseded by the [2026-10-17 reliability decisions](telegram-reliability.md) and [reliability implementation plan](telegram-reliability-implementation-plan.md). In particular, the current rule freezes the whole logical post after any accepted admin edit.

The [2026-10-17 reliability decisions](telegram-reliability.md) supersede this plan wherever it permits nickname refresh after an admin body edit or leaves flood-wait recovery, retained replies, and scheduled retries undefined. Any admin edit now freezes the whole logical post permanently.

Status: historical implementation handoff, written 2026-10-15. It consolidates the product decisions from the interview and code investigation as they stood then. Its task list is superseded by the reliability implementation plan; consult the latter for current behavior and verification.

Audience: an implementing coding model that needs explicit scope, repository locations, interfaces, ordering, failure rules, and acceptance tests. Implement the entire plan when asked to implement it. Do not reopen settled product questions, introduce a second Telegram connection, or silently reduce the scope to nickname lookup alone.

## 1. Goal and nonnegotiable behavior

The queue channel must show the prepared post that will be published. Transformation happens promptly after ingestion, including the existing short album-collection delay. Scheduled publication transfers that prepared representation without adding attribution a second time.

### 1.1 Product requirements

1. A forwarded identifiable-user post becomes a copy with a plain-text credit: two newlines followed by "by <nickname or Telegram display name>" for text/caption content.
2. A privacy-hidden user can have a persistent nickname. The key is the exact forwarded sender name, separate from identifiable-user ID aliases.
3. A forwarded post from a repostable/whitelisted channel retains its original forwarding attribution.
4. An unlisted-channel post becomes a copy without a generated user credit. Chat origins and direct queue posts retain their existing policy.
5. Capture channel forwarding policy when a new item enters the ingestion pipeline. Subsequent whitelist changes affect only later enqueues, including when an earlier item's preparation was delayed or failed.
6. At rollout, capture current channel policy once for legacy waiting items and prepare them without changing their item numbers, logical order, or initial enqueue timestamps.
7. Setting, replacing, or removing a nickname updates matching waiting posts' untouched generated credits. Complete the visible refresh before those posts can publish.
8. An admin's content, media, formatting, and byline edits take precedence. Do not rebuild from the original submission and overwrite them.
9. If the admin removes or rewrites a generated credit, later nickname updates must not recreate or replace it.
10. If the admin deletes part of an album or another multi-message post, publish the surviving representation as left by the admin. Do not recreate the removed content, move its caption onto another member, or raise an issue merely because of a confirmed intentional deletion.
11. Discover missing messages during ordinary copy/forward attempts. There is no requirement for immediate deletion detection, periodic existence probes, MTProto, extra API credentials, or personal-account sessions.
12. When all current messages are confirmed gone, remove the item from the active queue. Retain existing terminal/audit history and retention rules.
13. Mark real problems as issues and notify the configured admin privately. An issue item must not block later ready posts.
14. At a scheduled slot, select the earliest eligible item. Continue to later candidates after a definite failure that produced no output. Stop after one successful logical publication, an attempt with possible destination output, no candidates, or a global failure.
15. An issue detected outside a scheduled slot does not cause an unscheduled publication. Manual publish-next uses the same eligibility and fallback rules.
16. A publication that might have succeeded consumes its slot. Never automatically resend that item. Hold it for explicit resolution while later ready posts remain eligible for later slots.
17. A bot-wide outage, flood wait, or destination-access problem stops the run and raises a shared problem. Do not fault every post individually.
18. Notify once per new issue or materially changed issue, and again after a resolved issue recurs. Do not repeat an unchanged issue every minute. Retry failed notification delivery independently.
19. Corrective admin edits automatically revalidate failed preparation and return a valid item to normal scheduling. No Retry click is required for an ordinary corrective edit.
20. A repaired item keeps its original logical position among remaining posts. Moving it to the end remains an explicit action.
21. "Exact prepared post" covers content, formatting, media, ordering, album grouping, and forwarding attribution. Telegram-generated timestamps, reactions, views, and live/interactive state follow Telegram's transfer behavior.
22. Recover untracked queue messages as shown by default, with an optional explicit action to apply preparation rules. Restore known sender metadata if available; do not infer an original author from copied content.
23. A shorter album-transfer result that does not establish which members disappeared or why requires review. Preserve the originals and known output evidence, notify the admin, and do not automatically repeat the send.
24. Preserve originals until a complete prepared replacement is durably recorded. Install the complete replacement before deleting its originals. Cleanup failures after installation are separate cleanup work.
25. Preserve the existing renewal deadline behavior: renewal starts at 36 hours of physical source age, keeps logical queue age/order, runs while publishing is paused, honors flood waits, and requires resolution for uncertain replacements.

### 1.2 Hidden-name identity examples

| Input | Required result |
| --- | --- |
| Hidden name "Alex", nickname "Professor" | Every hidden origin with exactly "Alex" uses "Professor" unless its credit was manually overridden |
| A different hidden person also named "Alex" | Shares that nickname; this ambiguity is explicitly accepted |
| Hidden "alex" | Different key |
| Hidden " Alex" or "Alex " | Different keys; do not trim lookup keys |
| Visually similar names with different Unicode sequences | Different keys; do not normalize Unicode |
| Identifiable user whose display name is "Alex" | Uses only the existing identifiable-user alias system |
| Hidden sender later changes name to "Alex Smith" | Does not match "Alex" |
| Hidden name is sanitized to "Unknown" for UI | Lookup still uses the original exact string; never use "Unknown" as its key |

### 1.3 Do not implement these alternatives

- No second Telegram connection or MTProto observer.
- No user login, new developer API ID/hash, one-minute deletion check, no-op edit probe, or temporary forwarding solely to check existence.
- No strict FIFO head blocking on a content issue.
- No automatic attribution regeneration after admin override.
- No publish-time nickname or whitelist recalculation for an already prepared post.
- No silent text/caption truncation.
- No automatic retry of a send that may already have produced output.
- No treating a successful but shorter album transfer as proof of intentional deletion.
- No publishing an unprepared legacy row through the new prepared-only path.
- No source/destination snapshots fabricated by assigning a shorter result to the first N original members.

## 2. Repository baseline: read these before changing code

Runtime is Bun with TypeScript, SQLite via bun:sqlite, and grammY 1.38.4. Keep that stack. Package scripts are:

~~~sh
bun run typecheck
bun test
bun run check
bun run check:all
~~~

The last command runs typecheck, all tests, coverage gate, and deployment script tests. Do not weaken coverage thresholds to make the new change pass.

| Area | Existing locations and behavior |
| --- | --- |
| Types | src/types.ts; source snapshots are currently schemaVersion 1 |
| Logical queue | src/domain/queue-item.ts and createQueueRepository in src/db/repositories.ts |
| Schema | src/db/migrations.ts; latest current migration is version 3 |
| SQLite wrapper | src/db/database.ts; foreign keys ON, WAL, BEGIN IMMEDIATE transactions |
| Origin/content policy | src/domain/origin-policy.ts; hidden users currently ignore aliases |
| Credit validation | src/domain/byline.ts; 1–64 Unicode code points, safe plain text |
| Incoming messages | src/handlers/queue-channel.ts and src/services/ingestion.ts |
| Pending input | src/db/pending-update-repository.ts; normally waits 2 seconds before finalization |
| Albums | Queue repository collects with 2-second quiet window and 10-second maximum |
| Publication | src/services/publisher.ts currently resolves policy, copies/forwards, then adds credit at publication |
| Renewal | src/services/renewal.ts currently chooses copy only for absent origin, otherwise forwards |
| Renewal worker | src/services/renewal-worker.ts; preserve pacing/backoff/cooldown behavior |
| Scheduling | src/services/scheduler.ts; currently invokes strict-head publication once per slot |
| Telegram adapter | src/telegram.ts; bulk copy/forward returns destination IDs, not source mappings |
| Errors/cooldown | src/errors.ts and src/telegram-cooldown.ts |
| Admin UX | src/handlers/admin.ts; /authors only handles IDs/@observed_username today |
| Alerts | src/services/alerts.ts, src/db/alert-repository.ts, and alert loop in src/application.ts |
| Recovery | src/services/recovery.ts plus src/db/recovery-repository.ts |
| Startup/recovery | queue.recoverExpiredOperations in src/db/repositories.ts; called by src/application.ts |
| Retention/health | src/services/retention.ts, src/services/health.ts, src/services/capacity.ts |
| Test helpers | test/support.ts, test/fixtures.ts, src/clock.ts |

There is no restoreRuntimeState function. src/services/restore.ts restores backup files; it is not the operation-recovery dispatcher.

### 2.1 Existing code that must change

- displayNameForOrigin ignores aliases for hidden_user.
- observeAuthor, aliasForOrigin, setAlias, removeAlias, listAuthors operate only on known users.
- getHead returns the earliest nonterminal row, even when blocked.
- claimPublication reselects getHead inside its transaction.
- publishNext stops when that head is unsafe.
- classifyPublicationPlan and byline editing currently run at publication time.
- Current renewal would introduce queue-channel forwarding attribution when given a prepared user copy.
- Generated-message suppression is one-shot by message ID and supports only renewal/recovery kinds.
- Edited-channel handling updates snapshots before checking whether an edit was bot-generated.
- Existing alert loop reports blocked/edit/review conditions mostly for the head.
- Existing alert repository repeats notifications after severity-dependent time windows.
- Current recovery assumes a single source or a compatible Telegram album.
- Snapshot validation reconstructs a fixed field set; newly written optional fields will be lost unless the reader/validator is extended.
- Existing publication contract validation assumes source count plus an optional extra credit. New prepared delivery must use a versioned contract instead.

### 2.2 SQL constraints: do not "just add a TypeScript union"

Existing SQL CHECK constraints limit:

| Column | Allowed current values relevant here |
| --- | --- |
| operations.type | publish, manual_publish, renew, delete, recover |
| generated_messages.kind | renewal, recovery_preview |
| queue_items.status | Existing collecting/publication/issue/terminal statuses only |
| queue_items.maintenance_status | idle, renewing, renewal_cleanup_pending, uncertain_renewal |
| pending_queue_updates.state | pending, quarantined_renewal_candidate, consumed_generated, ingested, discarded |
| operation_outputs.kind | destination, replacement, temporary_preview |

Use the additive design below. It intentionally avoids rebuilding these tables.

Do not disable foreign keys inside a migration transaction. Do not rename/drop operations or queue_items casually: child tables use CASCADE and SET NULL relationships. Do not rewrite migrations 1–3.

Other constraints:

- queue_messages has UNIQUE(queue_chat_id, telegram_message_id) across all generations.
- operation_outputs has UNIQUE(chat_id, telegram_message_id) across all operations.
- A deletion must therefore tombstone membership; it must not create another generation that reuses surviving Telegram IDs.
- Two separate output tables do not automatically enforce cross-table output ownership. Check both stores transactionally.
- The repository transaction helper starts BEGIN IMMEDIATE. Do not call another transaction-wrapped public repository method from inside one of these transactions; extract transaction-local helpers.

## 3. Concrete implementation architecture

Use these new modules unless an existing equivalent is found during implementation:

| New module | Responsibility |
| --- | --- |
| src/domain/prepared-post.ts | Prepared member/step types, readiness, contract construction |
| src/domain/attribution.ts | Generated-credit ownership and safe refresh decisions |
| src/db/preparation-repository.ts | Preparation/refresh claims, contracts, outputs, restart evidence |
| src/db/generated-event-repository.ts | Persistent bot post/edit expectations, matching and quarantine support |
| src/services/preparation.ts | Initial preparation and attribution refresh |
| src/services/preparation-worker.ts | Prompt background draining, cleanup, retry/recovery integration |
| src/services/prepared-transfer.ts | Shared ordered single/album transfer mechanics; no policy lookup |
| test/preparation.test.ts | Service integration with real temporary SQLite |
| test/preparation-worker.test.ts | Worker progress, pause independence, cooldown and restart |
| test/attribution.test.ts | Ownership and edit-preservation cases |
| test/prepared-transfer.test.ts | Missing members, groups, partial results, output evidence |

Keep logical queue state, preparation readiness, and physical maintenance separate:

- Existing queue_items.status still expresses collecting, queued, publishing, issue, and terminal states.
- New preparation_state expresses whether the current source is ready for prepared publication.
- Existing maintenance_status continues to express renewal state.
- A preparation_operation_id owns initial preparation or refresh.
- Publication, renewal, preparation/refresh, and admin deletion must all check the other owners before claiming an item.
- A prepared post may stay ready while old-generation cleanup is pending, provided cleanup cannot mutate its current representation. Active replacement/refresh uncertainty is not ready.

Do not add a new operation type to the existing operations table under the additive design. Store preparation and refresh in their dedicated table, with their own reconciler. Existing publication/renewal contracts remain in operations.

## 4. Data model and migration 4

Recheck the current highest migration number before implementing. It is 3 at handoff, so the next migration is 4. If another change has added a migration, append after it and update affected tests.

The following names are the proposed implementation contract. Keep them consistent across SQL, types, validators, services, and tests.

### 4.1 Add columns without changing existing CHECK enums

Add to queue_items:

~~~sql
preparation_state TEXT NOT NULL DEFAULT 'unprepared'
  CHECK (preparation_state IN
    ('unprepared','preparing','ready','refresh_pending','refreshing','failed','uncertain')),
representation_kind TEXT NOT NULL DEFAULT 'raw'
  CHECK (representation_kind IN ('raw','prepared')),
delivery_mode TEXT CHECK (delivery_mode IN ('copy','forward')),
policy_captured_at INTEGER,
prepared_at INTEGER,
preparation_operation_id TEXT,
nickname_revision_wanted INTEGER NOT NULL DEFAULT 0,
nickname_revision_applied INTEGER NOT NULL DEFAULT 0,
attribution_json TEXT
~~~

Column notes:

- delivery_mode is the prepared channel delivery decision, not a license to re-forward prepared user copies.
- representation_kind is needed even when preparation_state is failed. Renewal must distinguish a failed raw input from a prepared post whose refresh failed.
- attribution_json contains the validated ownership descriptor defined in section 5.
- A prepared item with an admin-owned/removed credit does not need refresh just because a nickname revision increases.
- Do not add a foreign key from preparation_operation_id unless the creation/backfill/recovery ordering is explicitly covered. Existing owner IDs also use guarded references rather than universal FKs.

Add to queue_messages:

~~~sql
member_key TEXT,
member_role TEXT NOT NULL DEFAULT 'content'
  CHECK (member_role IN ('content','credit')),
member_delivery_mode TEXT CHECK (member_delivery_mode IN ('copy','forward')),
album_key TEXT,
removed_at INTEGER,
removal_reason TEXT
~~~

Backfill member_key deterministically, for example "legacy:" plus the Telegram message ID. Use the same member key when a source member gets a new Telegram ID during full replacement. It identifies a logical member within that item, not a global person or Telegram object.

Add a unique index on (item_id, source_generation, member_key) where member_key IS NOT NULL. Keep the existing global Telegram-ID uniqueness.

A member is active only when it belongs to the item's current source_generation and removed_at IS NULL. Historical/captured access must remain possible.

Every ready prepared member must have a non-null member_delivery_mode. New publication/renewal steps derive mode from this column, so recovered bundles can preserve a forwarded member alongside a plain copied member. For raw legacy rows, derive raw-preserving renewal mode from native/original forwarding metadata when backfilling; initial preparation still uses the item's captured target policy. Item delivery_mode is the default preparation policy, not a substitute for member-specific prepared delivery metadata.

Add to known_authors:

~~~sql
alias_revision INTEGER NOT NULL DEFAULT 0
~~~

Add nullable progress_json TEXT to existing operations for new version-2 publication/renewal execution progress. Leave it null and retain old behavior for already captured legacy operations. Its concrete structure is specified in section 5.1.

Add to pending_queue_updates:

~~~sql
update_kind TEXT NOT NULL DEFAULT 'post'
  CHECK (update_kind IN ('post','edit')),
telegram_update_id INTEGER,
captured_delivery_mode TEXT
  CHECK (captured_delivery_mode IN ('copy','forward')),
policy_captured_at INTEGER
~~~

Capture incoming channel policy at initial receipt, before the 2-second pending delay. On an upsert for the same submission, do not overwrite that captured policy. For an album, the queue item's initial capture wins over subsequent members arriving after a whitelist change. Edited posts are not new enqueues.

### 4.2 Hidden-author tables

~~~sql
CREATE TABLE known_hidden_authors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_name TEXT NOT NULL COLLATE BINARY UNIQUE,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  alias_revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE hidden_author_aliases (
  hidden_author_id INTEGER PRIMARY KEY,
  nickname TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by_admin_id INTEGER NOT NULL,
  FOREIGN KEY (hidden_author_id)
    REFERENCES known_hidden_authors(id) ON DELETE CASCADE
);
~~~

Use a numeric hidden-author ID in buttons and prompt state; resolve it to the exact stored name. The exact string remains the identity key. Do not fit raw names into callback_data or split a combined "name nickname" string.

### 4.3 Preparation-operation table

Create queue_preparation_operations with at least these fields:

| Field | Type / requirement |
| --- | --- |
| id | TEXT PRIMARY KEY, random operation ID |
| item_id | INTEGER NOT NULL, FK to queue_items |
| kind | TEXT CHECK prepare or refresh |
| state | TEXT CHECK running, outputs_recorded, cleanup_pending, uncertain, done, failed |
| phase | TEXT NOT NULL; use phases in section 8 |
| boot_id | TEXT NOT NULL |
| lease_expires_at | INTEGER NOT NULL |
| captured_content_version | INTEGER NOT NULL |
| captured_source_generation | INTEGER NOT NULL |
| target_source_generation | INTEGER; null for in-place refresh |
| source_ids_json | TEXT NOT NULL; immutable captured source IDs |
| contract_json | TEXT NOT NULL; validated PreparationContractV1 |
| progress_json | TEXT NOT NULL; validated execution progress from section 5.1 |
| result_json | TEXT; complete prepared-member snapshots/ownership and installed result |
| return_item_status | TEXT NOT NULL |
| error_code / error_json | nullable TEXT |
| created_at / updated_at | INTEGER NOT NULL |

Index (state, lease_expires_at) and (item_id, created_at). FK to queue_items may use ON DELETE CASCADE consistently with existing operation history; terminal queue rows are retained under current retention.

Create queue_preparation_outputs:

~~~sql
CREATE TABLE queue_preparation_outputs (
  operation_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  output_key TEXT NOT NULL,
  step_key TEXT NOT NULL,
  source_member_key TEXT,
  role TEXT NOT NULL CHECK (role IN ('content','credit')),
  snapshot_json TEXT,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, chat_id, telegram_message_id),
  UNIQUE (chat_id, telegram_message_id),
  FOREIGN KEY (operation_id)
    REFERENCES queue_preparation_operations(id) ON DELETE CASCADE
);
~~~

Before inserting, reject ownership by another operation in either this table or existing operation_outputs. An in-place refresh does not claim the current message as a newly created output; it records mutation evidence in its contract/result and generated-event expectations.

output_key is an output-only identity, for example the operation ID plus returned message ID; it is not proof of source association. source_member_key is nullable specifically so a shorter/malformed album response can be recorded without guessing which input produced it. ordinal is returned output order, not an inferred original-source index. Complete installation requires validated source associations; provisional/unmapped evidence is not a complete prepared result.

### 4.4 Generated-event expectations

Create queue_generated_events with:

- id TEXT PRIMARY KEY.
- operation_family TEXT: preparation, publication, renewal, recovery.
- operation_id TEXT NOT NULL.
- chat_id INTEGER NOT NULL.
- message_id INTEGER NOT NULL.
- event_kind TEXT CHECK post or edit.
- expected_fingerprint TEXT.
- expected_snapshot_json TEXT when available.
- state TEXT CHECK pending, matched, obsolete.
- created_at INTEGER NOT NULL, matched_at INTEGER nullable.
- Index on (chat_id, message_id, event_kind, state).
- Index on (operation_family, operation_id).

There can be several expected edits for one message. Do not make message_id globally unique in this table.

For new posts whose IDs are unknown before sending, persist the immutable step and transfer_pending phase in the operation contract before the API call; create/bind post expectations only after returned IDs are known. For edits to existing messages, create the expected edit row before calling Telegram because the target ID is already known. Early post updates remain in pending/quarantine and are associated only after output IDs are confirmed. Do not create a fake or null Telegram ID to satisfy a pre-request post expectation.

The existing generated_messages table can remain for backward compatibility. Wrap old/new suppression behind the new service/repository; do not write a new preparation kind into its old CHECK.

### 4.5 Version snapshots and contracts explicitly

Define StoredMessageSnapshotV2 while keeping v1 parsing:

- Retain existing text/caption/entity/date/content fields and original semantic origin compatibility.
- Include the observed native origin separately when it differs from the item's original semantic origin.
- Retain known link-preview options and actual inline markup when needed to preserve edits. hasReplyMarkup alone is not enough to reconstruct markup.
- Include a deterministic content/media fingerprint from relevant Telegram payload fields so replacing media without changing the caption still invalidates stale work.
- Persist Telegram update ID where available to distinguish same-second edits; edit_date alone is insufficient.
- Do not include reaction/view counters in the content fingerprint.
- Do not store bot credentials, entire Context objects, or circular raw SDK objects.
- Preserve media by native Telegram copying; this plan does not introduce a general media-download/reupload pipeline.

Update snapshotFromMessage and both write/read validators together. Old v1 fixtures must remain readable and have conservative defaults. Never infer bot ownership of a byline from a v1 text suffix alone.

Version new publication contracts. Keep existing frozen v1 contracts readable. Do not reinterpret an old in-flight publication as already prepared.

### 4.6 Item-issue delivery fields

Use additive columns on admin_alerts for item-issue notification state; keep existing operational alerts in their current mode:

~~~sql
notification_mode TEXT NOT NULL DEFAULT 'periodic'
  CHECK (notification_mode IN ('periodic','on_change')),
condition_fingerprint TEXT,
sent_fingerprint TEXT,
payload_json TEXT,
delivery_retry_not_before INTEGER,
delivery_attempts INTEGER NOT NULL DEFAULT 0
~~~

New item-issue rows use notification_mode = on_change and a stable dedupe key such as item_issue:<item-id>. payload_json stores the latest item/reason/link context and action descriptors, not expiring callback tokens. Generate fresh single-use tokens only when sending a notification. A changed fingerprint or resolved-then-reopened condition clears the delivered marker and schedules one notification; a retry of the same unchanged issue updates evidence/payload without resetting delivery state. Mark sent_fingerprint only after a confirmed send. Keep old severity-based repetition for unrelated periodic operational alarms.

Shared publishing outages, flood-wait conditions, and destination-permission failures also use on_change delivery with a shared condition key instead of one key per item. Include their operation IDs and changing retry deadlines in payload, not in material-condition identity. Existing separately scoped renewal-deadline alarms can retain their operational escalation rules.

## 5. Types and invariants

Add domain types equivalent to:

~~~ts
type AuthorTarget =
  | { kind: "user"; userId: UserId }
  | { kind: "hidden_name"; hiddenAuthorId: number };

type PreparationState =
  | "unprepared" | "preparing" | "ready"
  | "refresh_pending" | "refreshing" | "failed" | "uncertain";

type PreparedMember = {
  memberKey: string;
  messageId: MessageId;
  role: "content" | "credit";
  deliveryMode: "copy" | "forward";
  albumKey?: string;
  snapshot: StoredMessageSnapshot;
};

type AttributionDescriptor =
  | { ownership: "none" }
  | { ownership: "admin"; previousMemberKey?: string }
  | {
      ownership: "bot";
      placement: "inline_text" | "inline_caption" | "separate";
      memberKey: string;
      generatedText: string;
      generatedStartUtf16: number;
      generatedLengthUtf16: number;
      appliedNicknameRevision: number;
    };

type TransferStep = {
  stepKey: string;
  mode: "copy" | "forward";
  grouped: boolean;
  members: readonly PreparedMember[];
};

type PreparationContractV1 = {
  version: 1;
  kind: "prepare" | "refresh";
  itemId: number;
  capturedContentVersion: number;
  capturedSourceGeneration: number;
  originalOrigin: SemanticOrigin;
  deliveryMode: "copy" | "forward";
  capturedMembers: readonly PreparedMember[];
  steps: readonly TransferStep[];
  targetNicknameRevision: number;
  targetName?: string;
  attribution: AttributionDescriptor;
};

type PreparedPublicationContractV2 = {
  version: 2;
  kind: "prepared_delivery";
  capturedContentVersion: number;
  capturedSourceGeneration: number;
  sourceIds: readonly MessageId[];
  steps: readonly TransferStep[];
  expectedOutputMessageCount: number;
};
~~~

These are shapes to implement, not existing exports. Adjust readonly/branded typing to the repository style without changing the semantics.

Important invariants:

1. Item origin is original provenance; native Telegram origin is presentation. They must not overwrite each other.
2. There is exactly one owner for mutating an item's representation at a time.
3. Every outbound creation has durable "request may start" evidence before the API call.
4. Every returned output is recorded before adoption or cleanup.
5. Source cleanup only uses the captured obsolete generation, never a fresh current-source lookup.
6. Full replacement changes source_generation; edits, tombstones, and in-place credit refresh change content_version instead.
7. A complete source generation has explicit member identities, roles, grouping, and ownership; count equality alone is insufficient.
8. A known removed member stays removed through renewal, refresh, restart, and publication.
9. Successful destination output is never recreated by a cleanup worker.
10. A consumed schedule slot is never reopened during restart recovery.

### 5.1 Execution progress and ownership guards

Confirmed self-performed deletion changes membership/content_version while an operation is still running. Keep the original captured contract immutable and persist separate execution progress:

~~~ts
type ExecutionProgress = {
  version: 1;
  effectiveContentVersion: number;
  members: readonly {
    memberKey: string;
    outcome: "pending" | "sent" | "confirmed_missing";
    outputIds: readonly MessageId[];
    missingEvidence?: { method: string; code?: number; description: string };
  }[];
};

type PreparedExecutionGuard = {
  operationId: string;
  itemId: number;
  capturedContentVersion: number;
  capturedSourceGeneration: number;
  expectedContentVersion: number;
};
~~~

Initialize effectiveContentVersion/expectedContentVersion from the captured version. When the owning operation proves a particular member missing, one transaction must: verify owner, generation, current version, and that member's pending outcome; tombstone it; increment queue_items.content_version; record confirmed_missing with evidence; advance only this operation's effectiveContentVersion; and return the updated execution guard. Later steps/install compare against that persisted effective version. An unrelated admin edit changes the item version without advancing this operation's progress and must still cause a conflict.

Expected survivors/output completeness are derived from the immutable original plan plus these explicit outcomes. Do not rewrite captured_source_ids or captured_content_version to make a count check pass. Do not use an unverified shorter album response to advance this progress. All-source-missing terminalization releases the owner and completes/fails the operation without creating a credit. Persist this progress in queue_preparation_operations.progress_json or existing operations.progress_json as appropriate, and validate it during restart before permitting installation.

## 6. Repository APIs to implement

Preserve existing public APIs where needed for legacy operations. Add explicit APIs rather than making historical getMessages silently mean three different things.

### 6.1 Queue APIs

Implement equivalents of:

~~~ts
getCurrentMembers(itemId): PreparedMember[];
getCapturedMembers(itemId, generation, capturedMessageIds): PreparedMember[];
findKnownSource(chatId, messageId): {
  itemId: number;
  generation: number;
  current: boolean;
  removed: boolean;
} | undefined;

peekNextReady(now, excludedIds?): QueueItemRecord | undefined;
claimReadyPublication(operationId, type, now, expectedItem?): ClaimedItem | undefined;

markMemberMissing(guard: PreparedExecutionGuard, memberKey, evidence, now): {
  remainingCount: number;
  itemRemoved: boolean;
  nextGuard: PreparedExecutionGuard;
};

markPreparationNeeded(itemId, reason, now): void;
markNicknameRefreshNeeded(authorTarget, revision, now): void;

installPreparedGeneration(guard, completedResult, now): number;
completeInPlaceRefresh(guard, updatedMembers, attribution, revision, now): void;
~~~

Readiness predicate for new prepared publication:

~~~text
status = queued
AND preparation_state = ready
AND representation_kind = prepared
AND preparation_operation_id IS NULL
AND maintenance_status = idle
AND no active conflicting claim
AND retry_not_before is absent or due
AND at least one current active member
AND (attribution is not bot-owned
     OR nickname_revision_applied = nickname_revision_wanted)
~~~

Allow published/old-source cleanup to proceed separately without making already-published items candidates.

Every owner-release path that returns an item to waiting (renewal completion, definite no-output publication failure, preparation installation, refresh completion, and explicit resolution) must reconcile wanted/applied nickname revisions. If a bot-owned credit is stale, leave/mark refresh_pending and wake preparation work before eligibility. The independent revision predicate above remains necessary even if an owner-release path is accidentally delayed; it prevents stale ready-state publication.

A claim must select and update the same candidate inside one BEGIN IMMEDIATE transaction. Never peek candidate B, then call old claimPublication that reselects issue item A.

markMemberMissing requires current generation/version/operation ownership and definite missing-source evidence for that exact member. Advance execution progress as specified in section 5.1 and use nextGuard for later steps. Tombstone the member; preserve captured contracts. Recompute first current message link, dense display order, content eligibility, and attribution ownership without recreating deleted text.

If the last active member disappears, terminalize as deleted_external and release the operation appropriately. Do not classify missing queue cleanup after a confirmed destination send as an unpublished deletion.

### 6.2 Preparation repository

Implement:

- claimNextPreparation(now, bootId): oldest eligible pending preparation/refresh under cross-owner guards.
- persistContract before any outbound mutation.
- setPhase and recordOutput with strict ownership checks.
- recordCompleteResult only after all required post edits/credits have succeeded.
- installResult atomically with source-generation/version ownership checks.
- markFailed, markUncertain, scheduleRetry, listCleanupPending.
- heartbeatOperations(now, bootId).
- recoverExpiredOperations(now, bootId).
- operationEvidence(itemId) for admin resolution.
- guarded explicit adoption/discard/retry resolution for uncertain preparation.

Use low-level transaction-local helpers to avoid nested transactions with the queue repository.

### 6.3 Policy repository

Extend observation and lookup:

- observeAuthor handles user and hidden_user only.
- Hidden observations upsert last_seen_at against exact sender_name COLLATE BINARY.
- aliasForOrigin switches by origin kind; hidden lookup never falls through to user/username matching.
- set/remove validates nickname, audits the change, and increments that author's alias_revision only for a material change.
- In the same transaction as the alias change, advance nickname_revision_wanted for every matching nonterminal raw, unprepared, preparing, or already bot-owned prepared item. Raw/preparing items do not yet have an installed credit descriptor and must not be omitted. Mark existing bot-owned prepared credits refresh_pending when no active owner prevents that transition.
- Match by original item origin, not its prepared Telegram header.
- Keep revision-wanted state for an active publication without changing its captured contract. If it later returns to waiting after a definite no-output failure, refresh before eligibility.
- An admin-owned/removed credit does not become bot-owned on another alias edit.
- Initial preparation captures a nickname revision. At installation, compare it with nickname_revision_wanted. A complete but older rendering can become the current representation while remaining refresh_pending and ineligible; it must never become ready with the stale nickname. Preserve the newer wanted revision. Source cleanup may continue from immutable obsolete IDs independently of the pending refresh.
- Retain the current observable-user ID/@username entry behavior. Do not opportunistically redesign unrelated username semantics.

## 7. Ingestion, edits, and generated-update handling

### 7.1 New submission sequence

1. Handler verifies configured queue channel.
2. Pass update kind and ctx.update.update_id along with the normalized snapshot.
3. Capture channel delivery decision at first receipt and persist it with the pending update.
4. Existing pending delay/album collection completes.
5. Observe author metadata using the original semantic origin.
6. Create/update logical item and persist the captured delivery mode.
7. Mark preparation pending; do not publish or perform slow Telegram work inside the update handler.
8. Background preparation worker drains ready work promptly.
9. A late album member invalidates relevant preparation/version safely. Never silently append it to a publication already underway; retain evidence and use the existing review mechanism for truly late ambiguous members.

### 7.2 Route known messages before treating them as submissions

For every post/edit:

1. Consult known current/historical/tombstoned source IDs and known output owners.
2. A repeated post for a known bot-created message must not become a new item.
3. An edit to a current source is still eligible to be an admin edit.
4. An event matching an expected bot post/edit is consumed as that bot event and can supply its actual snapshot.
5. A nonmatching current-source edit is an admin revision; process it normally.
6. An old-generation/tombstoned event cannot resurrect an item or member.
7. An unknown event that might belong to an active outbound queue creation is durably quarantined until output IDs disambiguate it.

Do not permanently ignore all edits to bot-created message IDs. Do not use one consumed ID as proof that all later edits are generated.

### 7.3 Quarantine rules

Generalize the existing renewal-candidate mechanism to preparation, refresh output creation, and renewal, without violating pending_queue_updates.state's SQL CHECK. Under the additive schema, the existing quarantine value can remain a compatibility storage value; expose a generic queue-mutation-candidate concept in TypeScript/UI.

- Known returned output IDs are authoritative association evidence.
- Timing/content similarity can identify a candidate to quarantine, but cannot prove which item owns it.
- Preserve quarantined snapshots needed to reconstruct generated output; do not discard them merely because they are generated.
- After all output IDs are confirmed, release unrelated real admin submissions.
- If a send is uncertain, retain relevant unknown candidates for explicit resolution. Do not guess that identical text belongs to a bot operation.
- Do not purge unresolved generated-output evidence after seven days.

### 7.4 Admin edit and credit ownership

Use the descriptor, not a search for arbitrary "by " text:

- Body-only edit with the exact untouched generated suffix still at the end: preserve bot ownership, recalculate its UTF-16 start.
- Generated text removed, rewritten, moved, or its formatting deliberately changed: set ownership to admin.
- Separate credit member edited or confirmed deleted: set ownership to admin.
- Byline-bearing album member deleted: set ownership to admin; never move its byline/caption.
- Unrelated native media replacement preserves its new media and increments content version.
- A corrective edit to a failed raw source revalidates and prepares; it does not automatically publish. A corrective edit to an already prepared post with a failed/overflowing refresh also revalidates the latest body and pending nickname. Resume the refresh if its credit is still bot-owned, or preserve the admin override and clear obsolete refresh work. Return to ready once valid; do not leave the old issue stuck until a Retry click.
- An edit after destination transfer begins does not rewrite the captured destination contract.

Record expected bot-edit content before calling editText/editCaption, so its resulting update does not disable ownership. Handle same-second edits using update order/content evidence instead of dropping every event with equal edit_date.

A database CAS cannot prevent an admin editing Telegram while a request is in flight. Flush/process known pending edits before mutation, retain differing edits received during the operation, reject stale adoption, and reconcile against the latest acknowledged admin revision. Do not claim that a local mutex provides a Telegram-side conditional edit.

## 8. Preparation state machine and service algorithm

Use these preparation phases:

| Phase | Durable meaning |
| --- | --- |
| claimed | Contract captured; no outbound mutation started |
| transfer_pending | A copy/forward request may have started |
| outputs_recorded | Known output IDs and source associations recorded |
| attribution_pending | Prepared text/caption edit or separate credit may have started |
| result_complete | Every required prepared member and final ownership snapshot is durably complete |
| generation_installed | New representation is current |
| source_cleanup_pending | Only captured old-source cleanup remains |
| uncertain | A mutation/result or association needs resolution |
| completed / failed | Terminal operation states |

### 8.1 Initial preparation algorithm

~~~text
claim item and snapshot contract
validate source/content plan and text/caption/entities before sending
persist claimed contract
for each ordered transfer step:
    persist transfer_pending before invoking Telegram
    transfer source(s) into the queue channel
    record every returned valid output immediately
    if a source is definitely missing:
        reconcile that exact member; do not restore it
    if bulk result is shorter/ambiguous:
        preserve originals and outputs; mark uncertain/review; stop
    apply only this step's required generated attribution
    record final snapshot and expected post/edit events
verify full logical prepared result and ownership
persist result_complete
install next source generation under item/version/owner guard
mark representation prepared, retaining original origin and frozen channel mode
if bot-owned nickname revision is stale: mark refresh_pending, not ready
otherwise: mark ready after all normal readiness conditions hold
attempt deletion of captured old source IDs
record cleanup remnants independently
~~~

Preflight behavior:

- Unknown/service/paid/giveaway and other existing unsupported types retain existing rejection behavior.
- User/hidden text uses appendInlineByline and TEXT_LIMIT.
- Caption-capable media uses the existing caption policy and CAPTION_LIMIT.
- For a normal initial album, preserve the designated caption-bearing member; existing multiple-caption attribution constraints remain applicable to preparation.
- For content that cannot carry a caption, create a separate plain-text credit as a member of the same logical post.
- Do not turn that content-plus-credit bundle into a fake Telegram album.
- User nickname length validation stays 1–64 Unicode code points; Telegram text/caption length and entity offsets remain UTF-16-aware as in existing helpers.
- Preserve explicit entities; do not introduce parse_mode.
- Mark overflow needs_edit, retain raw source, notify once, and prepare automatically after a corrective edit.
- A post already in final copy/no-credit form may be adopted without an unnecessary destructive copy only if its representation and policy are fully recorded. Do not infer that a user forward is already prepared.

### 8.2 Nickname refresh algorithm

1. Alias mutation marks matching bot-owned posts refresh_pending and stores wanted revision.
2. Worker claims refresh only if publication/renewal/another preparation does not own the item.
3. Drain known pending admin edits before choosing the current descriptor.
4. If ownership is now admin/none, preserve it and clear unnecessary refresh work.
5. Build new text from the latest current body plus only the owned generated suffix, or update the owned separate credit.
6. Preserve entities, media, caption position, and known link-preview options. Do not rebuild from original source snapshots.
7. Validate limits before mutation. Overflow is an issue, not a truncated nickname/body.
8. Persist expected edit and phase before API call.
9. Apply idempotent targeted edit. Treat "message is not modified" as success only for the exact intended edit, not as a source-existence probe.
10. A definite missing target removes that member and releases attribution ownership as appropriate; do not recreate it elsewhere.
11. Persist successful current snapshot, attribution descriptor, applied revision, and version under guard.
12. If a newer nickname revision arrived meanwhile, leave another refresh pending; do not mark stale output ready.
13. If an acknowledged admin edit conflicts, preserve the edit and reconcile; do not install a stale body.

A refresh uses an in-place edit when possible. It does not create a new generation containing reused Telegram message IDs.

### 8.3 Worker behavior

- Register with createTaskSupervisor and createOperationTracker.
- Use injected Clock, abort signals, bounded batches, and existing shared Telegram cooldown.
- Drain pending work promptly, with approximately one-second idle wakeup like the current pending-update finalizer; do not wait for the next publishing slot.
- A definite per-item failure schedules a bounded delayed retry or waits for a corrective edit and yields to other items.
- An uncertain mutation is not automatically retried.
- Continue while scheduled publishing is paused.
- Heartbeat dedicated preparation leases alongside existing operations.
- Shutdown drains tracked active operations within existing shutdown limits; preserve unfinished phase evidence.
- Keep current sources alive through ordinary renewal if a preparation issue persists toward the deletion deadline.

## 9. Shared prepared transfer and deletion reconciliation

### 9.1 Adapter extensions

Add a typed copyMessage adapter for a single source, analogous to forwardMessage. Preserve relevant caption/entity options for preparation. Its success returns a validated MessageId; forwarding may return a Message that can be normalized.

Add copyMessage to the shared Telegram mutation-cooldown method set. Keep existing adapter entry points and strict result validation, but upgrade malformed-result handling to preserve partial evidence rather than throwing away valid IDs.

Add structured transfer evidence to normalized adapter errors/results, equivalent to:

~~~ts
type TransferFailureEvidence = {
  requestMayHaveSucceeded: boolean;
  knownOutputs: readonly {
    messageId: MessageId;
    returnedOrdinal: number;
  }[];
  sourceMappingKnown: boolean;
};
~~~

Scan the whole returned bulk array before throwing for malformed entries. Collect every distinct positive safe-integer returned message ID with its returned order, without assigning unknown source identities. Include this evidence in the thrown normalized error. Services persist all safe known IDs before marking uncertainty. A response containing valid ID A, malformed entry B, and valid ID C must retain A and C. Duplicate IDs, conflicting ownership, invalid shapes, and partial arrays remain uncertain; preserving evidence does not make the response complete. Network timeout has requestMayHaveSucceeded = true even when knownOutputs is empty. Never retry solely because the adapter did not return a normal success array.

Normalize method-specific missing errors, including:

- "message to copy not found"
- "message to forward not found"
- "message to edit not found"
- Existing "message to delete not found" and Telegram's recognized equivalent source-ID errors

Do not classify every HTTP 400, invalid ID, permission error, inaccessible chat, protected content, timeout, empty bulk response, or unsupported message as intentional deletion. Preserve method/context in normalized errors and test both positive and negative cases.

### 9.2 Choosing transfer calls

| Step | API strategy |
| --- | --- |
| One standalone copied member | Single copyMessage for exact per-source failure association |
| One standalone forwarded member | Single forwardMessage |
| Genuine album | copyMessages/forwardMessages for the album, preserving grouping |
| Content plus separate generated credit | Separate ordered steps; treat together as one logical item |
| Recovered bundle | Use explicit known grouping/delivery metadata and native grouping preservation; do not invent an album from unrelated selected IDs |

Never split an album into unrelated single sends merely to discover which source is missing.

### 9.3 Confirmed missing members

- Tombstone only the member definitively identified by the failed normal action.
- If other members remain, retain their order/content and continue when safe.
- If only the separate credit remains after admin deletion, preserve what the admin left; do not invent a new cleanup rule that deletes it.
- If none remain, remove the active logical item and continue to the next eligible candidate when no destination output occurred.
- Deleting an obsolete queue generation does not cancel the current one.
- Missing originals during source cleanup after completed publication still finalize as published.

### 9.4 Shorter albums and uncertain sends

A bulk response returns destination IDs, not a list of omitted source IDs. For a deleted middle/first member, positional zipping is invalid.

On a shorter or otherwise invalid album result:

1. Persist every trustworthy known output ID before further actions.
2. Preserve the original current generation; do not delete originals based solely on the shorter result.
3. Keep actual available snapshots/evidence. Do not fabricate source mappings.
4. Mark review/uncertain with the specific operation and counts/IDs.
5. Notify once, with resolution actions.
6. Do not repeat the transfer automatically.
7. If this was a destination transfer, consume the publishing slot and allow later ready items at later slots.
8. Allow explicit admin adoption only with a validated complete representation and correct ownership mapping; an ID-count match alone is insufficient for a changed bundle.

A transport timeout after a request may have reached Telegram is also uncertain, even when no destination ID was returned. "No known outputs" does not mean "nothing was sent."

## 10. Publication and scheduler refactor

### 10.1 Prepared-only publication

For new publication:

- Build PreparedPublicationContractV2 from current prepared members and frozen delivery steps.
- Do not call aliasForOrigin or isChannelWhitelisted to regenerate the final form.
- Do not invoke appendInlineByline, editInlineByline, or sendText for new attribution.
- Copy prepared user/direct/unlisted-channel messages without a queue forward header.
- Forward prepared repostable-channel messages while retaining original channel attribution.
- Capture all steps and output evidence before beginning source cleanup.
- One logical bundle, including an independent credit, consumes one successful slot.

Keep the old v1 execution/recovery path only for already captured legacy operations. Do not create new v1 publication attempts.

### 10.2 Outcome semantics

Return structured outcome information that distinguishes these cases; exact TypeScript names can follow current style:

| Outcome class | Destination may contain this attempt? | Continue same slot? |
| --- | --- | --- |
| Published / published with cleanup pending | Yes, complete | No |
| All sources definitely missing before output | No | Yes |
| Definite item validation/unsupported failure before output | No | Yes |
| Item already issue/preparing/retrying | No attempt | Skip it |
| Uncertain or partial destination output | Yes or unknown | No |
| Global flood wait / destination unavailable / shared permission rejection | Normally no, but retain uncertainty if request may have sent | No |
| No eligible candidates | No | Stop empty/no-ready |
| Contention/stale manual confirmation | No | Re-evaluate safely or reject the stale action; do not send guessed item |

Do not derive "safe to continue" from a generic failed status alone. Track whether any creation request may have succeeded.

### 10.3 One bounded attempt per candidate per run

~~~text
start a run with a bounded view of current candidate IDs / sequence horizon
visited = empty set
while candidates remain:
    stop if shared cooldown/outage applies
    atomically claim earliest ready unvisited candidate
    if none: finish without publication
    record candidate in visited before executing it
    attempt captured prepared delivery
    if complete output or possible output: consume slot and finish
    if global failure: finish
    if definitely no output and item now issue/missing: notify/reconcile and continue
~~~

Do not loop forever on the same failing item, claim-conflict, or newly ingested stream. New arrivals can wait for the next normal run. Preserve existing missed-slot/downtime policy rather than replaying every missed schedule occurrence.

### 10.4 Manual publish-next

- Show the first currently ready item, not strict getHead.
- Confirmation text must explain that the action publishes the next available post and may skip a definite no-output failure.
- Bind the starting candidate, content version, and source generation.
- If the starting preview became stale before confirmation, ask the admin to reopen the queue instead of silently publishing another post.
- Once a valid publish-next run is authorized, its same-run fallback follows the scheduled selection rule.
- Existing single-use, admin-bound callback protections remain.

### 10.5 Cleanup and run persistence

- Publication cleanup belongs to its independent worker and is not a successful "new post" for today's slot.
- Persist which operation consumed a scheduled occurrence before it can be retried after restart.
- If completion is uncertain, mark the run failed/uncertain using existing allowed status/error fields; never turn it back into pending to fill with another post.
- Review recoverInterruptedRuns together with the new outcome semantics.
- Keep source cleanup errors separate from destination completeness.

## 11. Renewal and physical-source safety

Prepared renewal must use the prepared delivery mode, member roles, and real grouping. It must not choose forward merely because original origin.kind is user or hidden_user.

- Prepared copy-mode sources renew by copying; prepared forward-mode channel sources renew by forwarding.
- Generated credit members renew as plain copied messages and keep their role/ownership.
- A failed initial preparation still has a raw representation. Renew its raw surviving input without stripping provenance or applying new rendering rules, then return it to pending preparation/its issue state.
- Preserve current admin edits and membership tombstones, not the initial input snapshot.
- Remap complete source/output associations only after every step's full result is known.
- Retain current 36-hour threshold, 48-hour deletion constraints, fair due-item draining, durable flood waits, and cleanup/orphan reporting.
- Extend renewal contracts/validators with a versioned prepared-member plan; keep old contracts readable.
- The existing uncertain-renewal adoption clones old snapshots by ordinal. Replace that behavior for new contracts with explicit validated members/grouping and attribution ownership.
- Guard every installation by current item ID, source generation, content version, and operation ownership.
- If the guard fails after outputs were created, preserve/track outputs for cleanup or review and do not delete the current source.

## 12. Restart and crash-recovery matrix

SQL reconciliation happens before live Telegram cleanup, matching current startup structure. Dedicated preparation operations must never fall through into existing publication recovery.

| Persisted state/evidence | Required restart action |
| --- | --- |
| Preparation claimed, no mutation started | Release owner and requeue preparation |
| Preparation transfer_pending without complete result | Mark uncertain; preserve sources and known outputs; no resend |
| Outputs known but required attribution completion unknown | Hold for resolution; do not assume the edit/credit succeeded |
| result_complete with valid full snapshots and unchanged owner/version/generation | Install without sending again |
| result_complete with stale guard | Do not install or delete current source; retain outputs for cleanup/review |
| generation_installed/source_cleanup_pending | Resume captured obsolete-source cleanup only |
| Refresh claimed, no edit began | Requeue refresh |
| Refresh edit may have succeeded but completion is not durable | Preserve expected edit and pending updates; reconcile exact evidence or mark uncertain; never rebuild stale content blindly |
| Publication claimed, no transfer started | Existing safe release logic, then prepared readiness/revision recheck |
| Publication output complete/source cleanup pending | Cleanup only; never resend |
| Publication transfer may have started | uncertain_publish and consumed slot |
| Renewal replacement fully recorded and guarded | Install using versioned member plan |
| Renewal already installed | Old-source cleanup only |
| Terminal/explicit uncertainty | Do not automatically reset to ready |

Integration checklist:

- Extend application startup and the periodic operation-recovery loop for the dedicated repository.
- Heartbeat dedicated operations with boot ID and lease expiration.
- Register active work with operation tracker for shutdown.
- Update health counters to include preparation/refresh operations and uncertainties.
- Retention must preserve unresolved source/output/event ownership evidence.
- Redact completed preparation contracts/snapshots consistently with the existing 30-day completed-content policy; generated-event/pending cleanup after seven days applies only when no active operation still needs it.
- Preserve current 90-day audit/resolved-alert retention.
- Run PRAGMA foreign_key_check after migration and in migration tests.
- Never reinterpret an old frozen publication/renewal contract using new current nicknames or policy.

## 13. Admin UI, alerts, and recovery

### 13.1 /authors

Keep existing user ID/@observed_username input. Add hidden-author selection:

1. List known users and hidden-name entries with distinguishable labels.
2. Page the list; do not retain the current hard 20-entry accessibility limit.
3. Hidden entry button contains an opaque token referencing numeric hidden-author ID.
4. Selected entry view shows sanitized display name, current nickname, and a concise "shared by hidden senders with this exact name" explanation.
5. Set/replace asks for only the nickname.
6. Remove clears its alias and schedules fallback-name refresh for untouched generated credits.
7. Preserve exact name in storage even when display sanitization changes it.
8. Validation error leaves prompt usable; /cancel exits; expiration/single-use/admin binding remain.
9. Existing queue origins are backfilled so an admin can manage names observed before rollout.

### 13.2 Queue view

Show logical order including issue items, but distinguish:

- Ready to publish.
- Collecting/preparing.
- Refresh pending/in progress.
- Needs edit / blocked / needs review.
- Uncertain preparation / publication / renewal.
- Cleanup pending where relevant.

"Next to publish" and dashboard preview refer to the earliest ready item. Keep stable item numbers and links to current active source members. Recompute the link after deletion of the first member.

Expose actions appropriate to the issue. Add explicit preparation-resolution actions parallel to existing publication/renewal evidence views: inspect known outputs, adopt validated complete result, confirm no result and retry, or clean tracked outputs. Ordinary admin edits do not require a confirmation flow.

Remove text claiming an issue or uncertain item remains a globally blocking FIFO head.

### 13.3 Notifications

Do not just call the existing repeating alert.raise unchanged.

For item issue conditions:

- Compute a stable fingerprint from item ID, issue category, normalized substantive reason, and material content/attribution details needed to distinguish the actual problem.
- Do not include operation IDs, retry counts, timestamps, ordinary version increments, or incidental link-generation text in the fingerprint. A newly created retry operation is not a material issue change. Carry operation/version IDs in payload/evidence instead.
- Persist enough alert data to know whether this exact active condition was delivered.
- Repeated evaluation of the same delivered condition sends nothing, even after the old severity repeat window.
- A changed reason produces one new notification.
- Resolution closes the condition; a later recurrence sends again.
- Failed sends remain pending and retry with backoff through the shared cooldown.
- Include item number, current queue link if any, explanation, and single-use resolution buttons.
- If no source link exists, include known operation/output IDs rather than fabricating a link.
- Notification delivery errors cannot roll back queue progress or stop another candidate.
- Confirmed intentional deletions are not issue alerts. Remove/suppress the existing generic deleted_external issue notification for this intentional-deletion path.
- Keep existing critical operational alarm behavior only where it does not violate the agreed unchanged-item issue deduplication.

Use the additive admin_alerts fields from section 4.6 for fingerprints, payload/action descriptors, and delivery retry timing. Implement an on-change item-issue path alongside existing periodic operational alarms; do not apply old repeatWindow to on-change rows. Include a test where repeated automatic retries create different operation IDs but produce only one unchanged-issue notification, plus restart and delivery-failure tests.

### 13.4 Recovery

- Existing known-source references should restore/reuse available item and sender metadata instead of creating a duplicate.
- Unknown sources default to as-shown adoption, with an explicit optional preparation action.
- As-shown recovery adds no byline and does not strip forwarding attribution.
- Support an explicitly selected ordered bundle containing content plus a separate credit, not just a single Telegram album.
- Preserve real grouping from available metadata/native bulk operations; do not declare all selected IDs one album.
- If forward-vs-copy presentation differs among members, store it per transfer step rather than applying a single guessed mode to the whole recovered bundle.
- Do not infer original user identity from a plain "by ..." suffix.
- Without original metadata or explicit author assignment, ownership is admin/none and automatic nickname refresh is disabled.
- Reuse author selection if explicit assignment is offered; never conflate a displayed string with a known account.
- Existing temporary previews used by explicit recovery still require durable cleanup; they are not a new background deletion-probing mechanism.
- Do not recover an obsolete or tombstoned known message as a fresh item because findBySource ignores historical generations.

## 14. Ordered implementation batches and checkpoints

Work sequentially. Do not mark a batch complete merely because the TypeScript compiles. Each checkpoint must demonstrate the behavior indicated.

### Batch A — Baseline and shared types

Files: package.json for reading only; src/types.ts; src/domain/queue-item.ts; src/domain/validation.ts; new prepared-post/attribution domain modules.

Tasks:

- Run baseline typecheck/tests and record pre-existing failures without changing unrelated code.
- Add versioned snapshots/contracts and pure readiness/ownership helpers.
- Preserve old parser behavior for frozen legacy contracts.
- Add pure tests for exact-name distinctions, ownership changes, grouping, and readiness.

Checkpoint:

~~~sh
bun run typecheck
bun test test/domain.test.ts test/domain-matrix.test.ts test/attribution.test.ts
~~~

Do not weaken old hidden-alias assertions without replacing them with new expected behavior and namespace-separation tests.

### Batch B — Migration and repositories

Files: src/db/migrations.ts; src/db/repositories.ts; new preparation/generated-event repositories; tests.

Tasks:

- Implement additive schema changes and backfills.
- Separate active/current/historical membership access.
- Implement guarded ownership/claims/installation and hidden-author CRUD.
- Add nickname revision invalidation and cross-table output ownership checks.
- Implement prep recovery/heartbeat with no Telegram I/O.

Checkpoint tests:

- Fresh install and v3-to-new migration.
- v2-to-new upgrade containing legacy operations.
- Existing queued IDs/order/ages unchanged.
- Old aliases, operation outputs, recovery rows and uncertainties preserved.
- Repeated migration/startup is idempotent.
- Tombstoning does not violate global message uniqueness.
- Guard conflicts reject adoption without losing outputs.
- A self-confirmed member deletion advances effective execution version and permits guarded survivor completion; an unrelated admin edit still rejects it.
- PRAGMA foreign_key_check returns no rows.
- No nested transaction failures.

### Batch C — Adapter and ingestion

Files: src/telegram.ts; src/errors.ts; src/telegram-cooldown.ts; handlers; ingestion/pending repositories.

Tasks:

- Add single copy adapter and normalized method-specific errors.
- Capture policy at receipt, not delayed preparation.
- Preserve known source identity across historical/tombstoned rows.
- Match expected bot edits without suppressing later admin edits.
- Quarantine unassociated generated candidates durably.

Checkpoint tests:

- Source-specific missing vs permission/unsupported/network failures.
- Malformed bulk response retains all trustworthy output IDs before uncertainty, including valid entries after the malformed entry.
- New copy method participates in durable flood waits.
- Whitelist changed during pending/album delay does not alter captured item mode.
- Bot post/edit arrives before API response.
- Admin edits same bot-created message after expected echo.
- Two edits in the same second.
- Late old-generation updates do not create new items.
- Real admin submission is released after unrelated confirmed output IDs are known.

### Batch D — Preparation and refresh

Files: new preparation service/worker; domain byline/origin policy; application wiring.

Tasks:

- Move initial rendering out of publication into durable preparation.
- Prepare singles, albums, and separate-credit bundles.
- Implement targeted nickname refresh and admin ownership.
- Complete failure/uncertainty/install/cleanup state machine.
- Revalidate corrective edits automatically.
- Drain independently of schedule pause.

Checkpoint tests:

- User/hidden-user text, captions, and captionless content prepared correctly.
- Whitelisted forwards retain original channel; unlisted copies do not.
- Hidden nickname affects exact matching existing/future posts.
- No original deletion before durable complete replacement.
- Lost transfer response, edit failure, partial album, storage failure and cleanup failure.
- Body/media/formatting edits survive refresh.
- Removed/rewritten credit stays removed/rewritten.
- New alias arriving during refresh creates another pending revision.
- New alias arriving during initial raw preparation cannot leave stale output ready.
- Alias changes during renewal leave the renewed item refresh_pending on owner release; a stale bot-owned credit fails readiness even before that release bookkeeping runs.
- Corrective edits repair both failed raw preparation and overflowing prepared refresh without Retry.
- Guard mismatch does not overwrite admin edits.
- Worker continues after one item fails and respects shared cooldown.

### Batch E — Prepared publication, renewal, scheduling

Files: publisher.ts; prepared-transfer.ts; renewal.ts; renewal-worker.ts; scheduler.ts; queue repository; runtime recovery.

Tasks:

- Execute version-2 prepared contracts without attribution regeneration.
- Use frozen mode and current member roles/groups for renewal.
- Support raw-source preservation when initial preparation is still failing.
- Replace strict-head claiming with earliest-ready claiming.
- Implement bounded same-slot fallback and global stop behavior.
- Preserve consumed slots across restart.

Checkpoint tests:

- Prepared publication performs no byline edit/send.
- One content-plus-credit bundle uses one successful slot.
- No queue-channel header appears on prepared user-copy publication/renewal.
- Issue A, ready B: B publishes.
- A fails definitively before output, B ready: B publishes in that slot.
- A may have sent: slot stops; B can publish next slot.
- No ready items: no send, no hot loop.
- Source missing entirely: remove and try next candidate before output.
- Confirmed partial deletion: surviving members retained without restoration.
- Ambiguous shorter album: review, preserve evidence, no automatic resend.
- Global flood wait/outage/access failure: stop run, do not fault every item.
- Repaired older item resumes before later remaining ready items.
- Cleanup from yesterday does not consume today's slot as a new publication.

### Batch F — Admin UX, notifications, recovery

Files: admin handler; alerts repository/service; recovery service/repository; health/capacity.

Tasks:

- Hidden-name selection and pagination.
- Next-ready dashboard/manual action and correct stale confirmation handling.
- Per-item issue notification persistence/deduplication/actions.
- Dedicated preparation evidence/resolution.
- As-shown recovery and explicit preparation option.
- Active preparation/refresh and uncertainty included in health.

Checkpoint tests:

- More than 20 hidden/user entries remain manageable.
- Names containing spaces and sanitized/unsafe display variants retain exact keys.
- Invalid/expired/non-admin prompts and callbacks are rejected.
- An unchanged issue across repeated scans/restart sends once.
- Failed notification eventually sends without blocking publication.
- New reason and recurrence produce new messages.
- Non-head issues notify.
- Intentional deletion does not produce an incomplete-post issue.
- Untracked recovery does not append a second byline.
- Mixed as-shown recovery persists each member's copy/forward mode across restart and renewal.
- Known old sources do not resurrect deleted items.
- Mixed content/credit recovery keeps one logical item and real grouping.

### Batch G — Rollout, cleanup, docs, full gate

Files: application startup; retention; health/capacity; README.md; IMPLEMENTATION_PLAN.md; docs/queue-renewal.md; docs/telegram-compatibility.md; recovery/deployment docs.

Tasks:

- Set a one-time rollout policy baseline for legacy waiting items.
- Queue background preparation for safe waiting rows; keep collecting albums collecting.
- Preserve already-captured publication/renewal/uncertain operations until resolved.
- Prevent new prepared publisher from using raw legacy rows.
- Extend evidence retention/redaction and startup/shutdown coverage.
- Update old documentation that says hidden nicknames are impossible, policy is always evaluated at publication, or an issue head blocks everything.
- Keep this file as the authoritative implementation checklist and mark completed batches only with actual verification.

Final checkpoint:

~~~sh
bun run check:all
git diff --check
~~~

If a check fails because the feature intentionally changes behavior, update that test to the new requirement and preserve its underlying safety assertion. Do not delete assertions to reach green.

## 15. Acceptance scenario matrix

Use real temporary SQLite plus a stateful fake Telegram gateway. The fake should retain message bodies/media/group membership and simulate source deletion, rather than always returning a fabricated same-length array.

| ID | Scenario | Required observation |
| --- | --- | --- |
| P01 | Forward known user text with configured nickname | Queue shows copied text plus one generated credit |
| P02 | Hidden sender observed before deployment | Selectable in /authors after backfill |
| P03 | Same hidden name, two people | Shared nickname as agreed |
| P04 | Hidden name differs by case/space/Unicode | No cross-match |
| P05 | User ID alias with same display name | Independent from hidden-name alias |
| P06 | Listed channel forward | Original channel attribution preserved in queue and destination |
| P07 | Whitelist changes after initial receipt | Existing item keeps captured mode |
| P08 | Nickname changes while waiting | Visible untouched credit refreshes before eligibility |
| P09 | Admin rewrites/deletes credit | Future nickname changes leave that override alone |
| P10 | Admin edits body/entities/media | Edit survives refresh, renewal and publication |
| P11 | Caption overflow during preparation/refresh | needs_edit, original/current post retained, no truncation |
| P12 | Admin corrects failed raw text/caption | Automatic revalidation/preparation, no unscheduled post |
| P13 | Sticker/video note credit | Separate member in one logical item, not an album |
| P14 | Complete album | Grouping, member order and single generated credit preserved |
| P15 | Delete byline-bearing member with definite evidence | No moved/recreated credit |
| P16 | Delete whole singleton | Active item removed when transfer discovers absence |
| P17 | Delete obsolete source | Current item unaffected |
| P18 | Album call returns fewer IDs without reasons | Review; no positional fabrication or repeat send |
| P19 | Timeout after send | Uncertain output, slot consumed, no automatic retry |
| P20 | Source cleanup fails after completed publication | Published, cleanup pending, never resend |
| P21 | Issue oldest item and ready next item | Ready next publishes |
| P22 | Several definite no-output failures | One bounded pass, then at most one successful post |
| P23 | Shared 429 | Full persisted wait respected across all mutations and restart |
| P24 | Destination access lost | One shared failure, remaining items not individually faulted |
| P25 | Repair an older skipped item | Original position among remaining items restored |
| P26 | Bot queue updates precede send response | No duplicate ingestion |
| P27 | Bot refresh edit followed by admin edit | Expected echo suppressed; admin edit preserved |
| P28 | Crash at every preparation phase | Section 12 recovery behavior, no unsafe resend |
| P29 | Crash after consumed schedule attempt | No replacement publication into same slot |
| P30 | Recover unknown prepared messages | As-shown, no duplicate attribution or inferred author |
| P31 | More than 20 authors/issues | Reachable management actions and notifications |
| P32 | Unchanged issue across old repeat windows | No extra item-issue notification |
| P33 | Notification send fails | Independent durable retry, no publication rollback |
| P34 | Scheduling paused | Preparation and renewal continue |
| P35 | Raw issue waits toward deletion deadline | Raw-source renewal preserves input and provenance |
| P36 | Alias changes during refresh or publication | No stale ready revision or mutated captured contract |
| P37 | Source member deleted after some bundle output | Preserve output evidence; no duplicate whole-bundle resend |
| P38 | Retention while uncertainty older than seven days | Required ownership/source/output evidence survives |
| P39 | Same-second edits | Later acknowledged edit not lost due to equal edit_date |
| P40 | Current first member deleted | Queue link targets first surviving current member |

Keep test fixtures explicit about raw versus prepared state. Do not make snapshotFixture automatically prepared by default; that would hide missing preparation/readiness guards in old tests. Add a separate prepared fixture/helper that writes legitimate prepared metadata.

## 16. Live compatibility checks and honest completion report

Automated tests cannot prove Telegram's real server behavior. If a disposable bot/queue/destination is available, verify:

1. User/hidden-user copies lose forwarding header and show exactly one credit.
2. Re-forwarding a listed-channel source retains the original channel.
3. Albums retain grouping across preparation, renewal and destination delivery.
4. Single copy/forward missing-source errors match the adapter classification.
5. A shortened album response follows the documented ambiguity path.
6. Admin edits to bot-created queue messages are received and preserved.
7. Captionless content plus credit is managed/published/deleted as one logical item.
8. Source cleanup and old-generation links behave as recorded.
9. A real flood wait is not shortened by local retry logic.
10. Restart with recorded output does cleanup/resolution instead of resending.

If credentials/channels are unavailable, do not invent success and do not add MTProto as a workaround. Finish the local implementation and automated gates, then identify precisely which live checks remain unverified.

The final implementation report should state:

- Which behavior and files changed.
- Which automated checks passed.
- Which live Telegram checks were actually performed.
- Any remaining limitation, especially ambiguous album omissions and deletion detection lag.
- Whether rollout of existing waiting items is ready.
- No claim of production deployment unless deployment was separately requested and actually performed.

## 17. Reference facts and decision authority

This document contains all product requirements needed for implementation. The accompanying design/glossary/ADRs provide rationale, not a second source of contradictory runtime behavior:

- GLOSSARY.md.
- docs/queue-preparation.md.
- docs/hidden-sender-nicknames.md.
- docs/adr/0003-match-hidden-sender-nicknames-by-exact-forwarded-name.md.
- docs/adr/0004-prepare-queue-output-before-publication.md.
- docs/adr/0005-publish-earliest-ready-item-past-issues.md.

Older README/IMPLEMENTATION_PLAN statements about hidden aliases, strict FIFO blocking, and publication-time policy describe the baseline and must be updated after implementation.

Primary Telegram references:

- [Update schema](https://core.telegram.org/bots/api#update): no ordinary channel-deletion update in the Bot API.
- [copyMessage](https://core.telegram.org/bots/api#copymessage): per-source copy operation.
- [copyMessages](https://core.telegram.org/bots/api#copymessages): native album preservation and skipped-source behavior.
- [forwardMessages](https://core.telegram.org/bots/api#forwardmessages): bulk forwarding and skipped-source behavior.
- [MessageOriginHiddenUser](https://core.telegram.org/bots/api#messageoriginhiddenuser): sender name without an account identifier.
- [deleteMessage](https://core.telegram.org/bots/api#deletemessage): source cleanup/deletion restrictions.
