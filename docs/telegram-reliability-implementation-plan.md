# Implementation plan: Telegram reliability and permanent admin control

Prepared on 2026-10-17 against commit `9866e598b9076e816b088bd26014b0c2ec16ac97`, whose latest database migration is version 5.

Implementation status: completed locally through code checkpoint `fc9d09e`; the current schema is version 11. `bun run check:all` passes with 371 tests, 1,661 assertions, 91.39% application line coverage, and 93.39% function coverage. Production data, service state, and Telegram messages were not changed.

Audience: an implementation team that needs explicit files, interfaces, sequencing, failure rules, and acceptance checks. This plan records the agreed implementation and verification status. It does not authorize production deployment.

## 0. Read this before changing code

### 0.1 Sources of truth

Read these files in this order:

1. Applicable `AGENTS.md` instructions, if any have been added since this plan was written.
2. `GLOSSARY.md`.
3. `docs/telegram-reliability.md`.
4. `docs/adr/0006-freeze-the-whole-post-after-admin-edits.md`.
5. `docs/adr/0007-bound-scheduled-retries-to-five-minutes.md`.
6. `docs/investigations/2026-10-17-telegram-flood-waits.md`.
7. This entire plan.

For this task, these documents supersede older preparation-plan passages that allow automatic nickname refresh after a body-only admin edit, immediately resolve a flood wait when its deadline expires, or mark every rate-limited scheduled attempt terminal.

Keep these already existing properties: stable queue item numbers; logical order; complete album handling; preservation of original semantic origin; captured forwarding policy; source deletion only after complete replacement/destination evidence; explicit review for ambiguous output; physical source renewal and cleanup.

Do not rewrite the application from scratch. Continue using Bun, TypeScript, grammY, SQLite, the existing singleton lease, and supervised workers. Do not introduce another Telegram connection, MTProto, a second database, Redis, an external queue, or a web server.

### 0.2 What was proven

The reported failures were Telegram flood-control waits, followed by the application's local shared cooldown. The investigated deployment contained no recorded network timeout or transient network/server operation errors explaining this incident. Do not try to solve the incident by increasing HTTP timeouts.

The original loop is:

```text
author already has nickname revision 1
  -> a NEW queue item starts with nickname_revision_wanted = 0
  -> initial preparation applies the author's current revision 1
  -> install compares applied 1 with wanted 0
  -> item remains refresh_pending
  -> every refresh applies 1, compares it with 0, and repeats
  -> repeated identical caption-edit requests hit Telegram flood control
  -> shared cooldown rejects publications, warning delivery, and command replies
```

Completed refresh operations are not necessarily successful content changes: `message is not modified` is swallowed as successful completion. That still consumes API requests and leaves stale generated-edit expectations.

At the first snapshot, item #86 had 22,444 refresh attempts. Do not hardcode item #86, its author, its source IDs, or revision 1 into a repair. Reproduce the pattern using synthetic identities and fix the invariant for every item.

### 0.3 Agreed product behavior: do not reopen these decisions

| Area | Required behavior |
| --- | --- |
| Admin edits | Any admin edit permanently freezes the WHOLE logical post: content, all album members, formatting, and separate credit. |
| Raw edited submissions | Adopt the admin's version as shown. Do not add a byline afterward. |
| Frozen posts | Still eligible for normal publication and source-preserving renewal when otherwise valid. Freezing is not a pause or an issue. |
| Future nickname changes | Refresh only posts that have never been frozen. Never unfreeze a post automatically. |
| In-flight edit collision | Stop automatic work for the affected post, preserve evidence and the admin version, and require review. Never issue another rewrite to repair the collision. |
| Short flood waits | Stay quiet unless admin action is needed. |
| Long disruptions | Become warning-eligible after five minutes, or immediately when admin action is required. |
| Incident grouping | Repeated waits form one incident until five uninterrupted minutes after the latest wait ends, with a successful relevant Telegram request after that wait. |
| Recovery messages | One recovery only for an opening warning actually delivered. Deadline expiry alone does not prove recovery. |
| Scheduled retry | Retry only definite rejection before ANY output; stop initiating retries at five minutes after the original scheduled time. |
| Restart | Preserve the original retry deadline; never start a new five-minute window. |
| Pause/manual publication | Pausing or successful manual publication cancels pending scheduled retries. Resume does not resurrect them. |
| Ambiguous publication | Never automatically resend. It consumes its occurrence and requires review. |
| Admin replies | Persist responses independently of command execution; deliver when Telegram permits, ahead of background work. |
| Obsolete views | New dashboard/health/queue requests replace older pending replaceable views. Distinct action confirmations remain separate. |
| Delayed interactions | Generate callback tokens at delivery time; activate ForceReply prompts only after actual successful delivery. |

### 0.4 Implementation defaults supplied by this plan

These are concrete engineering choices for implementing the agreed behavior. They are not claims that the user explicitly discussed every storage column or constant.

- Use additive migrations 6–11 as described below. Never edit a migration already applied anywhere.
- Keep deferred schedule runs in existing status `pending`; use extra columns for retry and cancellation. Do not rebuild the schedule status CHECK merely to add `retry_pending`.
- Use a dedicated private-admin response outbox. Do not store channel publications in it.
- Introduce one shared outbound admission layer for proactive pacing, final version/protection checks, and central real-429 observation.
- Initially space mutations to the same chat by at least 3,000 ms per affected message and all outbound mutations globally by at least 1,000 ms. These are conservative application pacing settings, not a claim about Telegram's exact caption-edit quota.
- When a newer scheduled occurrence becomes due, cancel an older still-unsent retry rather than building a catch-up backlog. The older occurrence's hard deadline is still its original time plus five minutes; this rule can end it earlier, never extend it.
- A retry pass reselects the earliest currently eligible item, preserving the existing publish-next behavior. Do not invent a new promise that an occurrence permanently belongs to one candidate. All previous attempt evidence must still be checked before another send.
- Ambiguous private message delivery is recorded as `uncertain` rather than blindly resent. The accepted requirement is to retry safe response delivery; it does not create a Telegram idempotency key.
- Conservative rollout default: freeze existing active PREPARED posts whose editing history cannot be proven, using reason `legacy_unverified`. This protects the currently visible post, but means later nickname changes will not refresh those legacy posts. Do not label them as proven human-edited. New untouched posts remain refreshable. This rollout choice must be called out in the implementation summary.

The historical audit cannot reliably distinguish every previous admin edit from every bot edit. Do not claim that absent `edit_date` proves a post was untouched. Do not reconstruct that missing history from the text `by ...`.

## 1. Non-negotiable invariants

Assign these labels to regression tests and review notes so failures are easy to discuss.

| ID | Invariant |
| --- | --- |
| I1 | A completed unchanged nickname rendition converges to ready; it cannot schedule itself forever. |
| I2 | A nickname change arriving during an awaited operation is not lost. A newer wanted revision stays newer. |
| I3 | A frozen queue item never initiates an automatic content/credit rewrite, even after renewal, restart, retry, or recovery. |
| I4 | Accepted admin edits update stored current content and permanent protection atomically. |
| I5 | An obsolete or removed source update cannot freeze or overwrite the current source. |
| I6 | A pending generated-edit fingerprint is not perpetual permission to ignore matching admin edits. |
| I7 | Any destination output or unresolved possibly-sent request prevents another automatic send for the same occurrence. |
| I8 | A scheduled occurrence starts at most one successful publication and never initiates a fresh no-output publication attempt at/after its retry deadline. |
| I9 | A real Telegram 429 extends the shared wait; local pacing/priority/cooldown deferrals do not create or renew a Telegram incident. |
| I10 | Pending responses do not hold the long-poll middleware open while waiting for Telegram. |
| I11 | Retrying a response never repeats its admin action. |
| I12 | An opening warning is delivered at most once per incident; recovery is delivered at most once and only after that warning. |
| I13 | SQLite is not held in a transaction across an `await`, a network call, or a pacing sleep. |
| I14 | Source cleanup failure after output completion cannot trigger another publication. |
| I15 | Worker cancellation/lease loss prevents NEW requests while preserving durable outcomes of requests already started. |

## 2. Current code map and traps

| File / symbol | Current role | Required change |
| --- | --- | --- |
| `src/db/migrations.ts` | Migrations through 5 | Append protection, retry, incident/pacing, and outbox/receipt migrations. |
| `src/db/database.ts` / `transaction` | Unconditional `BEGIN IMMEDIATE` | Add tested synchronous nested SAVEPOINT support for atomic admin actions + receipts + outbox. |
| `src/domain/queue-item.ts` / `QueueItemRecord` | Public queue record | Add permanent whole-post freeze fields. |
| `src/domain/prepared-post.ts` / `isPreparedPostReady` | Domain/test readiness predicate | Mirror the frozen-post and nickname-key semantics of production SQL. |
| `src/db/repositories.ts` / `QueueRow`, `rowToItem` | Storage mapping | Map new fields; preserve optional-field semantics. |
| `observeQueueSnapshot` | New item insertion | Initialize wanted revision from the observed author in the enqueue transaction. |
| `peekNextReady`, `claimReadyPublication` | Prepared candidate selection | Frozen valid items bypass nickname freshness; bind scheduled attempts before I/O. |
| `updateSnapshot` | Existing source edit | Atomically accept admin revision and freeze whole item. |
| `updateIdentifiableAuthorItems`, `updateHiddenAuthorItems` | Nickname invalidation | Exclude frozen posts from transformation scheduling. |
| `src/services/ingestion.ts` | Queue updates | Preserve unmatched-edit provenance, provisional-output edits, and correct bot-echo handling. |
| `src/db/pending-update-repository.ts` | One row per chat/message | Preserve unmatched human-edit provenance even when update kind remains `post`. |
| `src/db/generated-event-repository.ts` | Expected bot posts/edits | Attempt-specific edit lifecycle; reject stale matching. |
| `src/db/preparation-repository.ts` | Claims, output evidence, install | Reconcile revisions; protection guards; return actual stored state. |
| `src/services/preparation.ts` | Render/copy/edit credits | Frozen adoption, no-op comparison, exact expectation retirement, final dispatch guard. |
| `src/services/preparation-worker.ts` | Drain preparation work | Bounded useful work and paced I/O; no CPU spin or starvation. |
| `src/services/renewal.ts`, `renewal-worker.ts` | Physical source renewal | Preserve freeze; use shared admission without double-counting pacing. |
| `src/services/publisher.ts` | Prepared delivery | Carry occurrence context, safe deferral, atomic attempt binding, guarded request initiation. |
| `src/services/prepared-transfer.ts` | Per-step API calls | Move `beforeRequest` to actual dispatch rather than before a pacing wait. |
| `src/services/scheduler.ts` | Occurrence scanning | Query persistent retries independently of scan cursor and recover crash gaps. |
| `src/telegram-cooldown.ts` | Shared mutation transformer | Distinguish local deferral from actual Telegram 429; central incident observations. |
| `src/telegram.ts` | Raw Telegram gateway | Preserve edit response evidence and support scoped dispatch context. |
| `src/services/alerts.ts` | Alert delivery | Durable notification intent and actual-delivery acknowledgement. |
| `src/application.ts` | Composition and workers | Wire new repositories/services; remove competing flood recovery paths. |
| `src/handlers/admin.ts` | Commands, callbacks, prompts | Durable response intents and update receipts; no delayed `ctx.reply`. |
| `src/db/admin-repository.ts` | Prompts, tokens, audit | Pending-delivery prompts and delivery-time activation. |
| `src/services/recovery.ts` | Explicit message recovery | Keep remote preview operations separate from reply delivery; preserve freeze for known items. |
| `src/services/health.ts`, `retention.ts` | Operations visibility/cleanup | Report new pending/uncertain states and retain live work. |

