# Queue priority, queue-author credits, and durable private menus

Investigation date: 2026-11-04. Status: implementation plan; no runtime changes made.

## 1. Requested outcome and working assumptions

1. Add **Move to first** alongside the existing move-to-end action. Moving changes logical publishing order, preserves the queue item's number and age, and does not publish it immediately.
2. Capture the author of a message submitted to the queue channel. Use that author for a generated `by …` credit when existing attribution rules do not already credit an original user or preserve a friendly channel's forwarding attribution. Apply custom nicknames to this author too.
3. Private bot menus remain usable after elapsed time and across restart. Navigation is reusable. Actions are refused because their relevant state changed, they were already executed, or their request is invalid—not merely because ten minutes passed.

Interpret “friendly channel” as the existing numeric channel whitelist. Interpret “author” as Telegram sender/profile metadata or, when that is all Telegram supplies, the queue post's author signature. Do not parse arbitrary `@mentions` or text ending in `by …` as author identity. These are implementation assumptions, not additional confirmed requirements.

## 2. Current implementation and evidence

| Area | Existing code | Consequence |
| --- | --- | --- |
| Queue order | `src/db/migrations.ts`: unique integer `queue_items.logical_sequence`; `src/db/repositories.ts`: `listActive`, `getHead`, `peekNextReady`, `moveToEnd` | Order is separate from item ID, enqueue time, and current Telegram message IDs. Front insertion can reuse this model. |
| Queue controls | `src/handlers/admin.ts`: `sendQueue`, `queue_move_end`, `queue_move_execute` | Each item has a generic `Move #…` button followed by a move-to-end confirmation. No front action exists. |
| Publishing | `peekNextReady` and publication claims in `src/db/repositories.ts`; `src/services/publication-coordinator.ts`, `publisher.ts`, `scheduler.ts` | Earliest ready item wins; issue items can be skipped. Manual publish confirms a particular ready candidate and source generation. |
| Message identity | `src/domain/message.ts`: `originFromMessage`, `snapshotFromMessage`; `src/types.ts`: `SemanticOrigin`, `StoredMessageSnapshot` | Only `forward_origin` becomes semantic origin. Direct posts become `absent`. Top-level queue author/profile/signature is not captured. |
| Attribution | `src/domain/origin-policy.ts`: `classifyPublicationPlan`; `src/services/preparation.ts` | Original users/hidden users get bylines; whitelisted channels forward; unlisted channels, chats, and direct posts currently receive no generated credit. |
| Nicknames | `createPolicyRepository` in `src/db/repositories.ts` | Identified aliases use account IDs and observed usernames. Hidden aliases use exact forwarded names. Refresh selectors currently query `origin_json`, which is insufficient for a separate queue author. |
| Editorial control | `acceptAdminQueueEdit`, `editorial_frozen_at`, preparation freeze checks | An admin edit freezes the whole post. New attribution must preserve that behavior. |
| Menu lifetime | `src/db/admin-repository.ts`: `createCallbackToken`, `consumeCallbackToken` | All callbacks default to ten minutes and are consumed on their first click, including navigation. |
| Dispatch | `src/services/admin-response-worker.ts`: `renderKeyboard`; `src/handlers/admin.ts`: `handleCallback` | Tokens are minted at dispatch. Missing, consumed, expired, and invalid stored tokens collapse to the same “This action expired” reply. |
| Prompts and retention | `setPendingPrompt`, `activatePendingPrompt`, `getPrompt`, `purgeExpiredTokensAndPrompts`; `src/services/retention.ts` | ForceReply prompts expire fifteen minutes after delivery. Retention deletes expired tokens, so merely ignoring expiry in the handler will not solve old menus. |

### Reproduced menu failure

A temporary Bun harness called the actual admin repository against a fresh temporary SQLite database, with deterministic timestamps and no Telegram calls:

```text
freshNavigation: true
sameNavigationSecondClick: false
unchangedNavigationAfterElevenMinutes: false
```

