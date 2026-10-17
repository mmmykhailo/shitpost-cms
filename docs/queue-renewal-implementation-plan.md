# Implementation plan: reliable queue renewal, current-source links, and readable ages

## 1. Handoff and authority

This is a detailed implementation handoff for another coding agent. The planning agent has changed documentation only. Implement the behavior described here; do not restart the product interview or assume that the existing code already meets these requirements.

Repository: `/Users/mykhailo/Work/shitpost-cms`.

Planning baseline: commit `6effd8562f6344df1f8f33ed55b8268717152b5f`, inspected on 2026-10-15. Line numbers below describe that baseline; use the named functions as the durable navigation points if lines move.

Read these documents first:

1. `GLOSSARY.md` — canonical language, especially queue age versus source age.
2. `docs/queue-renewal.md` — the user's accepted requirements and failure policy.
3. `docs/adr/0001-preserve-queue-identity-during-renewal.md`.
4. `docs/adr/0002-require-complete-renewal-before-source-deletion.md`.
5. This plan, in full, before changing the renewal state machine.

The user explicitly requested this handoff so a cheaper agent can implement it. Do not launch an implementation from the planning chat, deploy, post to live Telegram channels, or modify a production database merely to validate this document. The implementing agent should work in its assigned checkout and respect any newer repository instructions and user changes.

The product decisions are settled. Specific new filenames, internal interfaces, pacing constants, and retry defaults in this plan are implementation recommendations chosen to make the handoff concrete. Equivalent simpler implementations are acceptable if they preserve every invariant and pass the behavioral checks. Do not treat these internal recommendations as additional requirements the user must approve.

### 1.1 Baseline validation already performed

The planning agent ran:

```sh
bun run typecheck
bun test test/renewal.test.ts test/operations.test.ts test/admin.test.ts test/application.test.ts test/health.test.ts
```

Results: typecheck passed; **53 tests passed, 0 failed, 226 assertions** across those five test files. These are existing tests, not proof that the requested fix works. No new regression tests or application changes have been written by the planning agent. The full suite and coverage gate were not run during planning.

At handoff, the glossary, design notes, ADRs, and this plan may be untracked. Preserve them. Do not overwrite the historical root `IMPLEMENTATION_PLAN.md`; it describes the earlier whole-project implementation, not this change.

## 2. Exact intended behavior

### 2.1 Renewal

- A queue item is a logical post, with a stable number, publishing position, and initial enqueue time.
- A source is the current Telegram message or full set of album messages representing that item in the queue channel.
- At source age **36 hours**, the item becomes eligible for renewal.
- Repost into the **same queue channel** using the existing origin-preserving copy/forward strategy.
- Record all replacement IDs durably and confirm a complete replacement before making it current.
- Only then attempt to delete the old source messages.
- Preserve item ID, logical FIFO sequence, initial enqueue timestamp, logical publication status, content, origin/attribution, and album membership/order.
- Reset source age to the new source's creation time. Do not reset queue age.
- Physical messages move to the bottom of Telegram channel history. Logical publishing order does not move.
- Renewals continue while scheduled publishing is paused.
- Drain due work promptly. Do not renew one item and then sleep 15 minutes while another item is already due.
- Renew oldest physical sources first. One definitely failing item must yield to other due items.

### 2.2 Failure policy

| Situation | Required behavior |
| --- | --- |
| Definite renewal rejection, such as lost rights or protected content | Preserve logical state and current originals; give this item a future maintenance retry deadline; continue other eligible items. |
| Telegram flood limit | Honor the complete `retry_after`; do not cap a long Telegram wait to five minutes. Respect a shared outbound cooldown when the limit's scope is global or unknown. |
| Request might have succeeded but response was lost | Keep originals, record uncertainty, require explicit admin resolution, and do not blindly resend. Other eligible items can still be renewed. |
| Confirmed partial album result | Keep surviving originals and the logical item; retain known replacement evidence; require review. Do not adopt the partial album and do not delete originals. |
| Complete replacement succeeds; old deletion fails | Keep the replacement current and usable. Track old IDs as orphaned sources for cleanup. |
| Source already older than 48 hours after downtime | Still attempt replacement. If old deletion is impossible, retain a fresh usable replacement and alert for manual cleanup. |
| Current source is definitively absent before any replacement | Preserve the existing source-missing behavior unless evidence is only a short bulk result. A short result does not prove which album members are missing. |

### 2.3 Queue links

- A queue row's **existing stable item number** becomes a text link: `#29`.
- It opens the current source in the queue channel, not the destination channel, original forwarded channel, historical source, or original enqueue message.
- An album links to its first current member.
- Each newly generated listing reads current source IDs.
- Old listings are snapshots. After renewal, an old link may reference a deleted message; reopening `/queue` obtains current links. Do not build live link redirection or edit every historical admin menu.
- Keep existing pagination and callback buttons working.

### 2.4 Readable age

The user approved one unit at a time, with **at most two decimal places**, trailing zeros removed:

```text
#29 · video · queued · age 2.87 days
```

`#29` is linked. Age means total elapsed time since initial enqueueing, including all renewals.

Use the same age formatter for the dashboard's logical head age and, for consistency, the health view's physical source age. Preserve labels so users can distinguish the two meanings. Keep stored timestamps, service snapshots, and calculations numeric.

| Elapsed time | Unit |
| --- | --- |
| Less than 60 seconds | seconds |
| At least 60 seconds and less than 60 minutes | minutes |
| At least 60 minutes and less than 24 hours | hours |
| At least 24 hours and less than 30 days | days |
| At least 30 days | months, using an approximate 30-day month |

Do not add weeks, years, mixed units, locale-dependent commas, `ago`, or milliseconds to these age fields.

## 3. Important findings: fix the actual paths

### 3.1 Renewal already exists

Do not implement a second queue or a parallel renewal system. Extend the existing services and repository guards.

`src/application.ts` currently defines:

```ts
const RENEWAL_INTERVAL_MS = 15 * 60_000;
const RENEWAL_START_AGE_MS = 36 * 60 * 60_000;
```

Its `startBackgroundWork()` renewal task, around line 278, retries installed-generation cleanup, calls `renewal.renewNext(...)` once, and sleeps for 15 minutes. That limits the worker to four items per hour. A cohort of 100 simultaneously due items can take nearly 25 hours to process despite a 12-hour safety margin.

`src/services/renewal.ts` already copies originless posts, forwards posts with semantic origins, persists replacement IDs, installs a new generation, and then attempts old deletion.

### 3.2 The UI age is not a renewal timestamp

`src/handlers/admin.ts::sendQueue`, around line 165, formats `now - item.enqueuedAt` in milliseconds. `dashboardText`, around line 64, does the same for the head. A value above two days is expected for a long-waiting item even when source renewal worked.