Important traps:

1. `QueueItemRecord` is in `src/domain/queue-item.ts`, not `src/types.ts`.
2. Validators reconstruct objects and discard unknown fields. Adding an interface field alone does not persist it through validation.
3. `validatePreparationContractV1` accepts only version 1. Publication/renewal prepared contracts accept version 2. Use explicit additive fields/defaults rather than breaking old evidence accidentally.
4. `findBySource` does not by itself exclude a removed current-generation member. For an edit, require `findKnownSource(...).current && !removed`.
5. `pending_queue_updates` keeps `update_kind='post'` if an edit arrives during initial buffering. Without a separate monotonic edit marker, the post loses evidence of the edit.
6. The pending finalizer currently applies legacy generated-post suppression and preparation-output suppression to edits too. That can swallow admin edits to provisional outputs.
7. `beginPrompt()` expects a real Telegram message ID. An outbox cannot fabricate that ID or pretend a queued response was already sent.
8. `bot.start()` processes these updates sequentially. Sleeping inside a reply transformer blocks subsequent commands and queue edits.
9. Schedule operation IDs currently become associated with runs only after `publishNext()` returns. Fix that crash gap before adding automatic retries.
10. `markQueueItemPrepared()` aligns applied/wanted revisions in fixtures. Do not use it for the original enqueue-after-existing-nickname regression; it hides the bug.
11. `createFakeClock.sleep()` advances time immediately. Do not run infinite worker loops with it; use a manually advanced clock with deferred sleepers.
12. The original diagnostic probes asserted observed defects, not corrected behavior. They were removed after the cases moved into regression tests; do not restore them as green checks that continue to require the bug.

## 3. Work order and checkpoints

Implement in this order. Keep each checkpoint typechecking and its relevant tests passing before proceeding.

1. Preserve the known reproductions as failing corrected-behavior tests; build a controlled clock helper.
2. Add nested synchronous transaction support and migration scaffolding.
3. Add whole-post freeze, edit provenance, and generated-edit lifecycle storage.
4. Fix revision initialization/reconciliation, frozen adoption, no-op refresh, and all mutation guards.
5. Add durable scheduled retry storage and atomic occurrence/operation association.
6. Add central outbound admission and real-429/success observations.
7. Add persistent incident lifecycle.
8. Add admin update receipts, action dispatch, response outbox, and delayed prompts.
9. Integrate all workers, alerts, health, retention, shutdown, and migrations/backfill.
10. Run original scenarios, full required checks, documentation updates, and final diff review.

Do not stop after fixing only the first refresh loop. The requested scope also includes permanent admin protection, missed occurrences, retained responses, notification grouping, and restart/crash behavior.

## 4. Test harness before implementation

Use real temporary SQLite databases from `test/support.ts`; use fake Telegram transports or explicit gateway fakes. Never use a production token, production channel, SSH session, or production database in tests.

### 4.1 Regression coverage

The implementation is complete. The original defect probes have been removed; the corrected behavior is covered by the named test suites below. Keep these assertions when changing the implementation:

1. Existing alias -> new submission -> preparation -> next scan converges to ready with one actual transformation (`preparation.test.ts`, `preparation-repository.test.ts`).
2. Admin body edit leaving the credit unchanged -> nickname change issues zero subsequent automatic edit calls (`ingestion.test.ts`, `preparation.test.ts`).
3. No-op refresh -> manual edit -> manual restoration to previous bot text is accepted and stored (`ingestion.test.ts`).
4. Scheduled definite 429 -> advance within deadline -> scheduler retry publishes once without a manual trigger (`scheduler.test.ts`, `publisher.test.ts`).
5. A command during cooldown does not hold subsequent middleware calls open; its response eventually delivers (`admin-reliability.test.ts`, `telegram-admission.test.ts`).
6. If an opening warning cannot deliver and the wait clears, no standalone recovery notification is sent (`operations.test.ts`, `admin-reliability.test.ts`).

### 4.2 Add a controlled clock

Add a test helper, for example `createControlledClock(initialNow)` in `test/support.ts`:

- `now()` returns the manually set time.
- `sleep(ms)` records a deadline and returns a pending promise.
- `advance(ms)` advances time and resolves only due sleepers.
- `flush()` drains bounded microtasks without recursively advancing time.
- Tests can inspect scheduled sleepers and abort workers.
- Every continuous-worker test explicitly aborts and awaits its workers in `finally` before closing SQLite.

For races, use a held fake gateway or held raw fetch with explicit `requestEntered` and `releaseRequest` promises. Distinguish a request waiting for admission from one already passed to the transport.

## 5. Transaction support

Modify `src/db/database.ts` narrowly so existing transaction-owning repositories can participate in atomic admin effect/receipt/outbox updates.

Required behavior:

```text
outermost transaction -> BEGIN IMMEDIATE / COMMIT / ROLLBACK
nested transaction   -> SAVEPOINT internal_N / RELEASE / ROLLBACK TO + RELEASE
```

- Generate savepoint names only from a private integer counter, never user input.
- Track depth in `try/finally`; an exception must not leave the connection believing it is inside a transaction.
- A caught inner failure rolls back only that savepoint; an outer failure rolls back all nested work.
- Reject thenables returned from the transaction callback. The callback must finish synchronously.
- Do not change the migration runner's own raw transaction mechanism.
- Never call a remote gateway, wait for admission, or await a response inside `database.transaction`.

Add meaningful tests for nested success, inner rollback caught by outer code, outer rollback after inner success, thrown errors, and rejected asynchronous callbacks. Keep foreign keys enabled and WAL behavior unchanged.

## 6. Migration 6: editorial protection and expected-edit evidence

Append a migration; do not edit versions 1–5.

### 6.1 Queue item fields

Add these nullable columns to `queue_items`:

```sql
editorial_frozen_at INTEGER
editorial_freeze_reason TEXT
  CHECK (editorial_freeze_reason IN
    ('admin_edit','admin_delete','legacy_edit_evidence','legacy_unverified'))
editorial_freeze_message_id INTEGER
editorial_freeze_update_id INTEGER
```

`editorial_frozen_at IS NOT NULL` is the canonical protection predicate. Keep the reason/provenance separate from `attribution_json.ownership`.

Also add nullable `nickname_revision_wanted_key TEXT` and `nickname_revision_applied_key TEXT`. These identify the policy identity to which each revision belongs. A revision from one author identity cannot be numerically compared with a revision from another identity; see section 7. Initialize new non-author renditions with key `none` and revision zero. Legacy prepared items are conservatively frozen, so do not invent an applied identity for ambiguous old output.

- Add matching optional fields to `QueueItemRecord`, `QueueRow`, and `rowToItem`.
- Validate safe nonnegative millisecond timestamps, positive message IDs, and safe update IDs in repository boundaries.
- The freeze timestamp is monotonic: preserve the first freeze, not the most recent edit time.
- Later accepted admin edits still update the current snapshot/version; they do not remove or reset the freeze.
- No normal application method may set `editorial_frozen_at` back to NULL.
- There is no automatic unfreeze action in this scope.

### 6.2 Pending unmatched edit provenance

Add to `pending_queue_updates`:

```sql
unmatched_edit_at INTEGER
unmatched_edit_update_id INTEGER
```

Extend `PendingUpdateCapture`, `PendingRow`, and `PendingQueueUpdateRecord` explicitly.

- These fields mean an edit was not established to be a current bot echo.
- Preserve the earliest unmatched edit timestamp monotonically during UPSERT, even if `update_kind` stays `post`.
- Preserve the latest snapshot by Telegram update/edit ordering; an older replay must not overwrite a newer snapshot.
- Matching a generated POST does not erase unmatched EDIT provenance.
- Process unmatched-edit provenance BEFORE generic POST suppression, including when the row still says `update_kind='post'`. A coalesced generated post plus unmatched admin edit must not disappear through a post-only suppression branch.
- On item creation/album finalization, apply the pending freeze provenance in the same transaction as adopting that current source.
- For unknown isolated edits with no matching source or provisional output, retain/discard according to existing recovery policy; do not invent a new queue item from an edited message alone.

### 6.3 Generated-edit request evidence

Add request-lifecycle fields to `queue_generated_events` without changing its existing `pending/matched/obsolete` state CHECK:

```sql
request_state TEXT NOT NULL DEFAULT 'legacy'
  CHECK (request_state IN
    ('legacy','queued','in_flight','accepted','rejected','unknown'))
request_started_at INTEGER
request_finished_at INTEGER
observed_after_update_id INTEGER
expected_edit_date INTEGER
valid_until INTEGER
```

The response-order implementation also stores a provisional update snapshot, its receipt time, and update ID while an edit request is in flight. If migrations 6–9 have already been committed or applied, add these fields in a new migration rather than editing migration 6.

Use `state` for whether an expected update is still matchable; use `request_state` for what is known about the outbound attempt. Do not conflate the two.

An expected edit must have an exact event ID returned by `expectEdit`. A failed/no-op request retires that exact ID, not every post/edit expectation belonging to the operation.

### 6.4 Conservative rollout backfill

Perform these classifications in this order, only for nonterminal items:

1. Existing attribution ownership `admin` -> frozen reason `legacy_edit_evidence`.
2. Historical `pending_queue_updates` rows with `state='ingested'` and `update_kind='edit'`, joined to an unremoved member of the item's CURRENT source generation -> `legacy_edit_evidence`.
3. Remaining active `representation_kind='prepared'` items -> `legacy_unverified`.

Use one migration timestamp, not a different arbitrary time for each row. Do not infer a Telegram editor ID. Do not rewrite historical content, origin, IDs, queue age, or FIFO order.

Preserve statuses, operation ownership, uncertain evidence, retries, and cleanup obligations. In particular:

- Do not blanket set every frozen item to `ready`.
- Do not clear an uncertain operation because the item is now frozen.
- Do not install an old transformation result over the visible post.
- Continue safely necessary source cleanup only from immutable recorded obsolete IDs.
- Do not freeze current posts based on edits to an obsolete/removed source.

Retire pre-rollout pending EDIT expectations belonging to definitively finished/failed work that cannot safely identify a future echo. Preserve evidence for unresolved work and let guarded recovery classify it. Do not indiscriminately remove POST expectations for tracked outputs.

### 6.5 Migration tests

Upgrade a real version-5 fixture and assert all of the following:

- Reapplying migrations is idempotent.
- Current admin-owned, current ingested-edit, and unverified prepared items receive the right reasons.
- A raw post with proven accepted edit freezes; a raw post without evidence is not blanket-frozen.
- Obsolete-source and removed-member edits do not count as current edit evidence.
- `collecting` albums stay collecting.
- Uncertain/publishing/cleanup-pending rows keep their owners/evidence/statuses.
- IDs, `logical_sequence`, enqueue time, generation, and source snapshots are unchanged.
- `PRAGMA foreign_key_check` returns no rows.

## 7. Revision initialization and convergence

### 7.1 New submissions

Do not let a new item inherit wanted revision zero merely because no later nickname-change event has touched it.

In the logical enqueue transaction:

1. Observe the original semantic author using existing exact user/hidden-sender identity rules.
2. Resolve the rendition name, policy identity key, and its actual revision together, as specified below.
3. Insert `nickname_revision_wanted` and its key from that resolved policy.
4. Preserve the originally captured forwarding mode and policy timestamp.
5. If this submission carries unmatched admin-edit provenance, freeze it instead of scheduling a transformation.

Make author observation + item insertion + initial revision atomic using the tested transaction support. Do not trim/normalize hidden sender names. Do not replace the original semantic origin with the native origin of a prepared copy.

Cover first album member, added members, finalization, direct posts, recovered items sent explicitly through preparation, and user/hidden-user nickname removal as well as addition.

### 7.2 Claiming and rendering

Add a policy repository resolver such as `resolveCreditPolicy(origin)` returning `{ name, alias, revisionKey, revision }` from the SAME resolved identity. The present `aliasForOrigin(user)` can use a username fallback to another known-author row, while `aliasRevisionForOrigin(user)` reads only the original user ID. Calling the two methods in one transaction does not fix that identity mismatch.

Preserve current name lookup precedence, but obtain the selected nickname's revision from the same selected row. Use stable policy keys such as `user:<resolved-user-id>` or `hidden:<known-hidden-author-id>`. Never replace the original semantic sender identity with this lookup key; it is only credit-policy bookkeeping.

For an unfrozen item, reconcile requested policy separately from the rendition actually read:

```text
resolved = resolveCreditPolicy(origin)
if stored wanted key == resolved.revisionKey:
    wanted = max(stored wanted, resolved.revision)
else:
    wanted key/revision = current resolved key/revision
captured rendition key/revision = resolved key/revision that supplied the NAME
```

Capture name and its ACTUAL revision from the same database snapshot. Do not label current text with an arbitrary larger wanted revision merely to pass readiness. If the same-key stored target is inexplicably ahead of the actual policy revision, expose inconsistent policy state and keep the post unready/reviewable instead of looping or falsely claiming that revision was rendered.

Add an optional `targetNicknameKey` to the version-1 preparation contract and an explicit applied-key field to preparation results. Update their validators to retain these fields. Store the applied key on the item alongside the applied revision. Missing legacy keys require conservative reconciliation; do not silently compare unrelated revision spaces.

### 7.3 Installing a result

Use a shared repository helper for all initial, in-place, refresh, renewal-release, retry, and recovery paths. Its essential rule is:

```text
if frozen:
    no automatic transformation; use frozen adoption/validation policy
else:
    resolve current policy key/revision inside the transaction
    reconcile wanted key/revision with current policy as described above
    for the SAME key, repair obsolete lower wanted using proven applied/current revision
    never compare revision numbers belonging to different keys
    store resultApplied key/revision as captured, not relabelled
    ready iff applied key/revision == wanted key/revision
    otherwise refresh_pending
```

The current policy must be read safely in the transaction, not fetched over the network. An old output does not become ready if a newer nickname or resolved policy identity arrived while a request was awaited. Change alias-update invalidation and all readiness predicates to compare the key/revision pair, not only the old integers.

Do not fix the problem by changing every mismatch to ready. That would silently publish stale names.

Do not fix only the API-call loop. A no-op renderer returning immediately while preserving `refresh_pending` would still spin the CPU and starve later items.

### 7.4 Existing rows and owner release

Normalize stale wanted/applied bookkeeping for existing active rows without lowering newer wanted/current-author revisions. Do this in migration-compatible startup reconciliation before workers start, then keep every ordinary owner-release path correct.

Do not reclaim in-flight or uncertain operations just to run the repair. Let existing evidence-based recovery classify them first.

Return the actual stored state from `completeInPlacePreparation` and `completeInPlaceRefresh`; propagate it through `PreparationOutcome`. Remove the hardcoded `preparationState: 'ready'` when SQLite retains `refresh_pending`.

### 7.5 No-op rendering

Before registering an expected edit or dispatching an API call, compare a canonical edit payload:

- Text or caption.
- Relevant entity arrays.
- Link-preview options used by text edits.
- `showCaptionAboveMedia` for supported captions.

Use stable normalization of absent/default values; do not compare unrelated metadata such as view counters, old update IDs, or timestamps.

If the visible rendition is identical:

1. Make no Telegram edit request.
2. Create no expected-edit event.
3. Advance nickname revision bookkeeping and operation completion atomically.
4. Converge state using the rule above.
5. Do not repeatedly increment content version for unchanged content on subsequent empty scans.

If Telegram still returns a definite `message is not modified`, treat it as a confirmed no-op, retire the exact edit expectation, and complete bookkeeping. Do not leave it matchable for a later admin restoration.

## 8. Permanent whole-post protection

### 8.1 Add one atomic accepted-admin-edit method

Introduce a clearly named queue repository method such as:

```ts
acceptAdminQueueEdit(input: {
  chatId: number;
  messageId: number;
  snapshot: StoredMessageSnapshot;
  updateId?: number;
  receivedAt: number;
}): { kind: 'accepted' | 'stale' | 'obsolete' | 'unknown' | 'collision'; itemId?: number };
```

Use a discriminated union with stricter variants in real code rather than optional data for every case. The important behavior is this transaction:

1. Resolve known source membership FIRST. If it is obsolete or removed, stop before provisional-output lookup. Only otherwise consider a provisional output belonging to a live not-yet-adopted operation. `preparationOutputOperation` currently finds historical outputs forever and is not by itself proof that an output is provisional.
2. Reject stale/duplicate update ordering before modifying protection or content.
3. Preserve the original semantic origin; accept current content/media/formatting.
4. Persist first freeze time/reason/provenance for the WHOLE item.
5. Increment the item's content version for a newly accepted revision.
6. Retire superseded expected edits for this message.
7. Release only transformation work proven not to have started remotely.
8. If a request may already have started, preserve output/request evidence and transition to review instead of adopting stale results.
9. Mark the pending update ingested in the same transaction when present.

Do not retain bot rewrite permission just because `inspectInlineCreditEdit` sees the old suffix. That helper can still inspect historical credit shape; it is no longer the authority for whether a queue item may be rewritten.

### 8.2 Ingestion branches to implement explicitly

| Incoming event | Required action |
| --- | --- |
| Confirmed current bot POST echo | Suppress using post evidence; do not create another item. |
| Confirmed current bot EDIT echo | Match only its specific accepted request evidence; do not freeze. |
| Unmatched edit of current unremoved source | Accept content and freeze whole item atomically. |
| Edit during initial post buffer | Preserve unmatched-edit marker; freeze when item is created/finalized. |
| Unmatched edit of known provisional preparation output | Associate with owning item, freeze, preserve latest output snapshot, and resolve collision safely. Do not suppress merely because output ID is known. |
| Edit of obsolete source generation | Do not overwrite or freeze the current item. Retain appropriate audit/pending classification. |
| Edit of intentionally removed member | Do not restore member or freeze another representation accidentally. |
| Unknown edit with no known source/output | Keep existing non-discovery policy; no invented queue post. |
| Duplicate/stale edit | Idempotent no-op; do not regress snapshots or create another issue. |