The desired-behavior assertion failed:

```text
assert.ok(repo.consumeCallbackToken(1, token, 1660000),
  "Unchanged Queue navigation must still work after eleven minutes")
AssertionError: Unchanged Queue navigation must still work after eleven minutes
```

Here `token` was an unchanged `queue` navigation token created at `1000000`. No queue state, permissions, or content changed. This establishes time expiry independently of genuine item staleness. The separate immediate second-click check establishes consumption independently of time. No temporary files or database were retained.

Relevant baseline command:

```sh
bun test test/admin.test.ts test/admin-reliability.test.ts test/ingestion.test.ts test/preparation.test.ts test/repository.test.ts
```

Result: **103 passed, 0 failed, 540 assertions**. Existing tests cover current behavior, not the requested new guarantees. Investigation stops at evidence and design because the requested deliverable is a plan; fixes and permanent regression tests belong to implementation.

### Existing decisions to preserve or extend

- `docs/adr/0001-preserve-queue-identity-during-renewal.md`: physical renewal preserves identity, order, and queue age. Explicit admin reordering is a separate operation.
- `docs/adr/0005-publish-earliest-ready-item-past-issues.md`: moving first gives priority among eligible items; it must not bypass issues or uncertainty.
- `docs/adr/0006-freeze-the-whole-post-after-admin-edits.md`: frozen posts retain their visible content and credits.
- `docs/adr/0003-match-hidden-sender-nicknames-by-exact-forwarded-name.md`: hidden forwarded names remain separate from account identities. Queue signatures need their own explicit identity decision.

## 3. Feature A: move an item to first

### Behavior

- Add clearly labeled **First #N** and **Last #N** controls; use a separate keyboard row if the existing Delete/Resolve/Retry row becomes crowded.
- First opens a confirmation: “Move queue item #N to the first position? Items with unresolved issues are still skipped.” Confirm and Cancel return to a fresh queue listing.
- An already-first item returns “Queue item #N is already first” without another mutation or misleading audit event.
- Treat an album and its separate credit as one item. No Telegram copying, deletion, renewal, or message-ID changes occur.
- Allow waiting `queued`, `blocked`, `needs_edit`, and `needs_review` items when no active operation owns them. Preserve every issue and retry deadline. Keep `collecting`, publishing, cleanup, deletion failure, and uncertain-operation states ineligible for this initial implementation, with an explicit reason.
- Hide unavailable controls, but also enforce the same predicate inside the repository. Old menus can still contain now-ineligible controls.

### Repository design

Add `moveToFirst(itemId, expectedPosition, now)` and share eligibility/error handling with `moveToEnd`. Return a typed outcome: moved, already_first/already_last, missing, terminal, busy, or position_changed.

Within one SQLite transaction:

1. Read the current item, its position, status, maintenance/preparation ownership, and active operations. Check eligibility and the expected position.
2. If already the first active item, return the no-op result.
3. Allocate `MIN(logical_sequence) - 1` across **all rows**, including completed rows. The UNIQUE constraint covers all rows; considering only active rows risks a collision.
4. Update only `logical_sequence` with the expected-position/status guards and verify one row changed.
5. Write `queue_moved_to_first` with admin ID, item ID, old position, and new position in the same transaction. Apply equivalent atomic audit handling to move-to-end.

Do not increment `content_version`: moving does not edit the post. Capture the current `logicalSequence` in move confirmations so an older confirmation cannot silently undo a later reorder. A move of another item need not invalidate this item's confirmation; “move to first” can be evaluated against the current order.

Negative sequences are suitable because the current schema imposes uniqueness, not positivity. Check JavaScript safe-integer boundaries before both prepend and append. If exhaustion is approached, fail explicitly; a future transactional two-pass compaction can preserve ordering without UNIQUE collisions. Do not add fractional ranks or rewrite all rows for every click.