Do not change age semantics to make the displayed number look younger. Fix the worker independently of this presentation change.

### 3.3 Permanent failures can monopolize selection

`src/db/repositories.ts::claimRenewal`, around line 326, selects the oldest eligible physical source with idle maintenance status and an expired/absent maintenance retry deadline.

`failRenewal`, around line 364, returns maintenance to idle without setting a retry deadline. The same oldest failing item can be selected on every iteration, starving everything behind it. A naive drain-until-empty loop would turn this into a tight infinite failure loop.

Fix this before enabling draining.

### 3.4 Partial results currently have a destructive path

`src/services/renewal.ts::renewClaimed` checks `replacementIds.length !== oldSourceIds.length`. Its current short-result branch deletes known replacements, infers missing originals using an array slice, attempts to delete some old IDs, and marks the whole logical item missing.

This contradicts the accepted behavior. Telegram can skip an arbitrary uncopyable/unforwardable member, so a short output array is not an index mapping identifying which old member was skipped.

Replace that branch. Do not preserve the old deletion behavior just because an existing test permits it.

### 3.5 `firstMessageId` is historical

`installRenewedGeneration` does not update `queue_items.first_message_id`. Use `queue.currentSourceIds(item.id)[0]` for links. Never change `firstMessageId` merely to make the UI link work.

### 3.6 Capacity reporting assumes a different speed

`src/services/capacity.ts::calculateRenewalCapacity` currently assumes 20 messages/minute but rounds each item up to at least a full minute. Neither behavior matches a worker doing one item every 15 minutes.

`src/services/health.ts::snapshot` also takes the maximum maintenance retry deadline across idle items and treats it as a queue-wide delay. After isolating per-item failures, that would incorrectly project unrelated healthy items as blocked.

Align scheduling inputs and the projection with the actual worker policy.

### 3.7 Rate-limit handling has more than one path

- Renewal currently caps `retry_after` to 300,000 ms.
- `src/services/publisher.ts::retryAtFor` has the same cap.
- Orphan cleanup currently calculates local exponential backoff without incorporating a Telegram flood wait.
- Admin handlers often use `ctx.reply()` and `ctx.api` directly, bypassing `TelegramGateway`.

A cooldown placed only inside one renewal item does not implement a bot-wide outbound wait. Cover the shared outbound path and avoid automatic retries of ambiguous sends.

### 3.8 Recovery and generated-update suppression are load-bearing

Read these before changing operation phases:

- `src/db/repositories.ts::recordReplacementOutput`, `markReplacementOutputsRecorded`, `installRenewedGeneration`, `recoverExpiredOperations`, `setRenewalUncertain`, `completeRenewalWithOrphans`, `adoptUncertainRenewalGeneration`, `resolveUncertainRenewal`.
- `src/services/ingestion.ts::finalizePendingUpdates`.
- `src/db/pending-update-repository.ts`.

Telegram may deliver a replacement's `channel_post` update before the send response reaches the bot. Existing generated-message evidence and quarantining prevent those messages from becoming new logical queue items. Retain that protection.

## 4. Implementation map

Names marked **new** are recommended names, not existing files.

| File | Change |
| --- | --- |
| `src/domain/age.ts` **new** | Pure one-unit age formatter. |
| `src/domain/telegram-message-link.ts` **new** | Validated private channel-message URL builder. |
| `src/domain/renewal-policy.ts` **new** | Shared renewal threshold, idle scan, pacing and per-item retry policy. |
| `src/services/renewal.ts` | Safe partial results; definite failure yielding; full rate delay; expose attempt details for the worker. |
| `src/services/renewal-worker.ts` **new** | Testable, sequential draining loop with pacing, abort, and bounded cycles. |
| `src/db/repositories.ts` | Reuse maintenance retry persistence; add narrowly scoped work/projection queries if needed. Preserve existing guards and phases. |
| `src/db/telegram-cooldown-repository.ts` **new** | Persist a shared outbound cooldown using the existing settings table. |
| `src/telegram-cooldown.ts` **new** | Shared cooldown policy and grammY transformer; no automatic resend. |
| `src/application.ts` | Compose the cooldown and renewal worker; replace the inline one-at-a-time loop. |
| `src/services/publisher.ts` | Remove the five-minute truncation of a Telegram flood wait. Preserve publication semantics. |
| `src/services/orphan-cleanup.ts` | Honor `retry_after`; stop sending more cleanup requests during a shared cooldown. |
| `src/services/capacity.ts` | Project the same pacing, eligibility, and per-item retry deadlines as the worker. |
| `src/services/health.ts` | Supply accurate per-source projection data and shared cooldown. |
| `src/handlers/admin.ts` | Text-link entities, readable ages, honest partial-renewal resolution wording. |
| `test/age.test.ts` **new** | Formatting examples and boundaries. |
| `test/telegram-message-link.test.ts` **new** | Channel ID conversion and invalid input behavior. |
| `test/renewal-worker.test.ts` **new** | Actual worker behavior using real SQLite repositories and controllable clocks. |
| `test/telegram-cooldown.test.ts` **new** | Shared, durable, non-retrying outbound cooldown. |
| Existing renewal/admin/operations/health/application/ingestion/repository tests | Add integration assertions and update intentionally changed behavior. |
| `README.md`, `docs/telegram-compatibility.md`, `docs/queue-renewal.md` | Explain final behavior and record what was actually verified. |

No new runtime dependency is necessary. Do not upgrade Bun, grammY, TypeScript, or the lockfile for this task.

## 5. Step A: implement and test presentation helpers

This is independent of renewal changes and is a useful first small slice.

### 5.1 `formatAge(milliseconds: number): string`

Recommended export from `src/domain/age.ts`.

Algorithm:

1. Validate a finite number. Use `RangeError` for `NaN` and infinities; timestamps reaching this formatter should already be valid.
2. Clamp negative finite durations to zero, matching existing UI behavior for small clock skew.
3. Choose the largest unit whose threshold the unrounded duration reaches, using the table in section 2.4.
4. Divide by that unit's duration.
5. Round to at most two fractional digits. A simple fixed-two-decimal conversion followed by numeric conversion/stringification trims zeros without locale behavior.
6. If rounding yields the next unit's boundary, promote and recompute in the next unit. This avoids `60 seconds`, `60 minutes`, `24 hours`, or `30 days` right before the natural boundary.
7. Use singular when the displayed numeric value is exactly 1; otherwise plural.
8. Return the value, one space, and the word for the unit.

Boundary promotion is an implementation default for readability, not a change to the accepted unit thresholds. Tests must make it deterministic.

