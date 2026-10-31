# Instagram Reels queue import

Status: implemented locally on 2026-10-31 using the existing Bun runtime and no additional runtime dependencies. This document records the design and acceptance criteria. Live Instagram access and real Telegram playback remain unverified; no deployment was performed.

Implementation notes: candidate opt-in is stored as `instagramReel` on newly observed text snapshots, and the versioned `importVideo` action extends the existing preparation contract. Retry counts and deadlines reuse durable preparation operations rather than introducing a new table or migration. Accepted upload request IDs are retained as output evidence even across an edit collision or a crash before output persistence. Unknown upload echoes are quarantined using the captured caption, media type, target chat and bounded request time; known output IDs provide exact correlation. Temporary files use a per-database namespace cleared before the first import after singleton startup.

## 1. User-visible behavior

When a text message containing an Instagram Reel URL reaches the configured queue channel, prepare a native Telegram video in place of the text submission. Keep the same logical queue item and queue order. Publish the prepared video through the existing publisher.

- Use only text supplied in the Telegram message as the video caption. Remove the Reel URL, including its tracking query. Preserve the rest of the description and its supported formatting.
- Never use, persist, log, or embed Instagram descriptions, titles, usernames, or author metadata. Extraction may encounter that data internally; it must not cross the downloader adapter boundary. Do not create metadata or description sidecar files.
- Apply existing Telegram author/nickname rules to the video. Forwarded identifiable and hidden users receive the existing `by <name>` caption suffix; direct queue posts, channel origins, and chat origins retain their existing no-byline behavior. Never derive a byline from the Instagram account, queue channel signature, or bot account.
- Replace the queue source only after the video and final caption have been accepted and durably recorded. On failure, retain the original submission and show an actionable queue issue. Never publish the URL text as a fallback.
- After successful preparation, ordinary queue editing, nickname refresh, renewal, scheduling, manual publishing, deletion, and recovery work on the prepared Telegram video. Instagram is no longer needed for publishing or renewal.

Example, for a forwarded user whose current nickname is Alex:

```text
Telegram submission:
this is us on Monday
https://www.instagram.com/reel/ABC123/?igsh=tracking

Prepared post: downloaded video, with caption:
this is us on Monday

by Alex
```

A link-only forwarded user submission has only the generated credit as visible caption content. A link-only direct queue post has no caption. Do not append another credit at publication time.

## 2. Downloader examples and recommendation

These are implementation references, not evidence that downloads currently succeed from our production host. Repository documentation, dependency manifests, and the selected TypeScript extractor/downloader source were inspected; no live Instagram or Telegram download was performed.