Preserve `enqueued_at`, `physical_created_at`, source generation, content version, attribution, retry state, errors, and operation evidence. In particular, avoid repeating `moveToEnd`'s current assignment of `last_error_code = 'moved_to_end'`, which can overwrite a useful issue code.

### Publication interaction

- Ordering and publication claims are serialized by database transactions. A publication already claimed is not preempted. The next unclaimed selection sees the new order.
- Existing manual publish confirmation already rechecks `peekNextReady`; retain this check so a promotion cannot cause an old confirmation to publish an unintended candidate.
- Renewal keeps the new logical position and continues using source age for its due time. Preparation continues to use logical order without treating a move as a content edit.
- No database migration is required for the ordering field itself.

## 4. Feature B: queue-message author as fallback credit

### Attribution precedence

Select delivery policy from the original forwarded origin as today. Select credit identity separately:

| Input | Delivery and credit |
| --- | --- |
| Whitelisted/friendly forwarded channel | Preserve native forward attribution; no queue-author byline. |
| Original identifiable forwarded user | Existing original-user nickname/name credit wins; no submitter credit. |
| Original hidden forwarded user | Existing exact forwarded-name nickname/name wins; no submitter credit. |
| Unlisted forwarded channel | Copy; use queue-message author when available. |
| Forwarded chat | Copy; use queue-message author when available. |
| Direct queue post | Copy; use queue-message author when available. |
| Missing queue author | Preserve the applicable no-credit behavior; do not invent an author or use the channel title. |
| Unknown origin / unsupported content | Preserve review/blocking behavior; fallback credit does not make it publishable. |
| Frozen post or explicitly recovered “as shown” post | Preserve its visible representation; do not add a new fallback credit automatically. |

This is a policy decision, not a search for the literal word `by` in content. Reuse existing credit ownership and freeze rules to avoid duplicate generated credits and preserve intentional removals.

Instagram imports currently force copy delivery even for whitelisted origins. Keep the original-channel whitelist exemption for fallback credit, and keep original-user credits. Do not infer fallback solely from `deliveryMode === 'copy'`; that would mistakenly credit the queue author on a friendly-channel Instagram import.

### Capture and identity

Add an optional `queueAuthor` to `StoredMessageSnapshot`, distinct from `origin` and `nativeOrigin`. Suggested tagged union:

```ts
type QueueAuthor =
  | { kind: "user"; userId: UserId; displayName: string; username?: string }
  | { kind: "signature"; exactName: string };
```

In `snapshotFromMessage`:

1. Prefer a real, non-bot human `message.from` exposed by Telegram. Never infer a user from a channel-valued `sender_chat` or from known anonymous/service sender identities. Use representative payload fixtures to define this distinction precisely.
2. Otherwise capture a nonempty top-level `message.author_signature` as signature-only identity.
3. Otherwise leave `queueAuthor` absent. Do not use `forward_origin.author_signature` as the queue submitter: that belongs to the original forwarded post.

Telegram documents `from` as optional on channel messages and `author_signature` as a channel post signature. Profile-linked signatures are a channel setting, but the Bot API payload must be verified with this bot's channel configuration. Sources: [Bot API Message](https://core.telegram.org/bots/api#message), [channel signatures and profiles](https://core.telegram.org/method/channels.toggleSignatures). A signature string alone cannot establish an account ID.

Add explicit validators: the snapshot validator reconstructs allowed fields and will otherwise discard new metadata. Preserve compatibility with snapshots lacking `queueAuthor`. Add an item-level nullable `queue_author_json` to retain the original submission author independently of bot-created replacements, and `credit_identity_json` to record the selected reusable nickname identity. Keep raw identity values intact; sanitize only display output.

### Nicknames and author menus