Examples:

| Input | Expected text |
| --- | --- |
| `0` | `0 seconds` |
| `-1` | `0 seconds` |
| `1_000` | `1 second` |
| `1_234` | `1.23 seconds` |
| `45_000` | `45 seconds` |
| `59_999` | `1 minute` after rounding/promotion |
| `60_000` | `1 minute` |
| `90_000` | `1.5 minutes` |
| `3_599_999` | `1 hour` after rounding/promotion |
| `3_600_000` | `1 hour` |
| `12_600_000` | `3.5 hours` |
| `86_400_000` | `1 day` |
| `247_668_018` | `2.87 days` |
| `30 * 86_400_000` | `1 month` |
| `36 * 86_400_000` | `1.2 months` |
| `365 * 86_400_000` | `12.17 months` |

Do not reset `enqueuedAt`, round stored timestamps, or put formatting inside repositories or the health service.

### 5.2 `buildQueueMessageLink(chatId, messageId): string | undefined`

Use the private-channel URL form, so no username lookup or new configuration is required:

```text
chatId = -1001234567890
messageId = 901
URL = https://t.me/c/1234567890/901
```

Requirements:

- Both IDs must be safe integers.
- Message ID must be positive.
- For this channel-only app, require a valid negative Bot API channel ID in the `-100…` range. Convert to the positive MTProto channel ID by the documented `-chatId - 1_000_000_000_000` mapping, and require a positive result. Avoid a generic string replacement that could accidentally accept an unrelated group ID.
- Invalid/non-channel IDs return `undefined`; the admin row remains plain text rather than crashing or linking somewhere incorrect. This supports existing simplified test fixtures such as `-100` without pretending they are real private-channel URLs.
- The URL path contains only validated numeric components. Do not include `?single` for an album; normal Telegram album navigation is desired.
- Do not use `item.id` as Telegram's message ID.

### 5.3 Render links with Telegram entities, not global parse mode

Prefer keeping the existing plain-text row and adding `text_link` entities for its item-number substring:

```ts
{ type: "text_link", offset: labelOffset, length: label.length, url }
```

Use `ctx.reply(text, { entities, link_preview_options: { is_disabled: true }, reply_markup: ... })` for queue listings. JavaScript string length measures UTF-16 code units, which is what Telegram entity offsets require.

Implementation notes:

1. Capture `const now = deps.now()` once per render.
2. Build the header and any uncertainty warning before computing row offsets. The current `lines.splice(...)` warning insertion must not invalidate offsets calculated earlier.
3. Build each row and record its label offset as text is appended, including preceding newlines.
4. Use `deps.queue.currentSourceIds(item.id)[0]` for the target.
5. If no current ID/link is available, show the existing `#id` without an entity. Do not guess a historical target.
6. Preserve maintenance-status text, ten-item pagination, next/previous buttons, and existing versioned action tokens.
7. Format queue age with `formatAge(Math.max(0, now - item.enqueuedAt))`.
8. Update `dashboardText` head age with the same formatter. Linking dashboard IDs is optional; queue rows are the requested link surface.
9. Replace `sendHealth`'s manually floored `…h` age with the formatter while retaining the explicit physical-source label.

Do not set a global HTML or Markdown parse mode: other admin text includes user-controlled names, errors, and aliases that are currently safe as plain text.

## 6. Step B: make individual renewal attempts safe before draining

### 6.1 Preserve the successful operation sequence

Keep this order and its existing durable phases:

```text
claimRenewal
  -> replacement_pending
  -> copyMessages/forwardMessages to queue channel
  -> recordReplacementOutput for every known valid ID
  -> verify exact complete result
  -> markReplacementOutputsRecorded
  -> installRenewedGeneration
  -> old_source_cleanup_pending
  -> attempt old deletion
  -> completeRenewalWithOrphans
```

Use the existing `OperationGuard` with operation ID, captured content version, and captured source generation. Do not remove compare-and-swap checks or make network calls inside SQLite transactions.

Retain `disableNotification: true` on renewal transfers. Retain originless-copy versus semantic-origin-forward behavior. Do not re-run publication byline construction during renewal or append another byline.

### 6.2 Definite failures must set a future maintenance retry

Use the existing renewal branch of `queue.setRetry(...)`, which stores `maintenance_retry_not_before`, returns maintenance to idle, and marks the operation failed. It preserves logical publication status and avoids reusing publication's `retry_not_before` field.

Recommended first implementation: a fixed **60-second per-item delay** for definite non-flood failures. This is sufficient to prevent starvation without adding a new retry counter or migration. More elaborate exponential backoff is unnecessary for this change.

Important details:

- Do not base new backoff on `item.attempts`: that counter also includes publications and renewals, not just consecutive maintenance failures.
- Either change `failRenewal` to require/persist a retry timestamp or stop calling it from this path and use `setRetry`. Do not leave a production path that immediately reselects the same permanent failure.
- Keep the logical status unchanged: a `needs_edit` item stays `needs_edit`, and a `blocked` item stays `blocked` while its source can still be maintained.
- Do not alter the publisher's FIFO behavior. Continuing maintenance for later items does not authorize publishing past a blocked head.
- Continue to classify an authoritative missing-source error with the existing missing-source behavior. Never infer that error solely from a shorter bulk array.

### 6.3 Replace the partial-album branch

For any result whose count differs from the captured source count:

1. Persist known valid replacement IDs using the existing output-evidence method.
2. Do not call `installRenewedGeneration` or `markReplacementOutputsRecorded`.
3. Do not call `markMissing` because of count mismatch.
4. Do not delete any original source ID.
5. Keep known replacement messages as evidence for admin review; do not automatically clean them up in this branch. This avoids another destructive/ambiguous request during the incomplete operation.
6. Call `setRenewalUncertain` with a distinct code such as `partial_replacement`, including expected and observed counts in the error description.
7. Return an uncertain outcome. The existing review UI is the resolution entry point.

This deliberately uses `uncertain_renewal` for a known incomplete replacement because that maintenance state already means explicit resolution is required. Do not add a second overlapping partial-renewal state.

For malformed IDs, preserve the existing ambiguous-output classification. Never adopt duplicate, zero, negative, non-integer, or out-of-order IDs as a complete generation. Use `validateOrderedMessageIds` before installation; keep every valid piece of durable evidence that was safely recorded, and do not destroy source content on validation failure.

### 6.4 Review menu must support this state honestly

Inspect the `case "renewal_uncertain"` menu builder in `src/handlers/admin.ts::handleCallback` (around line 533) and its existing callback handlers:

- The review should show expected source count and known replacement IDs/count, including `partial_replacement` when applicable.
- Do not offer to adopt known IDs as a complete album when the count is short.
- Entering a manually verified complete replacement set remains supported by the existing exact-count adoption path.
- Keep ownership and ordinal checks when entering that set. If known partial-output evidence cannot be reconciled with the entered complete IDs, reject adoption with an actionable message and direct the admin to explicit cleanup/resolution first. Do not erase contradictory output evidence or force-install a different album merely to make exact-count adoption succeed.
- The admin may explicitly delete known partial replacements and retry using the existing cleanup action. Automatic cleanup is what this plan forbids; explicit reviewed cleanup remains valid.
- A button currently saying `I confirm no replacements exist` is valid only when no replacements are known. Keep that restriction.
- Preserve callback version, operation, phase, and generation checks so an old review menu cannot mutate a newer renewal.
- Do not let a generic retry button bypass unresolved replacement evidence.

### 6.5 Post-install cleanup remains independent

Keep `completeRenewalWithOrphans` semantics: the replacement stays current even if old deletion fails. Continue retaining each old message ID for independent cleanup, with age-limit failures marked terminal and permission failures delayed.

Do not roll back a successfully installed source to old IDs because deletion failed. Do not mark the logical item externally deleted because only the old generation is absent. A missing old source during deletion is successful cleanup.

## 7. Step C: shared outbound cooldown without blind resends

The drain loop must not turn flood limits into rapid retries by different items or different workers.

### 7.1 Persistent state

Recommended minimal storage: use the existing `settings` table for one system-owned key, `telegram_mutation_not_before`.

Add a small repository exposing:

```ts
readNotBefore(): number
extendNotBefore(deadlineMs: number, now: number): number
```

- Store a finite safe-integer Unix timestamp in milliseconds as JSON, using the table's existing schema-version default.
- Missing key means zero.
- `extendNotBefore` must take the maximum of existing and proposed deadlines inside one transaction. A shorter later flood response must not shorten a longer active wait.
- `updated_by_admin_id` is null/omitted for this runtime-owned setting.
- Do not change `schedule_enabled` or reset any settings on restart.
- A malformed existing value should be surfaced as an internal state error, not silently treated as permission to send. Generated values should always be valid.
- This approach needs no schema migration. If a materially different design needs a migration, append one and add upgrade tests; never edit historical migration statements.

### 7.2 Production integration

Recommended implementation: a grammY API transformer installed on `bot.api` before startup API checks and polling. This covers gateway mutations and direct admin `ctx.reply()`/`ctx.api` calls through the same API object.

The installed local type definitions are in `node_modules/grammy/out/core/client.d.ts`:

```ts
(prev, method, payload, signal) => Promise<ApiResponse<...>>
```

Important: grammY transformers see the raw `{ ok: false, error_code, parameters }` response as well as transport exceptions. A catch-only implementation will miss normal Telegram 429 responses.

Recommended transformer policy:

1. Gate outbound mutation methods used by this app: `sendMessage`, `forwardMessage`, `forwardMessages`, `copyMessages`, `editMessageText`, `editMessageCaption`, `deleteMessage`, `deleteMessages`, `setMyCommands`, and other mutation methods actually introduced by this implementation.
2. Leave update polling and read-only identity/chat/rights checks operational. Do not hold a `getUpdates` request behind a long mutation wait, which could create a separate ingestion outage. Callback acknowledgement may also remain available as a control response; document this method policy in the module.
3. Before a gated mutation, read the shared deadline. If still in cooldown, return a synthetic raw 429 with the ceiling of remaining seconds **without calling `prev`**. This is a definite local refusal; nothing was sent.
4. Otherwise call `prev` exactly once. Never automatically resend the operation inside the transformer.
5. If Telegram returns a real flood response, extend the shared deadline to at least `responseTime + retry_after * 1000`. Use 60 seconds only when Telegram provides no usable delay.
6. Re-emit the original response so existing gateway classification and service state transitions still run.
7. If a thrown error carries a normalized/raw 429, also extend the deadline before rethrowing. Do not turn network errors into definite flood failures.
8. A long `retry_after`, such as 1,800 seconds, must stay 1,800 seconds or longer. Never shorten it to 300 seconds.

The shared mutation cooldown is a conservative application policy when Telegram does not identify the rate-limit scope. It is not a claim that every Telegram flood response is universally bot-wide. Already in-flight requests cannot be unsent; stop subsequent mutations once a wait is known.

The transformer should refuse early instead of sleeping while holding an item's claimed operation. The renewal worker sleeps before claiming the next item. This keeps operation leases and shutdown handling manageable.

### 7.3 Service-layer handling and injected gateways

- Renewal must persist an item's retry deadline using the full reported delay. It must also extend/check the shared controller when using an injected fake gateway that does not traverse the production transformer; keep this dependency explicit and testable.
- Publication's `retryAtFor` must stop truncating Telegram's delay. A definite 429 before sending is retryable; an ambiguous transport failure is still uncertain.
- Orphan cleanup must schedule its next attempt no earlier than Telegram's deadline and stop issuing further cleanup mutations during the shared wait. Use `max(localBackoff, TelegramDeadline)` if both apply.
- Keep all existing ambiguous publication and preview handling. Do not add an auto-retry library that repeats sends behind the services' evidence tracking.
- Unit tests can inject the same cooldown controller/repository into services and worker. Production should still construct exactly one shared controller for the bot.
- A restart must retain the outbound cooldown even though in-memory pacing counters can restart. Do not make startup fail just because an existing mutation cooldown prevents sending an alert; read-only startup rights checks remain available.

## 8. Step D: extract a testable renewal worker and drain due work

### 8.1 Shared policy constants

Recommended exports from `src/domain/renewal-policy.ts`:

```ts
RENEWAL_START_AGE_MS = 36 * 60 * 60_000
RENEWAL_IDLE_SCAN_MS = 60_000
RENEWAL_ITEM_RETRY_MS = 60_000
RENEWAL_MESSAGES_PER_MINUTE = 20
RENEWAL_MAX_ATTEMPTS_PER_CYCLE = 100
RENEWAL_MAX_CLEANUPS_PER_CYCLE = 10
```

Expose a pure helper:

```ts
renewalPacingCostMs(memberCount: number): number
// ceil(max(1, memberCount) * 60_000 / RENEWAL_MESSAGES_PER_MINUTE)
```

Validate member counts. Twenty outgoing renewal messages per minute is a conservative local pacing default inherited from the existing capacity model, not a guaranteed Telegram allowance. Actual Telegram flood responses override it.

Count album members, not only logical items. Avoid full-minute rounding for every singleton. No additional user environment variables are necessary.

### 8.2 Attempt details without breaking existing callers