| Project | Documented approach | Useful lesson |
| --- | --- | --- |
| [sayedmahmoud266/instagram-reel-downloader](https://github.com/sayedmahmoud266/instagram-reel-downloader) | TypeScript extractor requests Instagram pages directly and locates video URLs; downloader streams the media to disk | Closest dependency model: its manifest lists JS libraries, with no Python, media binaries, or browser automation. Use as a reference, not an adopted dependency: its CLI also handles thumbnails, optional metadata, and verbose logging we do not need |
| [Okramjimmy/Instagram-reels-downloader](https://github.com/Okramjimmy/Instagram-reels-downloader) | Next.js/TypeScript website/API; manifest includes cheerio and node-fetch | Another JS ecosystem reference; dependency declarations alone do not establish that every extraction path avoids third-party services |
| [Scusemua/telegram-media-downloader-bot](https://github.com/Scusemua/telegram-media-downloader-bot) | Python Telegram bot wrapping yt-dlp | Telegram link-to-video workflow reference only; outside our preferred runtime constraints |

Recommendation: implement a small TypeScript Instagram resolver and bounded downloader using Bun's built-in `fetch`, streams, `AbortController`, and filesystem APIs. Resolve a direct progressive MP4 containing video and any available audio, then upload that file through grammy. Prefer zero new runtime packages for extraction; add a narrowly scoped pure JS/TS parser only if structured HTML or MP4 inspection needs one. Audit its transitive dependencies and pin it in `bun.lock`.

The planned deployment adds no Python, yt-dlp, FFmpeg/ffprobe, browser installation, native addon, or WASM media toolchain. An npm wrapper that downloads or invokes those tools does not satisfy this preference. Do not introduce another Telegram bot or a third-party download API as a hidden fallback. If direct extraction fails in the compatibility spike, report that limitation before changing the dependency model.

Tradeoff: this route requires maintaining Instagram extraction as their web responses change, and cannot transcode, compress, or merge separate video/audio tracks. Select a compatible direct MP4 when available; otherwise leave an actionable queue issue. Do not silently deliver a video-only representation when the source has audio.

Upstream facts supporting the choice:

- The [TypeScript extractor source](https://github.com/sayedmahmoud266/instagram-reel-downloader/blob/main/src/instagram-api.ts) uses HTTP requests and parses page data/direct video URLs. This demonstrates the implementation pattern, not production reliability. Its broad URL validation and raw-response debug handling should not be copied into our adapter.
- [MP4Box.js](https://github.com/gpac/mp4box.js) is a JavaScript MP4 parser with file/track inspection APIs. Evaluate it if container and codec validation warrants a package; parsing is not transcoding, and Bun compatibility and bounded memory use must be verified before adoption.
- Telegram's [sendVideo](https://core.telegram.org/bots/api#sendvideo) supports multipart video upload and returns a Message. Its documented hosted Bot API upload limit is currently 50 MB, and captions allow 1024 characters after entity parsing. Use a conservative 49,000,000-byte application cap and the repository's existing caption validation.

## 3. Input contract and text handling

Initial scope: standalone text submissions with one distinct Reel. Do not interpret URLs in an attached video's caption, albums, comments/replies, or private admin commands as instructions to replace attached media. Those retain their existing behavior.

Add a pure parser in `src/domain/instagram-reel.ts`:

1. Read Telegram `url` and `text_link` entities first, with a fallback for ordinary pasted URLs in stored text. Work in UTF-16 offsets, as Telegram entities and existing byline helpers do.
2. Parse through `URL`, allow HTTPS and HTTP Instagram URLs, require the exact host `instagram.com` or `www.instagram.com`, reject credentials and nondefault ports, and allow only `/reel/<shortcode>/` and `/reels/<shortcode>/`. Validate shortcode characters as ASCII letters, digits, `_` and `-`, without assuming a fixed length. Canonicalize to `https://www.instagram.com/reel/<shortcode>/` and discard query/fragment before downloading.
3. Strip every occurrence of the selected Reel's visible URL from the caption. A `text_link` retains its visible label as description text but loses its Instagram hyperlink entity. Deduplicate repeated links to the same shortcode. Preserve unrelated URLs and text.
4. Remove URL-only lines and trim outside whitespace; preserve internal paragraphs, emoji, punctuation, and intentional text whitespace elsewhere. Rebase entities after deletions, split supported formatting spans where needed, and discard invalid/empty entities and hyperlinks spanning deleted content. Validate the resulting entities before upload. Avoid broad whitespace collapsing.
5. Multiple distinct Reels produce `needs_review`, with a request to submit one Reel per message. Never silently select the first or publish all URLs as text.
6. A Reel-shaped Instagram URL with an invalid shortcode produces an input issue. Other Instagram paths (`/p/`, stories, profiles, audio pages, and share redirect URLs) remain ordinary text in v1; document the accepted forms. Add redirect/share support only after an explicit compatibility design.

Persist an import candidate when the logical submission is created, before normal text preparation can mark it ready. Detection must run after generated-message suppression and pending-update finalization, not directly in the synchronous channel handler. For raw edits, recompute the candidate from the latest snapshot and invalidate any stale import attempt.

## 4. Integration with existing preparation

Relevant current behavior:

- `src/handlers/queue-channel.ts` and `src/services/ingestion.ts` persist updates and suppress bot-generated queue messages.
- `src/services/preparation.ts` currently treats a direct text post as an in-place preparation, classifies credits using the raw content type, and creates transformed output with copy/forward operations.
- `src/db/preparation-repository.ts` owns claims, captured versions, output evidence, generation installation, cleanup, and uncertain operations.
- `src/telegram.ts` has no video upload method. Shared Telegram admission already recognizes `sendVideo`.

Implement a dedicated Reel branch in initial preparation, before the existing in-place/direct-post and text-credit branches. Keep ordinary preparation and nickname refresh unchanged.

1. Claim through the existing preparation owner/lease and capture item ID, original Telegram semantic origin, content version, source generation, source member, canonical Reel URL, cleaned caption/entities, and nickname policy revision.
2. Extend the preparation contract with a versioned import variant describing a `download_video`/`send_video` action. Keep old V1 contracts readable for recovery. A local upload is not a `TransferStep` copying a source message; do not fabricate source Telegram IDs or overload `copyMessages`.
3. Classify the resulting content as `video` for caption limits and credit placement, using the preserved Telegram origin. Reuse `appendInlineByline`, `botInlineAttribution`, nickname revision keys, and attribution ownership. Preflight the complete caption before downloading. Overflow becomes `needs_edit`; do not truncate user text, import Instagram text, or silently move it to a separate message.
4. Download and validate the media. Recheck content version, generation, ownership, editorial freeze, and cancellation after download and immediately before Telegram dispatch. An obsolete result must never overwrite the current item.
5. Upload the video to the queue channel with its final caption/entities and notifications disabled. All imports use copy delivery for subsequent renewal/publication. Even a whitelisted forwarded channel's link submission requires this override: forwarding its original text cannot deliver the imported video. Preserve its original semantic origin and captured whitelist decision as provenance, but record the effective imported delivery mode as `copy` in the contract and prepared members.
6. Record request-attempt evidence before actual upload dispatch, then persist the returned message ID and normalized video snapshot immediately. Use the returned Message for actual media fingerprint/file identity, while explicitly retaining the original Telegram semantic origin; its native origin is absent. Do not clone the original text snapshot and relabel it as video.
7. Install the prepared video as the item's new current generation using the existing guarded result/install path. Update item content type to video, attribution, effective delivery mode, and applied nickname revision atomically with installation. Preserve logical sequence, item ID, enqueue time, and original provenance.
8. Delete the original text source only through recorded preparation cleanup. Failed cleanup retries without re-uploading. Successful source replacement must not be ingested as a second queue item.

Generated video updates can arrive before the upload response. Extend the existing preparation candidate quarantine and output correlation for `sendVideo`; do not correlate solely by caption text. Ambiguous candidates remain quarantined for recovery/admin resolution. Extend the existing request-result ID extraction to accept a full returned Message.

Existing editorial freezes need an explicit guard: an unresolved raw Reel candidate must never be adopted as ready text by the early frozen-item path. If an admin edits a raw candidate before conversion completes, invalidate its attempt and require review under the existing whole-post freeze policy. If the edit removes the Reel entirely, process the resulting ordinary text under that policy. Edits to an installed video retain the existing freeze behavior and must never trigger another download or restore a removed credit.

## 5. Downloader adapter and operational bounds

Add `src/services/instagram-downloader.ts`, injectable for tests. Keep resolution and byte download separate internally so fixture tests can cover Instagram response changes independently of transfer behavior. Return only a validated local file descriptor/path, byte size, and media facts supported by actual parsing. Do not invent codec/audio facts from an `.mp4` suffix. Expose typed failures; do not return title, description, uploader, raw response JSON/HTML, cookies, or remote signed media URLs to the rest of the bot.

- Fetch only the canonical Instagram URL and a small, fixture-tested set of direct Instagram extraction endpoints. Parse known structured response shapes; do not execute returned scripts or accept the first arbitrary MP4 string found in a page. Require the selected media to match the requested Reel. Keep page bodies bounded (initially 5 MB), allow at most three extraction requests per attempt, disable raw-response debugging, and never write description/metadata/thumbnail files.
- Stream the selected file into a bot-owned per-operation temporary directory using a fixed filename. Validate HTTPS Instagram/CDN hosts and each redirect, reject local/private targets, limit redirects to three, and keep authentication headers scoped to Instagram requests rather than forwarding them to CDN hosts. Never expose signed URLs in diagnostics or persist them for retries.
- Start with one active download and a 120-second total deadline covering resolution, transfer and validation. Propagate an abort signal to every request/stream; cancel transfers on timeout/shutdown. Enforce the 49,000,000-byte upload cap while counting streamed bytes, even without a trustworthy Content-Length, plus a 1 GB aggregate cache budget. Bound HTML/JSON parsing and inspect the completed file before upload.
- Choose an existing progressive MP4 with H.264 video and AAC audio where present. Inspect container/track metadata using pure JS/TS; reject manifests, separate-track-only media, corrupt/unsupported media, and oversized files. No transcoding, compression, or audio/video merging in v1. Do not set `supports_streaming` unless file layout has been verified. Allow genuinely silent Reels, but block known audio-track omissions rather than silently stripping sound. Record uncertain audio availability as a limitation in the compatibility spike.
- Treat cookies as an optional configured secret file for public-Reel extraction; some public media may still need an authenticated session. Read it through TS and scope its use to approved Instagram hosts. Support operator rotation, never browser-profile discovery or interactive login at runtime. Private/removed/inaccessible media produces a clear issue, without a password prompt in Telegram.
- Initially run the bounded download inside the existing asynchronous preparation worker. It can delay other preparation attempts for up to the deadline, but must not block the event loop, ingestion, scheduler, cleanup workers, or admin responses. Keep operation heartbeats active. Separate download workers are a later optimization if measured queue volume requires them.
- Clean temporary media on success, definite failure, cancellation, and startup for expired nonowned artifacts. Durable Telegram output and request evidence, not local files, determine recovery. Never copy extracted Instagram descriptions into logs, SQLite, backups, or media tags. Validate against textual metadata in source containers; reject files containing an Instagram description rather than promising metadata removal without a tested JS remuxer.

## 6. Persistence, failures, retries, and recovery

Use the existing preparation operation as the sole queue-item owner. Add durable import metadata keyed by item/content version (candidate URL, parser version, state, attempt count, retry time, sanitized failure code). Do not introduce an independent publication status enum. Existing rows have no candidate; do not retroactively convert historical waiting posts at migration time.

| Condition | Handling |
| --- | --- |
| Invalid input / multiple distinct Reels | `needs_review`; keep raw source; actionable admin issue |
| Telegram caption overflow / invalid entities | `needs_edit`; no download or upload |
| Private, removed, login-required, unsupported media | `blocked`; clear reason and existing retry/edit/delete controls |
| Extractor/network transient error or Instagram throttling | Persist bounded import retries: at most three attempts with delays of 1 minute and 5 minutes, respecting a longer upstream wait; then `blocked` |
| Too large, invalid media, unsupported codec, or separate audio/video tracks only | `blocked`; retain source; suggest uploading a suitable video manually |
| Invalid cookie configuration | Shared feature configuration issue; avoid an alert storm per item; other content remains usable |
| Telegram 429 / local admission deferral | Existing Telegram persisted cooldown/admission behavior; do not consume Instagram retry allowance |
| Telegram upload timeout or crash after dispatch without proven response | Existing uncertain preparation/admin resolution; never automatically upload again |
| Output recorded, installation/cleanup interrupted | Resume from durable output/result evidence; no new download or upload |
| Crash before any Telegram mutation is proven to have started | Safe to retry local extraction after lease recovery; guard against stale source versions |

Keep extractor errors separate from `classifyTelegramError`: an Instagram HTTP 429 must not extend the shared Telegram cooldown. Retry never bypasses a raw item's preparation/readiness gate. Other ready queue items remain publishable through the existing earliest-ready selection.

Do not suppress normal raw-source renewal while a failed import waits near Telegram's deletion deadline. An actively owned import excludes concurrent renewal; after renewal, retain candidate provenance but recapture the new source generation for the next attempt. Retention must keep unresolved import/upload ownership evidence as it does existing uncertain preparation evidence.

## 7. Implementation sequence

1. **Compatibility spike:** from the intended deployment environment and existing Bun runtime, test direct TypeScript extraction, with/without cookies as needed; test progressive MP4 availability, sound, portrait dimensions, mobile playback, and real queue upload. Record response shapes, duration/size observations, JS parser compatibility and access limitations. If requests require browser impersonation unavailable to this stack, document the blocker; do not install a browser or native TLS helper silently. Do not treat example repositories as a production reliability guarantee.
2. **Domain and schema:** implement the parser/caption transformation, versioned import contracts and validation, migration, candidate persistence, and guarded item-content/delivery changes. Ensure candidate text cannot pass readiness as an ordinary text post.
3. **Adapter and deployment:** implement the bounded TypeScript resolver/downloader, MP4 validation, config validation, cleanup, and error mapping. Update `src/config.ts`, `.env.example`, and cache/secret documentation; add a pinned pure JS/TS parser in `package.json`/`bun.lock` only if needed. Verify existing systemd writable cache paths and deployment packaging; change deployment scripts only if required for configuration/cache access. Add no OS packages, executables, native modules, browser assets, or media toolchains.
4. **Telegram and preparation:** add `sendVideo` to the gateway using grammy `InputFile`, return a validated Message receipt, and wire import preparation through existing request evidence, generated update suppression, atomic installation, cleanup and recovery. Check multipart upload timeout/cancellation behavior under the current API transformer.
5. **Admin and docs:** surface import failure details in existing issue views/actions, retain nickname refresh and editorial freezes, document accepted URL forms and cookie rotation. Update README and deployment/restore guidance. Enable only for new candidates on rollout.
6. **Validation and rollout:** run the checks below, then deploy only when separately requested. Capture which live checks were actually performed and any remaining Instagram access dependency.

## 8. Acceptance and regression checks

- Parser: query/fragment stripping; URL-only and multiline messages; URL at beginning/middle/end; repeated same Reel; multiple distinct Reels; punctuation around URLs; hidden hyperlinks; bold/italic/custom emoji/mentions spanning deletions; emoji before links; exact-host lookalikes and malformed paths; unrelated URLs retained; attached media and albums unchanged.
- Captions: only Telegram-authored description survives; extracted Instagram metadata is absent from caption, database, diagnostics, filenames and sidecars. Container fixtures with embedded descriptions are rejected. Caption and caption-plus-credit overflow fail before download, including supplementary Unicode characters.
- Attribution: identifiable user nickname/fallback; exact hidden-user nickname/fallback; no credit for direct/channel/chat origins; whitelist conversion uses imported video with copy delivery; unknown origin follows existing review rules. Credit appears exactly once through preparation, renewal and publication. Nickname changes refresh only untouched generated credit.
- Integration: one logical item retains queue order; native video output and actual media fingerprint; generated update before/after API response; upload result persisted before source deletion; no URL-text publication after any failure; edit during download/upload; raw editorial freeze; admin removal of generated credit; duplicate update and restart handling.
- Adapter: mocked HTTP responses/streams and sanitized extraction fixtures; known response-shape changes; login-required; Instagram throttling; deadline; partial/oversized files; missing/false Content-Length; bounded page bodies; disk budget; redirect/host restrictions; cookie scope; invalid codecs; separate audio/video rejection; silent vs audio video; abort propagation; sanitized diagnostics and cleanup. Offline tests must not contact Instagram.
- Recovery: crash before/after dispatch, response persistence, result completion, installation and cleanup; unknown upload outcome stays uncertain; stale content/generation never installs; renewal of a waiting raw candidate; nickname change during download; Telegram cooldown remains independent of Instagram retries.
- Deployment: existing Bun runtime alone can resolve/download/upload; no added native/binary/transitive tool dependencies; any chosen JS parser runs under Bun and its memory use is bounded; real systemd cache permissions and cleanup, cookie secrecy, feature configuration errors, rollback with legacy contracts, and backup/restore of unresolved import evidence.
- Run `bun run check:all` for implementation, including coverage and deployment gates. This planning-only change does not require runtime tests.
- Live checks: a link-only Reel and a described Reel from both user-origin and direct submissions, hidden-user nickname, sound and mobile playback, alias refresh, queue edit/freeze, renewal and destination publication. Verify the real hosted upload cap with an oversized fixture. Report unavailable credentials or inaccessible test media explicitly.