- For a user identity, reuse `known_authors`, `author_aliases`, observed username resolution, validation, and revision keys (`user:<id>`). Direct queue submitters become observed authors and appear in `/authors`.
- For signature-only identity, add `known_queue_signature_authors` and its alias storage, keyed by queue chat ID plus exact signature text. Use a separate revision key such as `signature:<row-id>`. The same signature in this queue shares one nickname; changed spelling is a different identity.
- Add a paginated **Queue signatures** section to `/authors`, with select, set/replace, and remove flows. Explain that a signature nickname applies to all queue posts with that exact signature. Keep account, hidden-forward, and signature identities separate even when their visible names match.
- Do not match signatures to user aliases by display name. A signature-only post cannot safely inherit an account nickname without actual account metadata. This is why signature nickname management is part of the plan.
- Reuse `validateAlias` (including its length/control-character rules), `safeDisplayName`, and existing removal semantics. Empty input remains invalid.

Add a small shared attribution resolver, for example `src/domain/credit-policy.ts`, returning the selected credit identity/source or none. Use it at ingestion, preparation, refresh, and Instagram import. Do not overwrite `origin_json` with the submitter: that would corrupt forward/copy policy, album origin checks, and publication contracts.

### Preparation and nickname refresh

1. Capture queue author before pending-update persistence. Preserve it through pending post/edit coalescing and restart. Select an album's author from consistent available member metadata; missing member metadata must not erase a known author. Conflicting real identities require review, not last-member-wins behavior.
2. At initial item insertion, persist the author and selected credit identity; observe that identity and capture its nickname revision transactionally as current user-origin ingestion does.
3. Extend `classifyPublicationPlan` or split it into delivery classification and credit rendering. Both normal preparation and `refreshClaim` must use the selected identity rather than assuming `item.origin` owns the credit.
4. Revisit `transformsSource = item.origin.kind !== 'absent'`: direct posts can now need a credit. Choose transformation based on the prepared plan and existing safe execution path, not origin absence. Preserve admin edit collision checks whether direct content is edited in place or transferred.
5. Reuse text/caption/separate credit rendering, entity offsets, Telegram size checks, album grouping, and `AttributionDescriptor` ownership. Generate exactly one credit. Keep overflow as `needs_edit`, with no nickname truncation.
6. Replace origin-only refresh selectors in `reconcileAffectedIdentifiableItems`, `updateIdentifiableAuthorItems`, and hidden-name updates with selected-credit-identity matching. A nickname edit must refresh fallback-authored posts too, but must not refresh posts where that submitter lost to an original-user or friendly-channel policy.
7. Persist wanted/applied revision keys for the chosen identity and retain readiness guards until refresh completes. Handle nickname changes during preparation using the existing revision convergence pattern.
8. Carry the logical author and credit identity through prepared snapshots, publication/renewal contracts where needed for replay, and replacement generations. Bot-authored output must never replace the submission author.
9. Admin edits freeze the whole post. Recovery remains “as shown”; only explicit Apply preparation rules can request policy application, and it must not guess missing historical author data.

### Migration and historical posts

- Add schema changes as a new migration in `src/db/migrations.ts`; preserve existing origins, aliases, and operation contracts.
- Backfill `credit_identity_json` for existing user/hidden-user origins where reliable; preserve their current behavior and revision keys.
- Old snapshots did not store queue-author metadata. Leave unavailable authors null. Do not assign the configured admin to old posts or infer authors from a generated current source.
- Do not automatically rewrite already-prepared or frozen historical posts to introduce fallback credits. Apply fallback to new submissions with captured metadata; explicit re-preparation can use trustworthy stored metadata if present.
- Old active/uncertain operations continue under their captured contracts. New optional fields must validate and replay without requiring a destructive global contract rewrite.

## 5. Feature C: menus valid until relevant state changes

### Callback categories

| Category | Examples | New behavior |
| --- | --- | --- |
| Navigation | dashboard, queue/pages, authors/pages, signature selection, health, logs, safety, schedule, whitelist, item review views | Reusable; render current state on every click. No timer or one-shot consumption. |
| Start an interaction | alias entry, add slot, recovery entry, delete/move/publish preview | Reusable entry point; read current state and create a fresh bound prompt/confirmation. |
| Local mutation | move execution, retry, alias removal, slot removal, pause/resume, whitelist confirmation/removal | One-shot receipt with action-specific preconditions; no arbitrary elapsed-time invalidation. |
| External or uncertainty mutation | publish execution, delete execution, preparation/renewal/publication resolution | One-shot, current item/operation evidence checks, durable action worker and existing uncertainty handling. |