The worker needs to know how many source members were involved in the actual claimed attempt so it can pace safely. Keep existing `renewNext(minimumAgeMs)` behavior available for current tests/callers.

One concrete option is to add:

```ts
renewNextAttempt(minimumAgeMs): Promise<{
  outcome: RenewalOutcome;
  sourceCount: number;
}>
```

- Share the same claim-and-execute implementation with `renewNext`; do not perform a second claim or send.
- For `nothing_due`, return zero members.
- For a claimed attempt, count the captured generation's real messages, not the oldest item observed before awaiting another operation.
- Retain operation tracking around every actual renewal and installed-source cleanup.
- If a simpler compatible metadata extension is used instead, update every exhaustive outcome switch and relevant tests.

### 8.3 Worker interface

Recommended `createRenewalWorker` dependencies:

- `queue`, existing `renewal` service, shared cooldown controller;
- injected `Clock` and `Logger`;
- existing runtime supervisor's `AbortSignal`;
- policy defaults overridable in tests only where useful.

Expose both:

```ts
runCycle(signal): Promise<CycleResult>
run(signal): Promise<void>
```

`runCycle` is the deterministic test seam used by the actual production loop. `run` must call it; do not build a test-only imitation of the worker.

Useful `CycleResult` fields: attempts, renewed count, uncertain count, failed/retry count, whether the attempt budget was exhausted, and the next legal wake time. Keep telemetry small; do not persist a second queue state machine in this object.

### 8.4 Loop behavior

Implement sequentially. Do not `Promise.all` renewal sends or renew multiple generations of the same item concurrently.

1. Check abort before starting the cycle and before every new operation.
2. If the shared mutation cooldown is active, return its deadline without claiming anything.
3. Resume a bounded number of already-installed-generation cleanups. These must only delete old IDs; they must not resend the replacement. Check abort/cooldown between them.
4. Attempt the next eligible renewal using the real repository selector: physical age at least 36 hours, maintenance idle, maintenance retry deadline reached, and existing logical-status exclusions.
5. If nothing is due, end the cycle.
6. For an actual attempt, reserve a delay of at least `renewalPacingCostMs(sourceCount)` before the next renewal attempt. A conservative implementation starts that delay after the previous attempt completes. This also paces definite failures and avoids hot-looping on external errors.
7. On a definite per-item failure, its persisted future retry deadline excludes it; continue selecting other due items after pacing.
8. On uncertainty, the uncertain maintenance state excludes that item; continue other eligible items after pacing. Do not globally stop because one item requires review.
9. On a flood response, stop the cycle and return the shared wait deadline. Do not keep selecting fresh items to provoke the same refusal.
10. Stop after 100 attempts in a cycle, but if the budget was exhausted, resume promptly after the outstanding pacing delay. **Do not add the idle scan delay between nonempty batches.**
11. When there is genuinely no eligible work, sleep until the earliest of the next relevant renewal eligibility time, per-item retry time, or the 60-second idle scan deadline. A simple 60-second idle scan is acceptable; it must not delay already-due backlog between attempts.
12. Respect the shared cooldown as a lower bound for the next mutation. It can be longer than the idle scan interval; waking to inspect state is harmless, sending early is not.
13. Use `abortableSleep(clock, delay, signal)` so shutdown wakes the worker. Recheck the signal after every wait; an aborted wait does not authorize another send.

Keep next-attempt pacing across cycle boundaries inside the worker instance. Otherwise a 100-item cycle boundary can accidentally bypass pacing. A restart may reset this local pacing state, but must not reset the durable Telegram cooldown or per-item retry deadlines.

Protect `runCycle` against overlapping execution if it is publicly callable while `run` is active. Use one in-flight-cycle guard, not a second process lease. Keep the app's existing singleton lease.

### 8.5 Shutdown and operation leases

Pacing and flood waits happen **before** claiming the next item. Once an operation has started, allow existing operation tracking, bounded shutdown drain, and durable recovery to handle it. Do not close SQLite while a worker can still write to it.

Retain the five-minute operation lease and heartbeat recovery semantics unless tests expose a necessary adjustment. Do not hold a claim through a 30-minute flood sleep.

### 8.6 Wire it into `application.ts`

- Construct one worker from the existing queue/renewal services and shared policy.
- Replace the inline renewal task with `supervisor.start("renewal", signal => renewalWorker.run(signal))` or equivalent.
- Leave publication scheduling separate. Do not condition maintenance on `schedule.enabled()`.
- Keep startup recovery before workers start.
- Keep the existing singleton lease, operation heartbeat task, readiness reporting, and shutdown tracking.
- Unexpected worker errors must be logged and delayed/restarted without a zero-delay spin. Preserve supervisor behavior.

## 9. Step E: align health and capacity projection

Keep the existing **46-hour warning/projection deadline**, which leaves a margin before the 48-hour ordinary deletion cutoff. Keep the existing age alerts: normal at 42 hours, immediate at 46, critical at 47. The renewal start remains 36 hours.

### 9.1 Use the worker's policy

`calculateRenewalCapacity` should import the same pacing-cost helper/defaults as the worker. Do not copy `20` into another module with a different rounding rule.

A useful per-source projection input is:

```ts
{
  itemId: number;
  physicalCreatedAt: number;
  memberCount: number;
  retryNotBefore?: number;
  maintenanceStatus?: MaintenanceStatus;
}
```

The projection also receives the actual shared cooldown deadline. Avoid an unrelated maximum of every item's maintenance retry date.

### 9.2 Eligibility and per-item backoff

- A source's earliest selection time is at least `physicalCreatedAt + RENEWAL_START_AGE_MS`, its own retry deadline, the current time, and any shared cooldown deadline.
- Among currently selectable items, use oldest physical age and then logical sequence as the worker does. If a source is delayed by its own retry, permit ready healthy sources to go first.
- For an offline projection, repeatedly pick the oldest ready source. If none are ready, advance the projection cursor to the earliest individual ready time. This avoids delaying the whole queue because its oldest member has a future retry date.
- Charge each projected attempt the same conservative pacing cost the worker uses. Document that network/API latency remains an estimate; this is a warning projection, not a deadline guarantee.
- Do not count a 100-attempt batch boundary as a 60-second idle delay when the worker does not impose one.
- Exclude completed/deleted items and fully published items awaiting deletion from new-renewal work, matching the selector. Continue reporting physical ages separately where useful.
- Do not pretend unresolved uncertain maintenance can be automatically renewed. Surface due unrenewable items explicitly, for example with an additive `blockedItemIds` field and `safe: false` when due blocked sources exist, alongside the existing explicit uncertainty alerts. If there is no projected throughput miss, avoid inventing a fake `projectedAt`; improve the capacity alert text to name blocked items instead.
- Keep raw source ages in milliseconds in health snapshots; apply human formatting only in handlers.