Restrict `generated.consume(chatId, messageId)` and generic `preparationOutputOperation` POST suppression to POST events. Edits require edit-specific handling.

### 8.3 Frozen raw adoption

Add an in-place metadata adoption path, using the latest accepted current members:

- Wait for album collection to finish first.
- Preserve content, caption, formatting, all members, ordering, existing credit, and native forwarding attribution.
- Record a prepared representation as shown without copy-and-append or edit calls.
- Preserve per-member copy/forward semantics so later publication reproduces the visible form without introducing the queue channel's attribution.
- Validate that the representation can be delivered; invalid/unsupported content may still need review.
- Never add a missing credit, reconstruct a deleted credit, or apply a later nickname.

Corrective edits to a failed post can clear an obsolete issue and revalidate the new representation. They must not reopen automatic transformation rights.

### 8.4 All paths that must preserve freeze

Search and audit every path that updates `preparation_state`, `representation_kind`, `attribution_json`, source generation, or nickname revisions. Include:

- Alias set/remove for identifiable and hidden senders.
- `retryItem` and `markPreparationNeeded`.
- Preparation retry, owner release, expired-operation recovery, and uncertain resolution.
- `reprocessRecoveredItem` and reuse of known recovered items.
- Initial/renewed generation installation and adoption of uncertain replacement output.
- Publication retry, publication uncertainty resolution, and source cleanup.
- Intentional member removal, moving an item to the end, and legacy-row normalization.

None may clear freeze or restore bot rewrite rights. An explicit “Apply preparation rules” action must not silently unfreeze an already frozen known item; return an explanatory unchanged result.

Change `src/domain/prepared-post.ts:isPreparedPostReady` and BOTH production predicates in `src/db/repositories.ts`—`readyPublicationQuery` and `claimReadyPublication`'s CAS—so a valid frozen post is not blocked merely because wanted/applied nickname key/revisions differ. The domain helper alone does not control production eligibility.

### 8.5 Version checks at real request initiation

Checking before a pacing sleep is insufficient. At actual dispatch:

1. Flush/process known pending edits for the subject, without recursive outbound work.
2. Re-read item version, source generation, operation ownership, and freeze.
3. Reject any content-edit request for a frozen post.
4. Reject any request whose captured state is stale.
5. Persist `transfer_pending`/`attribution_pending` immediately before calling the raw API.

Source-preserving publication/renewal transfers are allowed for frozen posts, but their captured state still needs the normal version/ownership checks. Cleanup of immutable obsolete IDs is a different capability; do not accidentally prohibit safe cleanup or permit a content rewrite by calling it cleanup.

## 9. Expected bot edit lifecycle

### 9.1 Explicit attempt identity

Change preparation repository `expectEdit` to return an event ID. Add repository operations such as:

```ts
markEditRequestStarted(eventId, startedAt, observedAfterUpdateId)
markEditAccepted(eventId, finishedAt, editDate, validUntil)
markEditRejected(eventId, finishedAt)
markEditUnknown(eventId, finishedAt)
obsoleteMessageEdits(chatId, messageId, acceptedAdminUpdateId, now)
```

The exact names can follow repository conventions; do not omit any transition.

### 9.2 Preserve edit response evidence

`TelegramGateway.editText` and `editCaption` currently discard API responses and return `Promise<void>`. Change them to return an explicit edit receipt with whatever evidence Telegram actually returned, for example:

```ts
type TelegramEditReceipt = {
  messageId: MessageId;
  editDate?: number; // milliseconds, consistently with StoredMessageSnapshot
  contentFingerprint?: string;
};
```

Validate real returned message IDs. Do not manufacture an edit timestamp when Telegram omitted it. Update all fake gateways and adapter tests; a grep for both methods should find every stub.

Match a bot edit using request identity, current operation evidence, expected content, available returned edit timestamp, and update ordering. A fingerprint alone is insufficient forever.

Use a bounded 60-second accepted-echo matching window as an initial conservative default. A very late or ambiguous matching update must take the conservative protection/review path, not silently grant bot rights. This can cause false-positive protection; it must not cause a human edit to be overwritten.

### 9.3 Responses and echoes can arrive in either order

- If an echo arrives while the request is still `in_flight`, persist it provisionally; reconcile it when the request result becomes known.
- Do not immediately discard a provisional same-fingerprint edit as proof of bot authorship.
- If the request returns accepted evidence that matches the provisional update, classify the echo as generated.
- A differing provisional update freezes the item and records a collision.
- If the response is lost or evidence cannot distinguish a human edit from the bot result, preserve content and require review. Do not retry the edit automatically.
- On a definite 429, definite preflight failure, or `message is not modified`, mark that EDIT expectation obsolete. A failed request cannot justify suppressing a future edit.
- On an accepted admin edit, retire older expectations so restoring an old bot rendition is still ingested.

The Bot API has no app-supplied conditional content version. Document the in-flight limitation; do not claim an `AbortController`, local mutex, or SQL CAS can revoke a request Telegram already received.

## 10. Migration 7: durable publication occurrences and attempts

### 10.1 Schedule run additions

Add:

```sql
ALTER TABLE schedule_runs ADD COLUMN retry_not_before INTEGER;
ALTER TABLE schedule_runs ADD COLUMN retry_deadline_at INTEGER;
ALTER TABLE schedule_runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedule_runs ADD COLUMN claim_token TEXT;
ALTER TABLE schedule_runs ADD COLUMN claim_boot_id TEXT;
ALTER TABLE schedule_runs ADD COLUMN cancelled_at INTEGER;
ALTER TABLE schedule_runs ADD COLUMN cancel_reason TEXT;
CREATE INDEX schedule_runs_retry_due_idx
  ON schedule_runs(status, retry_not_before, retry_deadline_at);
```

Initialize newly materialized runs with `retry_deadline_at = occurrence_at + 300_000`. Backfill that arithmetic for existing rows, but do NOT reopen old terminal runs.

`now < deadline` is the initiation rule for a fresh no-output publication attempt. At exactly the deadline, no new attempt starts. An already initiated request may finish afterward; do not mislabel its confirmed output failed and resend it. Once destination output exists, the deadline does not authorize abandoning and repeating the post: finish only the same captured operation when safe, or use partial-output uncertainty handling. A later step of that existing operation is not a fresh retry of the publication.

### 10.2 Attempt journal

Create `schedule_publication_attempts`:

```sql
CREATE TABLE schedule_publication_attempts (
  occurrence_at INTEGER NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  operation_id TEXT NOT NULL UNIQUE,
  item_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (occurrence_at, attempt_no),
  FOREIGN KEY (occurrence_at) REFERENCES schedule_runs(occurrence_at),
  FOREIGN KEY (operation_id) REFERENCES operations(id),
  FOREIGN KEY (item_id) REFERENCES queue_items(id)
);
```

Do not rely only on the last `schedule_runs.operation_id`: one bounded pass can try several definitively failing candidates. Recovery must see the evidence of EVERY associated operation.

### 10.2a Durable request-start evidence

Also add `operations.request_evidence_version INTEGER NOT NULL DEFAULT 0`. New operations created by the corrected code set it to 1. Zero means legacy/unknown, not proof that nothing was sent.

Create `operation_request_attempts` with:

```text
id                      TEXT PRIMARY KEY
operation_id            TEXT NOT NULL REFERENCES operations(id)
request_ordinal         INTEGER NOT NULL, UNIQUE(operation_id, request_ordinal)
method                  TEXT NOT NULL
target_chat_id          INTEGER NOT NULL
step_key                TEXT NULL
started_at              INTEGER NOT NULL
finished_at             INTEGER NULL
state                   TEXT NOT NULL: in_flight | accepted | rejected | unknown
error_kind              TEXT NULL
known_output_ids_json   TEXT NULL
```

Insert this row only at ACTUAL raw request initiation, together with the operation phase/expected-edit transition. Persist a definitive rejection or accepted output IDs as soon as the raw result is known. Do not store complete message contents or tokens in this journal.

Every operation-scoped raw mutation must pass this boundary; test that no alternate gateway path bypasses it. No request rows for an evidence-version-1 operation proves no request was initiated only under that enforced boundary. An `in_flight/unknown` row is possible output even when `operation_outputs` is empty. Accepted send output IDs are durable recovery evidence if the process stops before the publisher's higher-level output recording.

Preserve this journal when `recoverExpiredOperations()` changes an operation's phase to `failed/startup_recovery`. Existing code overwrites the original `claimed` phase; schedule recovery must use independent request evidence and cannot guess that every `startup_recovery` failure was safe.

Move the current early `beginPublicationTransfer` / `beforeRequest` transfer-pending writes into the actual admission dispatch path, or keep them explicitly non-wire preparation phases. They must not be mistaken for proof of a raw request starting before a pacing wait finishes.

### 10.3 Typed scheduled context

Extend the publisher input with an optional context:

```ts
type ScheduledPublicationContext = {
  occurrenceAt: number;
  deadlineAt: number;
  claimToken: string;
};
```

Pass it through `publishNext` to `claimReadyPublication`. In the SAME transaction that claims the queue item and creates its `operations` row:

1. Validate the run is owned, uncancelled, enabled, and before its immutable deadline.
2. Validate no associated attempt already has output or unresolved possibly-sent evidence.
3. Insert the attempt association.
4. Increment attempt count and bind the run's current operation/item.

Only then commit and permit outbound work. A callback executed after claim is not a substitute for atomic binding.

## 11. Scheduler algorithm and recovery

### 11.1 Repository methods

Add typed methods for:

- `duePending(now)`: reads existing eligible pending runs regardless of scan cursor.
- `nextPendingWake(now)`: earliest retry/expiry time.
- `claimRun(occurrenceAt, bootId, now)`: CAS ownership and return claim token.
- `deferRun(claimToken, retryAt, now, reason)`: running -> pending; preserve deadline/evidence.
- `finishRun(claimToken, outcome, now)`: terminal transition with ownership guard.
- `cancelPendingRuns(reason, now)`: persist cancellation and terminal failed status with explicit reason.
- `expirePendingRuns(now)`: pending runs at/after deadline -> failed `retry_window_expired`.
- `associatedAttempts(occurrenceAt)`: complete ordered operation evidence.