Audit every `handleCallback` case when assigning a category; unknown actions default to rejection, never to reusable execution. In particular, `hidden_alias_set` creates a prompt, while `hidden_alias_remove` mutates state. Do not classify actions solely by their names or suffixes.

### Transport and persistence

Use compact versioned **stateless callbacks for allowlisted navigation and interaction entry points**, and durable opaque tokens for mutations:

- Introduce a bounded `v2` encoding for allowlisted action IDs and validated small numeric arguments (page offset, item ID, observed author row ID). Never embed names, nickname text, operation evidence, or JSON in callback data. Respect Telegram's [1–64 byte callback-data limit](https://core.telegram.org/bots/api#inlinekeyboardbutton).
- Stateless callbacks are safe only because every entry requires the configured numeric admin and a private chat, and can only read state or open a fresh interaction. Strictly reject extra fields, negative/out-of-range numbers, and unknown verbs.
- Keep mutation payloads server-side under random opaque tokens. Replace mandatory token expiry with nullable expiry and an explicit action classification. New state-bound actions use no time expiry.
- Replace `consumeCallbackToken`'s undefined result with a typed lookup/claim result: available, already_processed, invalid, missing, or explicitly_expired_legacy. Keep receipt state distinct from resource staleness.
- Claim a local mutation token, validate preconditions, apply the mutation, write audit, and finalize the admin receipt in one transaction. A crash cannot consume a valid action while losing the mutation.
- For remote work, atomically claim the token and defer the captured action into `AdminUpdateRepository`. The worker owns retries and ambiguity; a click or reply retry never reruns a remote mutation.
- Preserve update-ID deduplication and best-effort `answerCallbackQuery`. Different callback updates can hit the same confirmation token: one must win, and later clicks report the recorded result or “Already processed.”

This avoids an indefinitely growing token row for every read-only menu button. Mutation tokens still need explicit lifecycle cleanup: retain unconsumed actions while their captured preconditions remain valid; purge terminal/invalidated actions after a documented retention period. Do not delete a still-valid action merely because its menu is old. Include unreferenced tokens from failed outbox delivery attempts in cleanup, while retaining tokens when delivery is ambiguous.

### Define actual staleness per action

- Navigation: refresh current data and clamp pagination after list shrinkage. An old review-view entry should open current evidence for that item, not require the old content version.
- Publish: retain the current candidate ID, content version, source generation, and readiness comparison, then revalidate in the worker before claim.
- Delete: require current content/source identity and allowed status. Renewal can make the old source-specific confirmation stale even while the item's navigation remains useful.
- Move: compare the item's captured position and recheck eligibility. A content-only edit need not invalidate a move; never let a move bypass an operation claim.
- Retry: compare the failed state/relevant issue or operation revision, not just item existence.
- Uncertainty resolution: keep operation ID, phase, captured source generation, content evidence, and output-set guards. Where evidence can change in the same phase, compare its revision or fingerprint too.
- Alias, whitelist, and slot mutations: capture a resource revision/existence generation to prevent an old removal from removing a newly replaced value. For account nicknames reuse `alias_revision`; add equivalent guards where absent.
- Pause/resume: explicit idempotent desired-state operations may return “Already paused/running”; recheck the current slot requirement for resume. Do not implement a timeless toggle.

Use action-specific validation instead of the current blanket content-version rejection before the switch. Otherwise harmless changes invalidate navigation, and a content-version match still misses important non-content changes.

### User-facing responses

Remove the generic expiry message for new valid menus. Examples:

- “This item has already been published.”
- “This item's source changed. Review it again before deleting.”
- “The next ready item changed. Review Publish next again.”
- “This issue has already been resolved.”
- “This confirmation was already processed.”

Include a fresh Queue/Dashboard/review button where useful. Invalid or unknown data gets “This button is no longer available” rather than claiming the item expired. Do not infer item state when the token is missing.

### Prompts

Keep ForceReply generation IDs, delivered-message binding, pending/active delivery state, and one active prompt per admin. Remove elapsed-time expiry for new prompts too; invalidate on `/cancel`, replacement by another prompt, successful use, authorization failure, or changed target evidence. This makes an old delivered nickname or slot question usable when it is still the active question.

Pending prompts must still activate only after confirmed delivery, and replies to superseded questions must remain rejected with an explanation. Update retention and `activatePendingPrompt`/`getPrompt` together; changing callback policy alone leaves the fifteen-minute prompt failure intact.

### Compatibility with already-sent menus

- Keep a `v1:` reader. For retained navigation tokens, decode the allowlisted action without consuming it and ignore legacy time expiry; old buttons become reusable when sufficient state still exists.
- For retained legacy mutation tokens, preserve consumed state and revalidate all available captured evidence. If old payloads lack a required guard, open a fresh preview rather than executing them.
- Rows already purged cannot be reconstructed from their random token. Explain the button is unavailable and provide a fresh dashboard. This is a one-time rollout limitation, not evidence that its queue item is outdated.
- Existing pending outbox descriptors must still dispatch correctly. Version descriptors only where necessary, and retain validation/read compatibility with stored version 1 descriptors.

## 6. Implementation sequence and file map

1. **Lock regression seams.** Extend `test/admin.test.ts`'s real Grammy handler/outbox harness with mutable fake time; add repository expiry/consumption cases and state-specific mutation checks. Reproduce both current menu failures before implementation.
2. **Durable callback foundation.** Update `src/db/migrations.ts`, `src/db/admin-repository.ts`, `src/services/admin-response-worker.ts`, `src/handlers/admin.ts`, `src/services/admin-actions.ts`, and `src/services/retention.ts`. Add a shared callback codec/category registry so dispatch and handling cannot disagree. Cover legacy data and restart.
3. **Queue promotion.** Add guarded first/last repository methods, confirmation handlers, clear labels, and atomic audits. Update existing move-to-end tests and preserve failure diagnostics.
4. **Author capture and schema.** Update `src/types.ts`, `src/domain/message.ts`, `src/domain/validation.ts`, migrations, `src/domain/queue-item.ts`, queue row parsing/insertion, and `src/services/ingestion.ts`. Exercise delayed pending updates and albums before changing rendering.
5. **Credit selection and aliases.** Add the shared resolver; update policy observation/lookup/refresh selectors, signature alias persistence, `/authors`, and preparation including Instagram import and refresh paths.
6. **Preservation and operations.** Check prepared-transfer, renewal, recovery, admin edits, generated-event suppression, publication contract validation, and restart replay. Keep historical contracts readable.
7. **Document and verify.** Update README attribution/menu descriptions, `GLOSSARY.md` (queue author versus original sender), `docs/hidden-sender-nicknames.md`, and relevant preparation docs. Record separate ADRs for explicit priority changes, signature identity, and state-based action validity. Do not describe signature identity as an extension of forwarded-channel identity.

Each step should form a reviewable change with its own regression coverage. Callback foundations precede First so the new action does not inherit the lifetime bug.

## 7. Acceptance and regression tests

### Queue priority

- `[A, B, C] → First(C) → [C, A, B]`; repeat is a no-op; Last(C) restores `[A, B, C]`.
- Stable item IDs, queue/source ages, snapshots, credit members, content/source versions, errors, and retry deadlines survive moves and restart.
- Existing terminal rows with smaller sequences do not cause UNIQUE conflicts. New ingestion still appends correctly after repeated front/back moves. Boundary failures are explicit and atomic.
- Album movement is a single logical action. Renewal retains the new position. First of an issue item does not make it ready or stop a later eligible item.
- Busy/terminal/uncertain/collecting items are refused with reasons. A publication claim and a move cannot both use stale eligibility.
- Old move confirmations cannot undo a later move of the same item. An old publish confirmation is rejected if promotion changed the next ready candidate.