Retain compatible `safe`, `availableAt`, `totalMessages`, and optional `projectedFirstMiss` fields unless a justified API change is needed. Update health fixtures when adding optional/additive fields.

## 10. Step F: maintain cleanup, alerts, and recovery integrity

### 10.1 Existing alert paths to reuse

`src/application.ts` already raises deduplicated alerts for:

- `uncertain_renewal:<itemId>`;
- `renewal_warning:<itemId>` and `renewal_critical:<itemId>`;
- `orphan_manual:<itemId>:<sourceGeneration>`;
- `renewal_capacity` and lost permissions.

Use these mechanisms. Do not send an admin message for every failed attempt in a draining loop. A partial renewal should trigger the uncertainty alert; a terminal old-source cleanup should trigger manual-cleanup alerting.

The existing orphan-manual alert deduplicates per item/generation but its text includes just one old message. Prefer grouping terminal orphans by item/generation and listing all known old message IDs, with useful current-source context. Preserve the dedupe key and resolution behavior. It is acceptable for the normal alert scan to deliver the notification within its existing one-minute interval.

Do not claim that manual Telegram deletion can always be automatically detected. The bot cannot enumerate history. Preserve explicit operator cleanup/recovery flows and do not add indefinite blind retries for terminal age-limit orphans.

### 10.2 Crash points that must stay safe

| Crash point | Recovery expectation |
| --- | --- |
| Claimed but no send started | Release/recover as a safe future attempt, per existing phase evidence. |
| Send requested, response not durably known | Uncertain renewal, no blind resend. |
| Some replacement IDs recorded | Retain evidence and originals; require review. |
| Complete outputs recorded, generation not installed | Existing exact-count guarded recovery can install the complete replacement. |
| Generation installed, old cleanup incomplete | Retry only old cleanup; do not send replacement again. |
| Telegram flood wait active | Shared cooldown survives restart. |
| Definite item failure backed off | Per-item maintenance retry deadline survives restart. |

`recoverExpiredOperations` currently reconstructs source timestamps using recovery time in some paths. Harden the complete-output recovery path as part of this work: a replacement posted before a long outage must not be treated as freshly posted on recovery.

- For a normal send, capture a conservative source creation timestamp immediately before the transfer request. Keep the operation's actual transition/update time separate from the source timestamp if API timing can differ.
- For complete-output recovery, the existing durable operation `created_at` is a safe conservative lower bound on when its replacement could have been posted. Use that existing evidence for source age rather than `recoveryNow`; it may renew slightly early, which is safer than missing the deletion window.
- Use the same conservative source timestamp for replacement snapshots and `physical_created_at`. If an installation helper needs a separate source-time argument, add a narrow optional argument and preserve current callers; do not change unrelated completion timestamps to the older value.
- Test a complete-output operation created 40 hours before recovery: the installed replacement must already be due for renewal, not receive another fresh 36-hour wait. Only old-source cleanup is retried for the recovered operation; any later renewal is a new guarded operation on the recovered current generation.
- Do not redesign all timestamp storage or infer a Telegram send time from a message ID.

### 10.3 Generated update races

Add a regression in which a replacement channel update is observed/finalized before the send promise resolves. Verify it does not become a second queue item. Repeat with one earlier uncertain renewal and a later successful renewal so the oldest candidate-operation fallback cannot accidentally adopt or delete the later item's replacement evidence.

Preserve the conservative quarantine policy for unrelated unknown updates during unresolved renewal operations. Redesigning that global quarantine policy is outside this change unless a new regression demonstrates it directly prevents the accepted maintenance behavior. Do not infer ownership from arrival order or content similarity.

## 11. Test plan: required behavioral cases

Use real in-memory or temporary SQLite repositories wherever the bug depends on selection/state transitions. Mock only Telegram I/O and time. Do not mock `claimRenewal` to hand out the desired sequence and then claim to have tested starvation.

The project uses Bun's test runner, strict TypeScript, branded IDs, and `exactOptionalPropertyTypes`. Omit absent optional fields instead of assigning explicit `undefined` unless the type permits it.

### 11.1 Formatter and URL unit tests

Create `test/age.test.ts` and `test/telegram-message-link.test.ts` covering every table example in section 5, plus:

- rounding at all unit boundaries, singular/plural, finite negative values, `NaN`, infinities;
- no commas, unnecessary zeros, or mixed units;
- correct `-1001234567890` conversion;
- zero/negative/fractional/unsafe message IDs;
- ordinary group/user IDs and invalid channel IDs;
- album URLs do not force `?single`.

### 11.2 Admin integration tests

Extend `test/admin.test.ts`'s existing `createHarness`, which captures `sendMessage` API payloads.

1. Seed an item with logical age `247_668_018` ms. Request `/queue`. Assert `age 2.87 days` and no raw `… ms` age suffix.
2. Assert a `text_link` entity covers exactly the substring `#<item.id>` and its URL uses the configured queue chat and first current source ID.
3. Renew the item through real repository/service calls, regenerate `/queue`, and assert stable label/logical age but a changed URL pointing to the replacement.
4. Repeat renewal again; no historical generation is reused for the link.
5. Seed a full album; its number links to its first current member, not the item ID or another member.
6. Place an uncertainty warning before rows and test pagination; verify every entity offset still extracts its intended label from the final text.
7. Include non-ASCII/astral text before a row where practical; use UTF-16 offsets, not code-point counts.
8. With a simplified invalid channel ID or missing source ID, render a plain number without throwing or inventing a URL.
9. Dashboard head age and health source age use the formatter with labels that distinguish logical/physical age.
10. Existing buttons, stale tokens, authorization, and previous/next navigation remain intact.
11. Incomplete-album review displays known IDs/count and does not offer invalid known-output adoption.

### 11.3 Renewal service safety tests

Extend `test/renewal.test.ts`; retain its existing origin, orphan, and installed-cleanup cases.

