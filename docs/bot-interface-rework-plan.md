# Shitpost Desk in Telegram PM

**Build the admin interface around an interactive HTML widget in the bot’s private chat.** One Desk bubble holds the queue, item details, publish review, issue resolution, schedule and settings. Open it with `/start` or `/manage`. Move between screens inside the same bubble. Use ordinary PM replies for text input, alerts and operation receipts, and keep `/manage classic` available from the command menu and widget caption.

Telegram’s public Bot API reference currently lists 10.3. The widget project documents `sendWidget`, `widget_query`, `answerWidgetQuery` and `editMessageWidgetData` against its 10.4 beta test environment. Client rendering is controlled by platform and version. Verify the endpoints and the admin’s devices with a disposable bot before enabling the Desk on the live bot. Widget mode is the intended default after that check. [Widget transport and beta API](https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/tgw-format.md#the-bot-api-104) · [Public Bot API changelog](https://core.telegram.org/bots/api-changelog)

## The PM experience

The visual direction is a compact editorial console. The Desk has a large “Up next” block, a schedule pill, and a short queue summary. Queue rows are full-width tap targets. Use the client’s theme tokens for text and buttons, a restrained accent for the next post, and a labelled warning treatment for issues. Show one strong action per detail screen and put secondary actions lower in the card. Keep touch targets at least 44 CSS px high, fit the narrowest tested bubble width and let the bubble resize when navigating. Preserve readable labels and a quiet layout at large text sizes. [Widget runtime profile](https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/widget-runtime-profile.md) · [Widget SDK](https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/sdk-v1.md)

```text
╭──────────────────────────────────────╮
│ SHITPOST DESK              ● Running │
│                                      │
│ UP NEXT                              │
│ #142 · Video                         │
│ Today 18:30 UTC                      │
│ [ Review next publish              ] │
│                                      │
│ [ 12 in queue ] [ 3 need attention ] │
│ [ Schedule    ] [ More             ] │
╰──────────────────────────────────────╯

╭──────────────────────────────────────╮
│ ‹ Desk    QUEUE               1–5/12 │
│ 1   #139 · Album     Needs review  › │
│ 2   #142 · Video     Ready · Next  › │
│ 3   #143 · Photo     Preparing     › │
│ …                                    │
│                         [ Next › ]   │
╰──────────────────────────────────────╯

╭──────────────────────────────────────╮
│ ‹ Queue   #139 · ALBUM               │
│ Position 1 · Queued 6h ago           │
│                                      │
│ NEEDS REVIEW                         │
│ Preparation may have created output.│
│ Check the queue channel before retry.│
│                                      │
│ [ Review evidence                  ] │
│ [ Open source ↗ ]        [ Actions ] │
╰──────────────────────────────────────╯
```

| Screen | What the widget shows and what a tap does |
| --- | --- |
| **Desk** | Scheduler running, paused or missing slots. Show the next scheduled UTC run, including a pending retry when relevant, and the actual earliest eligible candidate. Show the active queue count and attention count with distinct labels. Tapping the candidate opens its review. Tapping either count opens the corresponding list. Refresh is explicit and refreshes the current screen. |
| **Queue** | Four logical positions per page, with stable item ID, media type, short status and age where it fits. Mark the next eligible item even when it sits behind a blocked head. Tap a row to open Item. Previous, Next and Back preserve the route and page. Clamp a page after deletes. The list shows logical order even after source renewal moves messages in the queue channel. |
| **Item** | Current source link, logical position, age, availability and the reason or retry time when known. Ready items link to the source and expose Move first, Move last and Delete in Actions where eligible. Blocked items offer a guarded retry when safe. Uncertain items lead with Review evidence and show only resolutions allowed by the existing operation rules. The source link is rebuilt from the current source IDs when the screen is opened or refreshed. |
| **Review** | A dedicated screen for publish, retry, move, delete and resolution. Show the item, what the action affects, current evidence and a specific confirm label. For publication, say which item the run starts with and that a definite failure with no output can advance it to a later eligible item. The success receipt names the item that actually published. Cancel returns to the originating screen and invalidates the preview. |
| **Needs attention** | An inbox with separate lanes for item issues, uncertain operations and system issues. Include uncertain publish, preparation and renewal, plus quarantine, manual cleanup and cooldown warnings. An item appears once in the count. Tap to read evidence, with source and known destination IDs paged if needed. Distinguish known output, no tracked output and unknown outcome. |
| **Schedule** | Running/paused state, next run and paged UTC slots. Select a slot before opening Remove. Pause/resume and remove have a review, and resume explains when no slot exists. Add opens the existing reply prompt for `HH:MM`. |
| **More** | Authors, whitelisted sources, Health, Logs and Recover. Authors keep Telegram accounts, hidden sender names and queue signatures separate. Use paged lists and a detail view for alias changes. Health and Logs start with short redacted summaries and link to their existing commands for expanded output. Recover starts the existing reply flow and brings the recovered item back into focus once recorded. |

The widget opens queue and destination links with `TelegramWidget.openTelegramLink()` on a dedicated tap. If a user needs to enter a slot, alias, source channel, recovery bundle or exact destination IDs, the widget opens the existing ForceReply flow. The widget says “Reply to the bot’s prompt” once that prompt has a delivery receipt. Cancel uses the existing prompt cancellation path. Navigating away from the prompt screen preserves the active prompt, and the widget shows how to resume or cancel it. [SDK links and tap handling](https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/sdk-v1.md#25-links) · [Existing admin prompt handler](../src/handlers/admin.ts)

## Widget and state contract

**Ship one versioned Desk template.** Keep source HTML, CSS and JS readable in `src/admin-ui/widget/`. A build step inlines the assets and checks the final byte size. The template draws list, detail, evidence and review screens from small state records. Use `textContent` or equivalent safe DOM setters for any server-supplied strings. Use plain profile-compatible CSS, native button elements and short transitions only where the client behaves well. Keep tabs, details disclosure and other display-only interaction local when the data is already present. Fetch fresh domain data on deliberate taps. A template upgrade opens a new widget message because Telegram fixes the HTML at send time. [Widget SDK state contract](https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/sdk-v1.md#213-the-widgets-state-and-where-it-is) · [Widget transport limits](https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/tgw-format.md#the-bot-api-104)

| Payload | Budget and contents |
| --- | --- |
| HTML | CI target ≤3,800 bytes after zlib level 9 compression and ≤32,768 raw UTF-8 bytes. Include the renderer and static copy. |
| `chat_data` | Target ≤900 UTF-8 bytes, hard cap 1,024. Include schema version, revision, screen, short display fields, action references and optional validated Telegram link. |
| Answer `data` | Same screen shape for fast updates, or a small error/ack envelope. Hard cap 1,024 UTF-8 bytes. |
| Request `data` | At most 64 UTF-8 bytes. `w1:<revision>:<key>` selects an action stored for that screen. Reserve `w1:r` as a read-only refresh for any revision of the active widget. |
| Server only | Full route arguments, previous route, revision-scoped actions and their confirmation evidence. Store the latest screen and its action map per panel, plus the existing durable action receipts. |

Example response with three rows and a matching tap. The destinations behind the row keys are stored in SQLite. The Back control uses the saved previous route. A row key is tied to the item’s stable ID in that revision.

```json
{"v":1,"r":18,"t":"Queue","b":"1–3 of 3 · Up next #142","a":[["0","1 · #139 · album · needs review","row"],["1","2 · #142 · video · Ready · Next","row"],["2","3 · #143 · photo · Preparing","row"],["b","‹ Back"]]}
```

```text
w1:18:1
```

Encode and measure UTF-8 after serialization. Shorten bounded display strings first. Then reduce row count or paginate evidence with explicit continuation. Never silently drop a destructive action’s target or safety evidence. If the preview cannot fit with enough context for a safe choice, link to the existing full review in chat. Test multibyte aliases, long log lines, large IDs, albums and the longest legal error labels.

Private widgets use `allow_queries: true` and omit `is_shared` and `public_data`. Keep captions generic, with the classic command and no queue data. A forwarded copy has no private chat state and should render a neutral “Open the bot in PM” card. Check permissions server-side using the original query’s sender ID, configured private chat and active message ID. Reject inline, shared, group, wrong-user and retired-widget queries. Widget HTML and client-reported data supply presentation, while the database and Bot API update supply identity and authorization. [Widget forward behavior](https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/tgw-format.md#caption-preview-old-clients) · [Existing private action guards](adr/0009-validate-private-actions-against-state.md)

## A tap from end to end

1. **Accept the update.** Read `widget_query` from the raw Bot API update at the grammY boundary. Add it to the same long poller’s explicit allowlist after capability verification. Validate the update before admin handling and record the Telegram update ID in the existing receipt system. A redelivery returns the recorded status or current screen and never schedules the action again. Process classic callbacks through the same service that handles admin actions.
2. **Resolve the action.** Load the active panel and revision. Resolve the key through the server-side action map. A stale tap returns the latest screen and a short “Review again” hint without acting. A dedicated refresh can resync stale clients. For a confirmation, check the active preview’s revision, current resource evidence and domain preconditions. Advance the revision in the same transaction as the local mutation or durable action request and the update receipt. Leaving or replacing a review retires its controls. Classic confirmations continue to use the existing single-use tokens. Back and Refresh remain usable across restarts and elapsed time.
3. **Answer promptly.** Call `answerWidgetQuery` with the new screen or a truthful pending/error state. Target a response within one second on a healthy connection. Telegram documents a 15-second deadline, so keep the answer on a short, separately bounded path like callback acknowledgement. Never wait for publishing, channel deletion, prompt delivery or the message edit before answering. The client calls `TelegramWidget.request()` synchronously in the tap handler, shows a pending indicator and allows one query in flight. After a timeout on a mutation, offer Refresh and show the recorded outcome when it exists. [Query timeout and rate limits](https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/tgw-format.md#the-widgets-state-and-requests) · [SDK request contract](https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/sdk-v1.md#214-requests)
4. **Save the screen to the bubble.** Commit the desired revision and its checkpoint intent together. Feed `editMessageWidgetData` to the existing outbox and shared Telegram pacing. Coalesce to the latest revision with a short quiet window, initially one second, so a burst of browsing sends one checkpoint instead of one edit per tap. The widget applies both the query answer and `chatDataChanged` with the same monotonic revision rule, so a delayed edit cannot replace newer state on screen. On a different device or after reopen, an old checkpoint can briefly appear. A stale tap or Refresh returns the current snapshot. Disable automatic widget requests and periodic bot edits.
5. **Deliver the real result.** For long-running actions, show “Publish requested”, “Delete requested”, or the corresponding pending label after the durable request is accepted. When the worker records an outcome, send the existing PM receipt. If the widget is still on the matching pending screen, update it to the result. If the user has navigated elsewhere, preserve their route. A result such as “Destination may already have a copy” leads to the evidence screen and leaves further retries subject to the existing checks.

Store one panel row per admin chat with active message ID, template version, desired route and revision, checkpoint revision and lifecycle state. Serialize sends and edits per panel. Recheck target and revision immediately before dispatch. Treat a confirmed no-op edit as delivered. On `429`, defer through the shared cooldown and coalesce newer state. After an ambiguous edit, treat the checkpoint as unconfirmed, retain the known message ID and reconcile to the latest desired state through the same worker. After an ambiguous new send, retain its uncertain receipt and require an explicit reopen before sending another widget. If a definite error says the message is gone, retire it and let `/manage` open a replacement. Only a send with a recorded message ID activates a widget. Old widget messages lose access when replaced or disabled.

For example, a tap can move the Desk from Queue revision 18 to Item revision 19 and return revision 19 in the query answer. If a second client sends another revision 18 tap before the checkpoint lands, it receives revision 19 and can tap again. The same rule applies to a delayed confirmation from another device. Keep the queue page queries bounded and check item availability again when resolving a row. Moving or renewing an item between the list and detail reads still opens the same logical item, with its updated position or source.

## Repository changes and milestones

| Milestone | Change and exit condition |
| --- | --- |
| **0. PM compatibility proof** | With a disposable bot and test chats, record which endpoint accepts sends, queries, answers and edits. Capture redacted payloads and screenshots from the admin’s actual phone and desktop. Verify tap → answer, edit → `chatDataChanged`, reopen on a second device, original vs. forwarded behavior, link opening and classic entry on an unsupported client. Test the normal endpoint separately before relying on it for a live token. If only the beta test endpoint works, continue developing and testing there with fixtures while the live enablement waits for a compatible endpoint. [Telegram reference test bot](https://github.com/TelegramMessenger/widget-sandbox/blob/main/scripts/conformance/test-bot.ts) |
| **1. Read-only widget in PM** | Add the typed widget transport next to `src/telegram.ts`, a versioned render model under `src/admin-ui/`, a panel repository/migration, and widget query handling in `src/application.ts`. The installed grammY types predate the widget API. Use a narrow compatibility layer or a compatible SDK upgrade and keep a single bot update stream. Extend `src/services/telegram-admission.ts` to pace widget sends/edits and `src/services/admin-response-worker.ts` to dispatch those operations with durable receipts. Ship Desk, Queue, Item, pagination, source links and Refresh to the disposable bot. [Polling and wiring](../src/application.ts) · [Admission](../src/services/telegram-admission.ts) · [Outbox worker](../src/services/admin-response-worker.ts) |
| **2. Daily queue operations** | Extract the action boundary from `src/handlers/admin.ts` so classic callbacks and widget queries share the same preview and execution rules. Add guarded review screens for publish next, retry, move first/last and delete. Reuse `src/services/admin-actions.ts` and the existing audit path. Preserve the old `queue_item` callback’s meaning for alerts and old messages. Confirm the existing publish run behavior in the widget copy. Exit when the admin can operate a seeded queue entirely from the widget and see the real outcome in PM. [Admin handlers](../src/handlers/admin.ts) · [Admin action worker](../src/services/admin-actions.ts) · [Queue identity](adr/0010-reorder-queue-items-without-changing-their-identity.md) |
| **3. Attention and schedule** | Add issue lists, evidence screens and the existing uncertainty resolutions for publication, preparation and renewal. Add pause/resume, add slot and select/remove slot. Keep the recovery and exact-ID prompt safeguards. Exit when the admin can distinguish and resolve each supported uncertainty from the widget, and cancel or finish a schedule prompt after restarting the bot. |
| **4. Settings and rollout** | Add authors, whitelisted sources, health/log summaries and recovery entry. Route the existing relevant slash commands into the widget when enabled. Preserve `/manage classic` for an explicit switch and keep existing v1 outbox descriptors readable. Add the client checks to the Telegram compatibility checklist. Enable for the single admin after the live gate below. [Outbox repository](../src/db/admin-response-repository.ts) · [Compatibility checklist](telegram-compatibility.md) |

Use `ADMIN_WIDGETS=classic` by default, `widget` for the normal endpoint and `beta-test` for Telegram’s separate test environment. `/manage reopen` explicitly replaces the active message when the current Desk has scrolled out of view. Keep the endpoint selection explicit and restricted to Telegram’s verified host and paths. Redact tokens, action tokens, request/response state and private links in logs. Log method, error class, receipt state, update latency and byte counts. An unsupported client can open `/manage classic` without first rendering the widget. Retire or disable widget work during rollback and drain or reconcile pending widget outbox rows before running an older binary that cannot read their descriptors.

## Release checks

- **Interaction.** Desk → publish review is one tap. Desk → Queue → Item is two. Navigating those screens keeps the same widget message ID. The queue stays readable on phone and desktop in light and dark mode and at large text sizes. Check that a delayed checkpoint, rapid taps, navigation from a second device and reopen after restart converge on the same latest screen. Compare screenshots for the real PM client, not just the SDK preview.
- **Safety.** Use fixture cases where the head is blocked, a source is renewed during review, a candidate changes, a token is reused, a query update is redelivered and another chat or user attempts an action. Verify confirmed writes commit once and their results describe the actual target. Exercise the fallback for uncertain output and confirm that classic callbacks still use the same guards.
- **Delivery.** Simulate a query timeout, message edit returning no change, `429`, restart mid-send, an ambiguous result, a deleted panel and a newly shipped template. Verify that acknowledgements do not wait behind the delivery queue, checkpoint edits respect shared pacing, and a failed delivery never replays an action. Verify old outbox rows still deliver and the operator can switch to classic.
- **Limits.** Add widget byte-budget and rendering checks to the build. Reuse the existing admin and outbox harnesses for state and action checks, then run `bun run check:all`. Use the disposable bot to run the live matrix against every client the admin relies on before enabling the live widget. [Admin tests](../test/admin.test.ts) · [Admin reliability tests](../test/admin-reliability.test.ts)

The screen designs, state protocol and rollout above are the proposed implementation. Telegram API availability and client behavior are verified in milestone 0.