### Author credits

- Direct text, captioned media, captionless media, separate-credit types, albums, and Instagram imports use the selected queue author exactly once.
- Existing account nickname beats profile display name. Changing/removing it refreshes untouched fallback credits and survives restart, preparation replacement, and renewal.
- Original user/hidden-user credits and friendly-channel forwards retain precedence even when the queue author has a nickname.
- Unlisted channel/chat posts use the fallback. Missing metadata stays uncredited. Unknown/unsupported inputs keep their issue.
- Signature aliases use exact matching in their own namespace; shared names, case/Unicode variants, renamed signatures, same-name accounts, and hidden-forward identities do not merge accidentally.
- Actual Telegram fixtures cover profile-linked signatures, signature-only posts, absent sender fields, bot/service senders, and forwarded post signatures versus top-level signatures.
- Pending update coalescing, duplicate updates, album members with missing metadata, and conflicting album authors preserve or reject identity deliberately.
- Nickname revision changes during preparation converge; refresh failures still hold publication. Long aliases follow existing overflow behavior; formatting offsets remain correct.
- Admin edits/removals freeze the full post; explicit recovery remains as shown. Historical rows without queue-author metadata remain readable and unchanged.

### Private menus

- Queue, dashboard, all pages, Back, author selection, and review views work after 11 minutes, 24 hours, seven days, retention, and process restart; repeated clicks with distinct update IDs succeed.
- A still-active delivered prompt works after fifteen minutes and restart. Replaced/cancelled/completed questions remain invalid; pending delivery does not accept replies early.
- A valid old confirmation executes once; double clicks, duplicate updates, interrupted local transactions, and worker restarts do not replay mutations.
- Changed content, source, position, status, nickname revision, resource generation, or uncertainty evidence invalidates only the actions that rely on that data, with a specific explanation.
- Reusable entry points open fresh previews/prompts. They cannot execute destructive or remote work directly through the stateless codec.
- Wrong user/chat, malformed encodings, unknown verbs, out-of-range arguments, oversized payloads, corrupt stored JSON, and missing legacy tokens are rejected safely.
- Delayed/ambiguous outbox delivery and token cleanup do not invalidate a delivered valid menu or resurrect an executed mutation.
- Legacy retained navigation works; insufficient legacy mutation guards trigger a fresh confirmation; purged tokens get a replacement menu without claiming the item expired.

## 8. Verification and completion

During implementation run focused tests in `test/admin.test.ts`, `test/admin-reliability.test.ts`, `test/repository.test.ts`, `test/migration.test.ts`, `test/ingestion.test.ts`, `test/domain.test.ts`, `test/preparation.test.ts`, `test/instagram-preparation.test.ts`, `test/renewal.test.ts`, and `test/recovery.test.ts` as relevant. Add integration cases to the existing matrix suites where multiple workers or restart boundaries matter.

Then run `bun run check` and the repository's deployment safety checks (`bun run test:coverage:gate`, `bun run test:deploy`) before release. Assertions must reach the actual handler/repository/worker seams, not only test the new resolver against itself.

Extend `docs/telegram-compatibility.md` with a disposable-channel check of the actual author fields delivered for this channel configuration, original-user/friendly-channel precedence, one album, signature nickname behavior, front movement, and an old menu after restart. Never log full production message payloads or credentials to obtain fixtures.

Completion means all three behaviors work together: an old queue menu can open a fresh promotion confirmation; the promoted item keeps its correct generated author credit through renewal; a later nickname change refreshes that credit without resetting order or age; and stale mutation evidence produces a concrete reason while navigation remains available.