1. Immediately below 36 hours: no renewal. At exactly 36 hours: eligible.
2. Successful single and album renewal: durable replacement evidence exists before old deletion is invoked. The fake delete implementation can inspect the database at call time to prove ordering.
3. Successful renewal preserves logical ID, sequence, `enqueuedAt`, logical status, content snapshots, semantic origin, ordinal grouping, and member count. Only physical generation/timing and maintenance fields change as expected.
4. Repeated renewal resets source timing each time while total queue age keeps growing.
5. Definite failure persists a maintenance retry deadline, releases the maintenance claim safely, preserves publication status, and does not immediately reselect the item.
6. A 1,800-second Telegram flood wait is not shortened to 300 seconds; assert the item's persisted retry deadline and shared deadline.
7. Network/5xx/ambiguous-result failures preserve originals and become uncertain without an automatic resend.
8. Three-member album returning two IDs: originals `[101, 102, 103]` remain current; no deletion of any of them; no generation install; logical item remains; replacement IDs remain recorded; maintenance requires review.
9. One-member-short response must not be interpreted as evidence that the final original member was the missing one.
10. Duplicate/out-of-order/malformed output cannot become a current complete generation or trigger original deletion.
11. Source age over 48 hours: replacement can succeed; age-limit old deletion creates terminal orphans and keeps a publishable current source.
12. A missing old message during post-install cleanup is successful cleanup, not `deleted_external` for the logical item.
13. Permission/transient old deletion failure preserves the new source; subsequent cleanup never republishes it.

Update the existing test named `quarantines a partial replacement when known output cleanup is ambiguous`: the new reason for review is incomplete replacement itself, and automatic partial-output cleanup is no longer required. Assert the new safety contract rather than retaining the old implementation's path.

### 11.4 Worker integration tests — this is the critical regression seam

Create `test/renewal-worker.test.ts` using the exact worker composed by `application.ts`, the real renewal service, and the real queue repository.

1. **Backlog:** seed at least 60 due singleton items, all created at the same time. Run cycles with a controllable clock. All 60 renew without a 15-minute sleep between items. At the recommended pacing, local pacing costs about three minutes, not fifteen hours. Fake Telegram latency can be zero.
2. **Batch boundary:** seed 105 due items. Verify the first cycle respects its attempt cap and the second continues after pacing, without the idle scan delay. No item is lost or renewed twice.
3. **Starvation:** oldest item always throws a definite permission failure; two later items succeed in the same draining process. Assert originals/status for the failed item, future retry time, later generations installed, and no publishing-order changes.
4. **Uncertainty isolation:** oldest send result is ambiguous; later due item still renews. Oldest remains under review; no second send is attempted for it.
5. **Per-item retry isolation:** one item has a retry deadline hours away; another due item is processed now.
6. **Flood stop:** first attempt returns `retry_after: 1800`; no second mutation or newly claimed renewal proceeds before the deadline. After advancing time, processing resumes.
7. **Paused schedule:** seed `schedule_enabled = false`; renewal still drains due items and publication is not triggered.
8. **Album pacing:** a ten-member album reserves ten times the singleton pacing cost, while remaining one logical item.
9. **Installed cleanup:** seed durable `renewal_cleanup_pending`; worker deletes old IDs without another forward/copy call.
10. **Abort:** abort during idle, pacing, and cooldown waits. No new send starts after abort and supervisor drain can finish without SQLite use-after-close.
11. **No busy-loop:** no due items returns an idle wake; permanent failures and unexpected errors cannot produce an unbounded synchronous loop.
12. **Overlap:** two attempted cycle invocations do not claim/send duplicate maintenance operations.

Clock warning: `createFakeClock` currently advances time immediately in `sleep()`. This works for a bounded `runCycle` but can make an unbounded `run()` loop spin forever in microtasks. Use a manually controlled sleep queue for continuous-loop/shutdown tests, or abort after a known bounded event. The existing application harness's sleep never resolves; it also ends polling immediately, so its current successful-startup test does not prove backlog draining.

### 11.5 Cooldown tests

1. A real raw grammY-style `{ ok: false, error_code: 429, parameters: { retry_after: 1800 } }` sets a durable deadline.
2. A subsequent mutation through a different API path, including direct `bot.api.sendMessage`, does not reach the underlying transport before the deadline.
3. A later shorter wait cannot reduce an existing longer deadline.
4. Advancing to the deadline permits a new request; no request is automatically replayed by the transformer.
5. Closing/reopening the database and rebuilding controller preserves the wait.
6. Read-only/polling methods remain operational according to the documented method policy.
7. Network failure does not become a synthetic safe retry or cause a hidden second send.
8. An injected service gateway reporting a 429 also updates/checks the shared controller.
9. A local cooldown refusal reports the remaining full wait and is not classified as an ambiguous send.
10. Orphan cleanup observes the shared wait and stops issuing further delete calls rather than flooding through an entire group list.

### 11.6 Capacity and health tests

Extend `test/operations.test.ts` and `test/health.test.ts`:

- singleton/album pacing uses the worker helper without per-item minute rounding;
- one deferred item does not block a healthy ready item in the projection;
- an active shared cooldown delays every projected outgoing renewal;
- physical eligibility starts at 36 hours rather than pretending a very young source needs immediate renewal;
- deadline risks are measured against the existing 46-hour margin;
- due uncertain sources are represented as blocked risk instead of assumed to renew automatically;
- fresh empty queues remain safe and retain existing optional-field behavior;
- projection inputs/outputs remain numeric, with formatting done by handlers;
- real worker tests and pure projection tests share the same policy constants.

### 11.7 Recovery and ingestion regression tests

Use existing repository/ingestion/recovery test conventions:

- output-before-response race does not create duplicate logical items;
- uncertain earlier operation does not permit a later known replacement to be adopted by the wrong item;
- complete-output crash recovery installs once and only retries old cleanup;
- partial-output crash recovery preserves originals and requires review;
- stale resolution actions cannot adopt a later generation;
- per-item retry and shared flood wait survive reopening the database;
- existing publication uncertainty and FIFO head-blocking tests keep passing.

## 12. Suggested implementation order and checkpoints

Work in small vertical slices. Write the relevant regression assertion before the fix, demonstrate the failure at the actual affected seam, then implement that slice. Do not write a huge speculative test suite before proving the first worker regression.

1. **Presentation slice:** add age/URL helpers and admin payload tests; wire the UI. Run formatter, link, and admin tests plus typecheck.
2. **Renewal safety slice:** change definite failure backoff and partial-album handling; update review rendering. Run renewal, repository, admin, and recovery tests.
3. **Shared cooldown slice:** add durable state/controller/transformer and full-delay service handling. Prove raw 429 handling and restart persistence. Run Telegram adapter, publication, orphan, and cooldown tests.
4. **Worker slice:** extract `runCycle`/`run`, implement pacing and draining, and wire production composition. Prove 60-item backlog, failing-oldest isolation, paused scheduling, batch continuation, and abort handling.
5. **Projection slice:** align capacity and health with the worker and per-item deadlines. Prove no false queue-wide block from one deferred item.
6. **Recovery/alert slice:** finish crash/race cases, grouped manual-cleanup context, docs, and full validation.

Do not make a throughput-only change before partial-album safety and failure yielding: it would amplify existing destructive/failure-loop behavior.

## 13. Validation commands and completion evidence