Use existing CHECK-valid statuses. A cancelled run is terminal `failed` with `cancelled_at/cancel_reason`; an expired run is terminal `failed` with a distinct error code. Do not overload uncertainty, no-output failure, and cancellation with one uninformative string.

### 11.2 One scan

Implement approximately this sequence, preserving existing slot effective-time/history rules:

```text
if scan already active: return
expire pending runs
if scheduling disabled: cancel pending retries; update discovery cursor; return
discover newly elapsed occurrences using existing slot materialization rules
mark old downtime occurrences skipped; do not backfill beyond the five-minute limit
cancel older unsent retry if a newer occurrence is now due
query due pending runs independently of discovery cursor
claim one eligible occurrence atomically
recheck all associated attempt evidence
if cooldown cannot end before deadline: expire without sending
call publishNext with scheduled context
persist outcome according to table below
update discovery cursor without erasing existing pending retry work
release scan guard
```

| Result | Schedule action |
| --- | --- |
| Cooldown/pacing deferral before any output | Pending with next due time, unless deadline expires. |
| Actual definite 429 before any output | Pending at persisted shared deadline, capped by fixed expiry. |
| Definite item-specific rejection | Preserve existing bounded-pass behavior; another eligible candidate may be tried within this occurrence/deadline. |
| Published | Terminal published. |
| Output complete, cleanup pending | Terminal published with cleanup marker; never resend. |
| Uncertain/partial/invalid output | Terminal failed with uncertainty; item enters existing review flow. |
| Empty | Terminal empty; do not turn an empty slot into an automatic future post. |
| Permission/access issue | Stop the run using existing shared failure policy; do not invent indefinite five-minute retries for every error kind. |
| Pause/manual success/newer occurrence | Cancel still-unsent scheduled retry; an already initiated result must be reconciled. |

### 11.3 Wake and cancellation

Wait until the earliest of next ordinary occurrence, pending retry, and pending expiry. Cap idle sleep at 1,000 ms, or use an equivalent explicit wake signal for schedule/pause/outbox changes. Never sleep only until `nextAt()` while durable retries are due.

Pausing must cancel pending retries in the same transaction as changing `schedule_enabled`. Removing a slot cancels its still-unsent pending occurrence. Resume/slot recreation establishes a new cursor and cannot revive cancellations.

Successful manual publication includes confirmed output with cleanup pending. Cancel pending scheduled retries then, not only after source deletion succeeds. A failed or ambiguous manual send does not pretend to be a confirmed success; it retains its own evidence and existing safety rules.

Add one shared `src/services/publication-coordinator.ts` async coordination lock used by scheduled AND manual publish-next execution. Hold it through confirmed-output recording and pending-retry cancellation, without holding a SQL transaction across awaits. Do not release it merely because the raw gateway promise returned. This closes the gap in which admission could release a manual raw send and dispatch a queued scheduled send before the publisher saves the manual success/cancellation.

Recheck cancellation after acquiring this coordination lock and again at actual request dispatch. Persist cancellation before releasing the manual-success critical section. An already initiated scheduled operation still needs evidence-based result handling; cancellation is not permission to forget its output.

### 11.4 Startup recovery

Recover ordinary queue/preparation operations first, then reconcile runs against all associated attempts:

| Evidence | Recovery |
| --- | --- |
| Complete destination output or cleanup pending | Mark published; cleanup only. |
| Any request may have reached destination, or partial output exists | Mark uncertainty; no automatic retry. |
| Evidence-version-1 claim with no initiated request journal row | Safe pending retry only before original deadline and if still enabled/uncancelled. |
| Definite recorded 429/no-output rejection | Safe pending retry at saved deadline, within original window. |
| No association/evidence for an old running legacy run | Preserve conservative failed/review behavior; do not guess no output. |
| Deadline passed or cancellation saved | Terminal; no send. |

## 12. Shared outbound admission and local deferral

Add:

- `src/telegram-request-context.ts`: `AsyncLocalStorage`-based request scope or an equally explicit per-request context that cannot leak between concurrent callers.
- `src/services/telegram-admission.ts`: one process-wide admission queue and pacing/dispatch coordination.
- A repository for persisted pacing deadlines, plus central real-429 observation hooks.

Do not store the current request context in one mutable global variable; concurrent workers would overwrite it.

### 12.1 Scope contract

Each mutation scope carries:

```ts
type TelegramMutationScope = {
  family: 'publication' | 'renewal' | 'preparation' | 'cleanup' | 'admin_response' | 'control' | 'recovery';
  priority: 'publication' | 'admin' | 'urgent_maintenance' | 'background';
  operationId?: string;
  itemId?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
  beforeDispatch?: () => void; // synchronous final DB checks + request-start evidence
};
```

Carry expected version/generation/freeze checks in the `beforeDispatch` closure or explicit validated subject fields. Never serialize closures to SQLite; durable work reconstructs them on startup.

At admission time, check configured chat scopes and classify whether a method creates a message, edits one, deletes immutable cleanup IDs, or controls bot settings. Do not accidentally treat recovery-preview forwards to the admin chat as reply-outbox messages.

### 12.2 Pacing and priority

- Use one raw mutation in flight at a time initially.
- Exempt `getUpdates`, identity/rights reads, and `answerCallbackQuery` from mutation pacing/cooldown as already intended.
- For plural transfer methods charge their member count against per-chat message pacing; do not charge a ten-member album as one free message.
- Prioritize due publication, then retained admin responses, then age-critical maintenance, then ordinary background transformations/cleanup. Existing renewal deadline/capacity checks remain active.
- A queued background request can yield to eligible foreground work before dispatch. Do not interrupt a request already sent.
- Keep per-chat/global next-admission timestamps durable so restart does not create an avoidable burst.
- Shared Telegram `retry_after` overrides local pacing. Never send early based on priority.

Local pacing may await admission in a BACKGROUND/ACTION worker. It must not await inside an inbound admin handler; that handler only stores durable work and returns.

Multi-step prepared transfers must not become uncertain solely because proactive local pacing waited between members. Wait for admission for the next safe step and recheck guards; a REAL 429 after partial output still uses the existing partial-output uncertainty policy.

### 12.3 Local deferral is not a real Telegram error

Introduce a tagged error/outcome, for example `TelegramLocalDeferralError`, carrying `reason`, `retryAt`, and `requestStarted: false`.

Reasons: `shared_cooldown`, `deadline`, `cancelled`, `protection_changed`, or `shutdown`. Normal proactive pacing can wait in the admission queue; it need not fabricate a 429.

Update `NormalizedTelegramErrorKind`, classification, and every relevant service switch explicitly. Do not let a local typed error fall through as `unknown_permanent`, `transient_network`, or ambiguous output.

The current synthetic 429 behavior may be replaced by the tagged error. Update tests accordingly; assert the semantic guarantee—no network request during the wait—not a fabricated Telegram response shape.

Only ACTUAL raw Telegram 429 responses update the incident's last failure. Preserve durable cooldown extension in one central place; remove service-level duplicate extension that rounds/restarts the same wait. Gateway fakes in tests must model this ownership explicitly.

### 12.4 Actual dispatch sequence

```text
select eligible queued request by priority and chat/global pace
if stopping/lease lost: cancel locally, no raw request
if shared cooldown active: defer/wait without observing another Telegram failure
if request deadline reached: cancel locally
run final synchronous subject/occurrence/protection guard
persist request-start phase / expected-edit in_flight evidence
advance local pacing reservation
invoke the raw API exactly once
record accepted result, real429, definite rejection, or uncertainty
release admission slot
wake eligible work
```

Never hold a SQLite transaction open around the raw API call. If the process crashes after request-start evidence but before a definitive result, recovery treats it conservatively as possibly sent.

## 13. Migration 8: pacing and shared incident persistence

### 13.1 Pacing table

```sql
CREATE TABLE telegram_admission_state (
  scope_key TEXT PRIMARY KEY,
  not_before INTEGER NOT NULL CHECK (not_before >= 0),
  updated_at INTEGER NOT NULL
);
```

Use `global` and `chat:<numeric-chat-id>` keys. Continue using the existing system-owned `telegram_mutation_not_before` setting for the REAL shared flood deadline; do not create two conflicting cooldown authorities.

### 13.2 Incident table

Create `telegram_incidents` with these fields:

```text
id                         TEXT PRIMARY KEY
condition_key              TEXT NOT NULL
state                      TEXT NOT NULL: active | recovering | resolved
first_failure_at           INTEGER NOT NULL
last_failure_at            INTEGER NOT NULL
cooldown_until             INTEGER NOT NULL
quiet_until                INTEGER NOT NULL
last_relevant_success_at   INTEGER NULL
action_required            INTEGER NOT NULL DEFAULT 0, CHECK 0/1
warning_outbox_id          TEXT NULL
warning_delivered_at       INTEGER NULL
recovery_outbox_id         TEXT NULL
recovery_delivered_at      INTEGER NULL
resolved_at                INTEGER NULL
```

Create a partial unique index on `condition_key` where `state <> 'resolved'`. Start with `condition_key='flood_wait'`; do not merge unrelated permissions and content issues into the same incident.

Do not add foreign keys to outbox IDs before the outbox table exists. Either add explicit validation/linking in migration 9 or keep the reference as a validated application link. Use unique outbox dedupe keys for actual notification uniqueness.

### 13.3 Incident service methods

Add `src/db/telegram-incident-repository.ts` and `src/services/telegram-incidents.ts` with explicit operations:

- `observeRealFloodWait(now, notBefore, method, family)`.
- `observeRelevantSuccess(now, family, subjectChat)`.
- `evaluate(now)` to enqueue/cancel notification intents and finish stable recovery.
- `acknowledgeWarningDelivered(incidentId, outboxId, now)`.
- `acknowledgeRecoveryDelivered(incidentId, outboxId, now)`.
- `snapshot()` for health.