Run targeted tests after each slice. Names below include new files from this plan; create them before using the corresponding command.

```sh
bun test test/age.test.ts test/telegram-message-link.test.ts test/admin.test.ts
bun test test/renewal.test.ts test/repository.test.ts test/recovery.test.ts test/recovery-matrix.test.ts
bun test test/telegram-cooldown.test.ts test/telegram-matrix.test.ts test/publication-adapter.test.ts
bun test test/renewal-worker.test.ts test/application.test.ts test/supervisor.test.ts test/shutdown.test.ts
bun test test/operations.test.ts test/health.test.ts test/ingestion.test.ts
bun run typecheck
```

At the end run the repository's required complete check:

```sh
bun run check:all
git diff --check
```

`check:all` includes typecheck, the unit/integration suite, the coverage gate, and deployment-script tests. Do not weaken coverage thresholds or exclude new safety-critical modules to make the check pass. Existing defaults enforce 90% overall line/function coverage and 85% per critical file under the safety scope; read `scripts/check-coverage.ts` if a failure needs diagnosis.

If an unrelated baseline failure appears, show the command and evidence that it is unrelated. Do not silently claim all checks passed or discard it by editing tests. A changed partial-album expectation is related and must be updated to the accepted contract, not labeled unrelated.

### 13.1 Documentation updates after implementation

- `README.md`: retain 36-hour renewal but explain prompt draining, logical versus source age, source links, and maintenance while publishing is paused.
- `docs/queue-renewal.md`: update status from planned behavior to implemented behavior only after verification; retain runtime limitations honestly.
- `docs/telegram-compatibility.md`: add manual checks for new links after renewal, full album preservation, visible readable ages, and partial-replacement review. Preserve unchecked items until actually observed.
- Keep glossary terms free of implementation details. Update an ADR only if the final implementation changes the accepted architectural decision; ordinary pacing values belong in code/design notes.

### 13.2 Live Telegram checks are separate

No disposable bot/channel credentials were supplied to this planning session. Unit tests must use fake Telegram transport, not production resources.

If the implementing session has authorized disposable resources, manually verify:

1. Private queue links open the correct single post/album for an authorized channel member.
2. Renewed origins and albums remain correct.
3. Reopening `/queue` after renewal links to the replacement.
4. Old-source deletion and manual-cleanup alerts match actual Bot API responses.
5. Renewal-generated updates are not ingested twice.

Do not wait 36 real hours in an automated test or claim Telegram's 48-hour age cutoff was tested by changing only a local clock. Local time injection validates scheduling; it does not change Telegram's server-side message age. Record unperformed live checks explicitly. Deployment and production scheduling remain governed by the repository's existing runbook and compatibility gate.

## 14. Scope boundaries and failure traps

- Do not replace SQLite, build a new queue, or add Redis, a job service, a web dashboard, or another bot.
- Do not migrate to a Telegram user account/MTProto client to evade deletion limits.
- Do not reset logical age or publishing sequence on renewal.
- Do not link to historical `firstMessageId` or confuse a stable item number with a Telegram message ID.
- Do not add a second logical queue item when the bot reposts its own source.
- Do not break attribution by copying every forwarded post or reapplying publication policy during maintenance.
- Do not let a failed oldest item or unresolved review stop all other source maintenance.
- Do not let a flood wait for one item be bypassed by selecting another item or by the orphan worker.
- Do not confuse a server's ambiguous failure with a definite pre-send refusal.
- Do not delete surviving originals on partial output, and do not infer skipped member positions from array lengths.
- Do not install partial, invalid, duplicated, or stale-generation replacement IDs.
- Do not keep SQLite transactions open across network calls or sleeps.
- Do not hold an operation claim through a long idle/pacing/flood wait.
- Do not silently change the behavior of scheduled publication past blocked/uncertain heads.
- Do not add a 60-second idle delay between full nonempty draining batches.
- Do not bypass cancellation or remove the existing singleton/operation guards.
- Do not upgrade dependencies or rewrite unrelated admin flows.
- Do not commit secrets, runtime SQLite/WAL files, backups, logs, or transient test artifacts.
- Do not claim the production incident's exact cause was proven from code inspection alone. Throughput and starvation are verified code gaps; deployed message IDs/logs were not examined.

## 15. Final implementation checklist

- [ ] Queue rows display a linked stable item number and readable total queue age.
- [ ] Ages use one appropriate unit and at most two fractional digits; dashboard and health use the same helper with correct semantic labels.
- [ ] Links follow the current generation after repeated renewal and use the first current album member.
- [ ] Renewal starts at 36 hours and preserves logical identity, order, age, status, content, origin, and album grouping.
- [ ] Due backlog drains sequentially with conservative pacing and no 15-minute per-item bottleneck.
- [ ] Publishing pause does not pause source maintenance.
- [ ] Definite failures persist per-item retry deadlines and cannot starve healthy items.
- [ ] Full Telegram flood waits are honored across outbound mutation paths and survive restart.
- [ ] Ambiguous and incomplete sends preserve originals and require admin review without blind resends.
- [ ] Complete replacement is durably installed before old-source deletion.
- [ ] Cleanup failures retain a usable new source and track/report manual remnants.
- [ ] Capacity projections use the same pacing and per-item readiness as the actual worker.
- [ ] Restart, early-update, stale-menu, batch-boundary, and shutdown regressions pass.
- [ ] `bun run check:all` and diff whitespace validation pass without weakening gates.
- [ ] Documentation reflects the implemented behavior and distinguishes automated evidence from unperformed live Telegram checks.

The implementing agent's final report should state what changed, name the worker/backlog and partial-album regressions that now pass, list complete check results, and disclose remaining live-verification limits. Do not stop after changing only the age string or adding links: the renewal worker, safety policy, and associated evidence are part of the same accepted task.

## 16. Primary references

These references support API facts, not promises about this app's runtime:

- [Telegram Bot API: deleteMessage](https://core.telegram.org/bots/api#deletemessage) — ordinary message deletion age limit and rights.
- [Telegram Bot API: forwardMessages](https://core.telegram.org/bots/api#forwardmessages) — skipped unavailable messages and album preservation.
- [Telegram Bot API: copyMessages](https://core.telegram.org/bots/api#copymessages) — skipped uncopyable messages and album preservation.
- [Telegram Bot API: ResponseParameters](https://core.telegram.org/bots/api#responseparameters) — `retry_after` is the wait before repeating a flood-limited request.
- [Telegram deep links: message links](https://core.telegram.org/api/links#message-links) — public/private message URL forms.
- [grammY API transformers](https://grammy.dev/advanced/transformers) — API transformer integration; the installed local 1.38.4 typings are the implementation authority for this repository.