### 13.4 State transitions

On the first real 429, start one incident. On later real 429s while it is open:

1. Keep the same incident ID and original first failure.
2. Update last failure and longest cooldown deadline.
3. Set `quiet_until = latest actual cooldown end + 300_000`.
4. Invalidate a success that predates the latest wait.
5. Cancel an unsent recovery intent and return to active.

Local blocked requests do NONE of those things. They are consequences, not new failures.

Relevant success means a confirmed permitted queue/target mutation after the latest wait. Admin warning delivery, callbacks, `getMe`, and unrelated reads must not prove queue recovery. No-op 400 responses are not successful queue mutations.

Recover only when all are true:

```text
now >= quiet_until
shared cooldown inactive
last_relevant_success_at >= latest cooldown end
no newer real429 invalidated that success
```

Keep short successfully recovered episodes silent. Do not manufacture a warning merely because the five-minute quiet observation period is still running: if the wait has ended and relevant work succeeded, the system can be healthy while awaiting stable closure.

A long or recurring active disruption becomes warning-eligible at `first_failure_at + 300_000`; action-required issues qualify immediately. For the ordinary flood warning, require the threshold AND either an active cooldown or no relevant success since the latest cooldown end. A healthy episode awaiting quiet-period closure is not itself five minutes of continuing disruption. Recheck this same predicate at dispatch so a delayed opening warning does not arrive after known recovery work merely because it was previously queued.

Queue the warning once. If stable recovery is established before an undelivered opening warning is dispatched, cancel that warning and send no recovery. If the warning was delivered, enqueue one recovery with dedupe key `incident:<id>:recovery` after stable recovery.

Use state `recovering` while stable closure is established but a paired recovery notification is still pending; do not mark the episode resolved prematurely. An episode with no delivered opening warning can resolve silently after stable closure. A warned episode resolves after recovery delivery acknowledgement.

Recheck recovery eligibility at actual delivery, not only when enqueued. A new real failure while recovery is queued cancels it and returns the same episode to active. If recovery was already sent before the new failure, the next failure is a new episode.

For the same episode becoming stable again, atomically re-arm its existing CANCELLED, definitely-unsent warning/recovery outbox row rather than inserting another row with the same unique dedupe key. Clear claims and request-start fields, validate current eligibility, and return that row to pending. Never re-arm a `sent` or `uncertain` row. This applies to an unsent opening warning that becomes eligible again too. Recheck incident eligibility and re-arm in one transaction.

### 13.5 Remove competing legacy paths

In `src/application.ts`, replace:

- Publisher `onSharedFailure` raising a competing flood fingerprint.
- Publisher `onSharedRecovery` resolving every active `shared_issue:*` after one publication.
- Alert-loop immediate resolution when `telegramCooldown.isActive()` becomes false.

Keep permission and other issue handling scoped to their own conditions. A publication success must not automatically declare all permissions/outages repaired.

Migrate an old flood alert conservatively: preserve actual `last_sent_at` if present, but never infer delivery from first/last observation or enqueue time. Existing rows with no confirmed warning must not cause recovery spam at startup.

## 14. Migration 9: admin receipts, responses, and pending prompts

### 14.1 Admin update receipts

Create `admin_update_receipts`:

```text
update_id              INTEGER PRIMARY KEY
admin_id               INTEGER NOT NULL
action_kind            TEXT NOT NULL
action_payload_json    TEXT NOT NULL
state                  TEXT NOT NULL: queued | running | applied | uncertain | rejected
boot_id                TEXT NULL
claim_token            TEXT NULL
operation_id           TEXT NULL
result_json            TEXT NULL
accepted_at            INTEGER NOT NULL
updated_at             INTEGER NOT NULL
```

Store normalized action descriptors, not a serialized grammY `Context`, bot token, or entire raw update. Authorize before inserting a receipt. Enforce the configured private admin ID/chat.

### 14.2 Response outbox

Create `admin_response_outbox`:

```text
id                     TEXT PRIMARY KEY
dedupe_key             TEXT NOT NULL UNIQUE
update_id              INTEGER NULL
response_ordinal       INTEGER NULL
admin_chat_id          INTEGER NOT NULL
kind                   TEXT NOT NULL: view | confirmation | prompt | warning | recovery | control
descriptor_version     INTEGER NOT NULL DEFAULT 1
descriptor_json        TEXT NOT NULL
coalesce_key           TEXT NULL
state                  TEXT NOT NULL: pending | sending | sent | uncertain | failed | cancelled
created_at             INTEGER NOT NULL
next_attempt_at        INTEGER NOT NULL
attempt_count          INTEGER NOT NULL DEFAULT 0
claim_token            TEXT NULL
claim_boot_id          TEXT NULL
lease_expires_at       INTEGER NULL
request_started_at     INTEGER NULL
telegram_message_id    INTEGER NULL
sent_at                INTEGER NULL
last_error_kind        TEXT NULL
last_error_description TEXT NULL
```

Add CHECKs for enum values, nonnegative counts, positive actual message IDs, and valid ordinals. Add a due-work index on `(state,next_attempt_at,created_at)` and an index on `(coalesce_key,state,created_at)`.

The receipt/ordinal uniqueness is enforced by a dedupe key such as `update:<update-id>:response:<ordinal>`. Notification keys are `incident:<id>:warning` and `incident:<id>:recovery`. Do not use text equality as identity.

Coalescing keys are per admin/view family, e.g. `admin:<id>:view:queue`. Coalesce only unsent views. Never overwrite a `sending` row whose result is still unknown; enqueue the newer view separately so it follows the current send.

### 14.3 Pending prompts

Extend `admin_prompts` with:

```text
generation_id          TEXT NULL
delivery_state         TEXT NOT NULL DEFAULT 'active': pending | active
delivery_outbox_id     TEXT NULL
```

Existing valid prompts start active. New delayed prompts start pending, with no fake `expected_reply_to_message_id`.

- A pending prompt cannot consume arbitrary input as a reply.
- `expires_at` already exists and is NOT NULL. For a pending prompt store `created_at` as an unused placeholder expiry, explicitly bypass expiry checks while pending, and make `purgeExpiredTokensAndPrompts()` delete prompts by expiry only when `delivery_state='active'`. Pending generations are cancelled/replaced explicitly rather than silently expiring before delivery.
- `getPrompt()` must distinguish pending from active, not treat missing reply ID as permission to accept anything.
- On successful prompt delivery, in one transaction, CAS the same generation, set the real message ID, set active, and start the 15-minute TTL at that time.
- A later prompt or `/cancel` cancels the older unsent generation/outbox intent.
- If an older prompt finished sending after cancellation, do not reactivate it. Best-effort cleanup of its actual sent message may be scheduled separately.

## 15. Admin handler and action refactor

### 15.1 New modules

Add:

- `src/db/admin-response-repository.ts`.
- `src/db/admin-update-repository.ts`.
- `src/services/admin-responses.ts` for typed intent enqueue/render/delivery acknowledgement.
- `src/services/admin-response-worker.ts`.
- `src/services/admin-actions.ts` for normalized actions requiring remote work.

Keep authorization and parsing at the handler boundary. Keep render functions testable without a live `Context`.

### 15.2 Incoming update handling

For each authorized command, callback, or prompt response:

1. Check numeric admin ID and private chat FIRST.
2. Normalize the requested action and use Telegram `update_id` as the receipt identity.
3. In a transaction, detect an existing receipt. If it is already applied/running/uncertain, do not execute the action again.
4. For callbacks, consume the single-use token in that transaction and persist its normalized action/payload. Recheck item versions when executing, too.
5. For database-only actions, perform the effect, receipt result, and response enqueue atomically using nested transaction support.
6. For remote actions, persist queued action work and return from middleware promptly. The action worker binds an operation/session BEFORE the first remote side effect.
7. Enqueue typed outcome views/confirmations; delivery belongs to the response worker.

Do not wait for flood expiry or pace admission in inbound middleware. Callback acknowledgements are best effort and must not discard a durable action/response if they fail. Keep unauthorized rejection handling outside the configured admin outbox.

### 15.3 Replace all authorized reply call sites

Audit every `ctx.reply` in `src/handlers/admin.ts`. Replace them with typed response intents, including:

- Dashboard, queue, schedule, whitelist, authors, hidden author, health.
- Publish confirmations, publish outcomes, uncertainty/recovery menus.
- Validation errors, stale-token/version explanations, cancellation messages.
- Prompt questions and invalid-input follow-ups.

Do not put a transformer under `ctx.reply` that returns a fake Telegram message when queued. Do not globally route `gateway.forwardMessage/copyMessage` into the reply outbox.

`src/services/recovery.ts` forwards preview messages to the admin chat and needs their actual IDs for its durable session. Those are remote recovery operations, not retained text responses; leave them under evidence-based recovery and the shared admission layer.

### 15.4 Remote action crash behavior

- Manual publish: receipt references the existing publication operation before wire initiation. Reconcile its recorded outcome; never issue a fresh publish-next because a confirmation failed to send.
- Recovery: receipt binds to an existing/new recovery session before preview forwards. Resume/reconcile that session, not a second unrelated session.
- Deletion: record the intended immutable IDs and operation before calling Telegram; a missing already-deleted source can be handled idempotently, but do not delete a later source generation by re-reading new IDs on replay.
- Read-only lookup: may retry as read-only work, but stores its confirmation/result independently.
- A receipt interrupted after possible remote side effects enters uncertainty or reconciles a known operation. Do not blindly replay an entire handler.

Do not claim end-to-end exactly-once Telegram effects. The achievable requirement is: duplicate inbound update IDs and response delivery retries cannot repeat a state-changing action; ambiguous remote effects retain explicit evidence.

### 15.5 Rendering and tokens

Store semantic descriptors such as:

```ts
type AdminResponseDescriptor =
  | { version: 1; kind: 'view'; view: 'dashboard' | 'health' | 'queue'; args: Record<string, unknown> }
  | { version: 1; kind: 'message'; text: string; actions?: StoredActionDescriptor[] }
  | { version: 1; kind: 'prompt'; generationId: string; promptKind: string; text: string; state: Record<string, unknown> }
  | { version: 1; kind: 'control'; action: 'set_commands' };
```

Expand the union for actual views rather than leaving unsupported descriptors in the database. Validate descriptor version/shape on both write and read.

- Render views from current state at delivery time.
- Generate callback tokens immediately before actual dispatch so the 10-minute TTL is useful after a long wait.
- If dispatch is deferred again, retire any prepared unsent tokens and render fresh ones on the next actual attempt.
- Give the admission request a delivery-time payload builder, or refactor these DB-only render/token helpers to run synchronously in the final dispatch hook. Do not pre-render tokens, then wait several minutes inside a raw transformer. Payload construction must finish after admission is available and before request-start evidence/raw I/O, without awaiting anything inside a SQLite transaction.
- Preserve plain-text/UTF-16 entity handling, queue links, disabled link preview, and all existing action guards.
- Keep distinct confirmation prefixes separate from replaceable view content so coalescing does not erase “alias saved”, “paused”, or publication outcome messages.

### 15.6 `/start`

Enqueue the dashboard response independently. Move `setMyCommands` into a separately deduplicated control intent. A control 429/failure must not prevent the dashboard response from existing or being delivered.

## 16. Response delivery state machine

Claim one due pending row with a fresh token/boot ID. No two worker cycles may own it.

Before dispatch:

1. Recheck outbox ownership, cancellation/coalescing, prompt generation, or incident eligibility.
2. Respect real cooldown and local pacing.
3. Render and create fresh callbacks only when an actual request can start.
4. Persist `request_started_at` and sending state immediately before raw send.

| Result | Outbox transition |
| --- | --- |
| Not dispatched due to local cooldown/priority | Pending at actual next eligible time; no false delivery acknowledgement. |
| Definitive actual 429 | Pending at shared deadline; no action replay. |
| Confirmed send with valid message ID | Sent; persist ID and atomically perform subject acknowledgement. |
| Definite permanent refusal/invalid payload | Failed and visible in health; retain safe error details. |
| Network/server failure where send may have succeeded | Uncertain; do not automatically resend as a safe rejection. |
| Shutdown before request initiation | Pending for restart. |
| Crash after request initiation without result | Uncertain on restart unless definitive evidence was recorded. |

For control jobs that produce no user-visible message, classify idempotency explicitly. `setMyCommands` can safely repeat an identical desired definition after transient uncertainty; this exception must not leak to `sendMessage` or publication.

Delivery acknowledgement transaction:

- Check the claim token still owns the row.
- Mark sent with real ID/time.
- For an alert, mark that exact alert fingerprint delivered only if still current.
- For an incident warning/recovery, acknowledge that exact incident/outbox pair.
- For a prompt, activate only the still-current generation.
- Do not mark a condition delivered merely because `enqueue()` returned successfully.

Do not delete unsent or uncertain responses during retention. A new user command may create a new response; the worker does not silently replay the old action to generate one.

## 17. Existing alert service integration

Convert alert sends into outbox intents while keeping unrelated severity/repeat policies intact.

- `raise` and `raiseOnChange` create/deduplicate durable intent; marking sent waits for actual delivery acknowledgement.
- `retryPendingOnChange` must not create duplicate outbox rows for the same alert fingerprint.
- On-change resolution with no delivered opening fingerprint updates condition state silently and cancels obsolete undelivered warning intent.
- Resolution after a delivered warning creates one durable resolution intent with its own dedupe key.
- If the condition recurs before a pending resolution is sent, cancel the obsolete resolution instead of delivering a false recovery.
- Keep item-specific uncertainty and renewal-age alerts separate from the shared flood incident.
- Replace `instanceof Error ? error.message : 'unknown'` logging at gateway boundaries with normalized error details using `safeErrorDescription`.

Do not implement a recursive “outbox failure alert” by immediately enqueueing another failing alert every cycle. Report outbox failures in structured logs and health; deduplicate any separately required operator notification.

## 18. Worker fairness, integration, and shutdown

### 18.1 Preparation fairness

- Keep bounded attempts/cleanups per cycle.
- A successful unchanged rendition must remove the item from pending work.
- A definite deferred item gets a future eligibility time; select other eligible preparation rather than repeatedly claiming the same item.
- Honor gate pacing; remove/reconcile old worker pacing that would accidentally charge the same messages twice.
- Preserve renewal capacity projections by using the admission policy's cost helper, or conservatively including its waits in the projection. Do not keep claiming a guaranteed 20 messages/minute renewal throughput if added global admission makes it slower.

### 18.2 Composition order in `src/application.ts`

Use this ordering:

1. Open database and apply additive migrations in the existing startup flow.
2. Acquire singleton ownership before starting any worker or remote mutation.
3. Construct repositories and shared clock/boot ID.
4. Recover queue/preparation operations using existing durable evidence.
5. Run version/protection reconciliation without clearing uncertain work.
6. Recover scheduled runs against all associated attempts.
7. Recover receipts, response claims, and pending prompt generations.
8. Construct admission, request context, and central cooldown/incident observers.
9. Install raw API transformers once; construct the raw gateway.
10. Construct response rendering/delivery and incident services with explicit cyclic dependencies resolved by injected callbacks, not module globals.
11. Validate startup Telegram identity/rights using existing retry policy.
12. Register authorized handlers that persist work and return.
13. Start supervised action, response, incident, scheduling, preparation, renewal, cleanup, retention, and heartbeat tasks.
14. Mark readiness/start polling according to the existing application contract.

Startup failures still need redacted logs and retained notification evidence; do not require a successfully running response worker in order to persist a critical startup alert.

### 18.3 Shutdown and lease loss

- Stop accepting new actions and admission claims.
- Stop polling so no new inbound state changes begin.
- Abort queued sleeps/admission waits that have not initiated requests.
- Drain already initiated requests through the operation tracker while SQLite remains open.
- Persist send/result/uncertainty acknowledgements before closing the database.
- Leave safe unsent outbox rows pending, possibly-sent rows uncertain, and scheduled work at its original deadline.
- Preserve existing shutdown grace, WAL checkpoint, runtime status, singleton release, and clean/unclean shutdown recording.
- Do not mark every worker completed merely because its promise was abandoned.

## 19. Health, telemetry, and retention

Extend `/health` and its underlying snapshot with:

- Real shared cooldown deadline and remaining time.
- Open flood incident ID, first failure, latest real failure, quiet-until, and warning/recovery delivery status.
- Pending retry occurrence, original deadline, next retry time, and latest outcome.
- Pending/sending/uncertain/failed response counts and oldest pending age.
- Frozen item counts, distinguishing actual admin edit from conservative legacy protection.
- Counts of protected-edit collisions needing review.

Use plain operator-facing language. Do not expose database column names or raw JSON to the normal admin flow unless needed for a review action.

Structured operational logs should include safe scalar fields:

```text
event, operationId, itemId, occurrenceAt, method, family,
errorKind, errorSource, retryAfterSeconds, retryAt, deadlineAt,
incidentId, responseId, attemptCount, requestStarted
```

`errorSource` must distinguish Telegram, local cooldown, pacing/admission, and transport uncertainty. Log no bot token, raw authorization header, full private message payload, or author identity unnecessarily.

Retention:

- Never purge pending/sending/uncertain outbox rows, open incidents, active receipts, or attempt evidence still needed to prevent resend.
- Purge terminal response/incident/receipt history using explicit existing-style retention windows after references are safe.
- Keep callback/prompt cleanup compatible with pending-delivery prompts.
- Purge generated-edit expectations only after they are matched/obsolete and unresolved operations no longer require their evidence.
- Preserve freeze on active items for their entire lifetime; it is not expiring notification state.

## 20. Regression test matrix

Use these as concrete test names/scenarios. Do not satisfy them by testing private helpers alone when the bug requires multiple actual callers.

### 20.1 Revision and preparation — `test/preparation.test.ts`, repository tests

1. Identifiable-user alias set BEFORE enqueue -> one preparation -> ready -> subsequent empty.
2. Exact hidden-sender alias set BEFORE enqueue -> same convergence.
3. No alias -> same visible fallback credit -> no extra refresh.
4. Alias equal to fallback name -> bookkeeping advances without another edit.
5. Alias removal -> fallback once, then empty.
6. Nickname changes while initial copy/edit held -> old result remains pending for exactly one latest refresh.
7. Nickname changes while refresh held -> newer wanted survives old completion.
8. Stale wanted zero/applied positive/current equal -> converges without another identical edit.
9. Stored wanted newer than applied -> does not become ready prematurely.
10. Service outcome reports actual stored state.
11. Unchanged text but changed entities/preview/caption-placement option is not incorrectly skipped.
12. No-op does not register or leave an expected edit.
13. Earliest deferred post does not starve another eligible preparation.
14. Username-fallback alias resolution obtains the name and actual revision from the same selected identity; a policy-identity change cannot compare unrelated revision numbers or falsely label text with a larger wanted revision.

### 20.2 Editorial protection — ingestion/domain/renewal/recovery tests

1. Body-only edit keeping generated suffix -> whole post frozen; later alias update makes no edit.
2. Caption-only and formatting-only edits -> same.
3. Separate credit edit -> all content/credit members frozen.
4. Edit one album member -> remaining members and credit frozen too.
5. Edit raw post before preparation -> adopt exactly as shown, no byline append.
6. Edit during initial 2-second buffer -> freeze persists through item creation.
7. Edit during album collection -> complete collection, then adopt frozen rendition.
8. Unmatched edit of provisional output -> not swallowed; freeze/collision evidence survives.
9. Obsolete-generation edit -> does not overwrite/freeze current source.
10. Removed-member edit -> does not resurrect content.
11. Frozen valid post publishes despite nickname revision mismatch.
12. Renewal preserves freeze and all visible content across new message IDs.
13. Restart and known-item recovery preserve freeze.
14. Retry, move-to-end, Apply preparation rules, and uncertainty resolution do not unfreeze.
15. Edit before actual dispatch, while admission held -> zero raw rewrite calls afterward.
16. Edit after actual request started -> review; preserve admin version/evidence; zero corrective rewrites.
17. Duplicate/stale edited updates remain idempotent.
18. A generated POST and unmatched admin EDIT coalesced into one sticky-`post` pending row preserve the edit before generic post suppression.

### 20.3 Expected edits — generated-event and adapter tests

1. Successful own echo does not freeze a post.
2. Echo before HTTP response is persisted provisionally and reconciled.
3. `message is not modified` retires only the exact edit expectation.
4. Definite 429 retires edit expectation; surviving output post expectations remain usable.
5. Admin custom edit followed by restoration to earlier bot text stores the restoration.
6. A superseded or expired fingerprint cannot suppress a new admin edit.
7. Lost response/ambiguous edit evidence does not trigger automatic rewrite.
8. Legacy expectations are handled conservatively at upgrade.
9. Real edit receipt validation preserves returned IDs/timestamps and rejects invalid IDs.

### 20.4 Schedule retry — scheduler + real publisher + real repositories

1. 07:00 occurrence -> definite 30-second 429 -> one success at 07:00:30.
2. 07:00 occurrence -> wait ending 07:05 or later -> zero retry requests.
3. Admission released at 07:04:59.999 permits initiation; at 07:05:00.000 forbids it.
4. Repeated real 429s never extend 07:05 deadline.
5. Restart at 07:02 preserves due retry and original deadline.
6. Restart after 07:05 expires it without sending.
7. Discovery cursor already advanced -> saved pending retry still runs.
8. Pause then resume -> old retry stays cancelled.
9. Slot removal/recreation -> old retry stays cancelled.
10. Confirmed manual publication with cleanup pending cancels scheduled retry.
11. Failed manual publication does not pretend to be a success.
12. Partial/ambiguous destination output is never automatically retried.
13. Destination complete/source cleanup failed -> only cleanup retries.
14. Multiple definite candidate failures within one pass preserve all attempt links.
15. Crash after queue claim but before request initiation -> safe original-window recovery.
16. Crash after request-start evidence with no result -> uncertainty, zero resend.
17. Crash after output recorded but before schedule completion -> published on recovery.
18. Two concurrent scans claim only one occurrence attempt.
19. Newer dense slot supersedes older unsent retry; no catch-up burst.
20. Empty occurrence remains empty after a later submission arrives.
21. Wall clock moves forward beyond deadline -> expire; no extended window.
22. Hold manual raw success before higher-level outcome persistence while a scheduled request is queued: the scheduled request cannot dispatch before cancellation is committed under the shared publication coordinator.
23. Startup ordinary operation recovery overwrites phase, but independent request evidence still distinguishes never-started from possibly-sent work.

### 20.5 Admission and incidents

1. Two workers targeting one chat share pacing; plural message cost is counted.
2. Foreground response/publication can precede queued background work.
3. Reads and callback acknowledgement remain available during cooldown.
4. Real raw 429 persists wait and records ONE failure observation.
5. Ten local cooldown rejections do not move last-real-failure/quiet-until.
6. Deadline/protection/abort guard fails after pacing wait -> zero raw request.
7. Multi-step operation waits for proactive pacing without artificial uncertainty.
8. Short wait plus relevant success remains silent, including its stable-observation period.
9. Repeated active waits past five minutes create one opening warning intent.
10. Warning blocked until recovery -> cancelled if never delivered; no orphan recovery.
11. Delivered warning -> exactly one recovery after agreed stable evidence.
12. Read-only/notification success cannot prove queue recovery.
13. One publication while another real wait occurs does not broadly resolve shared issues.
14. New real wait cancels pending unsent recovery and retains incident identity.
15. Restart preserves first failure, quiet timer, actual delivery markers, and dedupe.
16. Stable recovery queued -> new real failure cancels it -> stable again: re-arm the same definitely-unsent intent, deliver exactly once, and never violate its unique dedupe key.

### 20.6 Admin delivery, prompts, and actions

1. Command during cooldown persists response and returns before advancing the clock.
2. A second command/queue edit is processed while the first response waits.
3. Restart delivers safe pending response without rerunning its action.
4. Duplicate update ID does not repeat alias/schedule mutation.
5. Duplicate callback update does not repeat manual publication/deletion/recovery.
6. Remote action crash reconciles a bound operation instead of starting another.
7. Latest queue/health/dashboard view supersedes obsolete unsent view.
8. Distinct confirmations survive view coalescing.
9. Callback token lifetime starts at actual dispatch, not original enqueue.
10. A deferred dispatch discards unsent old tokens before creating new ones.
11. ForceReply prompt activates only with real message ID after delivery.
12. Pending prompt rejects arbitrary text; `/cancel` cancels its unsent generation.
13. Replacement prompt cannot be reactivated by delayed older delivery.
14. `/start` dashboard remains queued when `setMyCommands` fails.
15. Definite response 429 retries only delivery.
16. Ambiguous `sendMessage` delivery becomes uncertain; no blind resend/action replay.
17. Unauthorized user/group update creates no configured-admin receipt, response, token, or mutation.
18. Recovery preview forwards are not accidentally routed through the reply outbox.
19. Failed/uncertain response visible in health and not purged.
20. Lease loss/shutdown stops new dispatches and preserves pending/uncertain claims safely.
21. A prompt delayed beyond its original enqueue time plus 15 minutes remains pending, is not purged, and receives a fresh full TTL only when actually delivered.

## 21. Verification commands and scope

Run focused groups as their changes become available, for example:

```sh
bun test test/migration.test.ts test/repository.test.ts test/preparation-repository.test.ts
bun test test/preparation.test.ts test/ingestion.test.ts test/generated-event-repository.test.ts
bun test test/scheduler.test.ts test/publisher.test.ts test/publication-adapter.test.ts
bun test test/telegram-cooldown.test.ts test/admin.test.ts test/operations.test.ts
bun test test/application.test.ts test/shutdown.test.ts test/health.test.ts
bun run typecheck
```

Add explicit tests for every new repository/service module. Then run the repository's required complete command:

```sh
bun run check:all
```

At plan baseline, this includes typecheck, full tests, coverage gate, and fake-root deployment tests. Do not change coverage thresholds or exclude new executable modules to make the gate pass. The coverage inventory includes executable TypeScript across `src`; new services/repositories need meaningful coverage.

The baseline exact migration-version assertion was 5. It now expects the actual latest version, 11; old upgrade-fixture coverage remains in place.

Search for old assumptions after implementation:

```sh
rg -n 'shared_issue:flood_wait|onSharedRecovery|The shared Telegram flood wait ended' src test
rg -n 'ctx\.reply|setMyCommands|beginPrompt' src/handlers/admin.ts
rg -n 'nickname_revision_applied|nickname_revision_wanted|refresh_pending' src
rg -n 'expectEdit|obsoleteForOperation|preparationOutputOperation|generated\.consume' src
rg -n 'editorial_frozen|editorialFrozen' src test
git diff --check
```

Classify each remaining match; do not mechanically delete unrelated behavior. No authorized private-admin reply path may bypass retained delivery accidentally. No old broad flood recovery path may remain active alongside the incident service.

## 22. Documentation, diagnostics, and completion

After all checks pass:

1. Update `README.md` behavior descriptions for frozen posts, safe five-minute retries, grouped incidents, and retained replies.
2. Update `docs/queue-preparation.md` and obsolete old contradictory preparation-plan passages or point clearly to the new authority.
3. Update `docs/deployment.md` with migration/backfill consequences and observational verification, using placeholders/redacted examples rather than credentials.
4. Update the investigation with the actual implementation commit, regression commands/results, and remaining limitations. Preserve the historical evidence as historical, not current live status.
5. Replace/remove frozen defect-asserting diagnostic scripts once equivalent corrected-behavior tests cover their seams. Do not leave an ordinary diagnostic command requiring the old defects without prominently marking it as an archival reproduction.
6. Remove temporary debug instrumentation; retain only intentional structured operational events.
7. Summarize the conservative legacy freeze default explicitly: protected existing prepared posts keep their visible credits and no longer auto-refresh nicknames.

Completion checklist:

- [x] Original existing-alias enqueue regression is green at the real ingestion/preparation seam.
- [x] Known loop rows converge; no hardcoded item-specific repair exists.
- [x] Admin edits freeze whole logical posts, including buffered/provisional edits.
- [x] Stale generated-edit expectations cannot swallow manual restoration.
- [x] Frozen valid posts still publish/renew unchanged and survive restart.
- [x] Scheduled retries obey original deadlines, cancellation, atomic attempt association, and uncertainty evidence.
- [x] Command middleware never waits for flood expiry to return.
- [x] Retained responses/prompts/confirmations survive restart without repeating effects.
- [x] Shared incidents have actual-delivery-aware warning/recovery transitions.
- [x] Local deferrals do not become real Telegram incidents.
- [x] No source cleanup failure can resend confirmed publication.
- [x] Health and retention understand every new durable state.
- [x] Shutdown/lease-loss/crash tests cover request initiation boundaries.
- [x] Full `bun run check:all` passes with unchanged required thresholds.
- [x] Final diff contains no credentials, production data, or unrelated user changes.

The implementation task is complete only when the agreed behavior and all relevant failure/restart paths are implemented and verified. Writing a plan, adding schema, silencing the recovery text, or fixing only item #86 is not completion.

## 23. Execution boundary

When asked to implement this plan, perform the local code changes and verification to completion. Do not reopen settled interview questions. If code has changed since the baseline, inspect the differences and adapt names/positions without reducing these guarantees.

Production investigation access from the earlier task is not permission to deploy code, change the live database, pause scheduling, or send Telegram probes. This document does not request any such action. Keep production unchanged during local implementation unless the user explicitly includes rollout in the task.
