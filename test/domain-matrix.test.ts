import { describe, expect, test } from "bun:test";
import {
  appendInlineByline,
  captionLimitFor,
  normalizeBylineName,
  safeDisplayName,
  separateByline,
  validateAlias,
  validateEntities,
} from "../src/domain/byline";
import { contentTypeFromMessage, originFromMessage, snapshotFromMessage } from "../src/domain/message";
import { classifyPublicationPlan, displayNameForOrigin, isInlineCaptionContent, isSeparateBylineContent } from "../src/domain/origin-policy";
import { assertStatusTransition, isBlockingHead, sortSnapshots } from "../src/domain/queue-item";
import { formatUtcSlot, occurrenceFor, occurrencesBetween, parseUtcSlot, utcDayStart, validateSlotCount } from "../src/domain/schedule";
import {
  StoredDataValidationError,
  parseStoredMessageSnapshot,
  validateJsonPayload,
  validateOrderedMessageIds,
  validatePublicationContract,
  validateSemanticOrigin,
  validateStoredMessageSnapshot,
} from "../src/domain/validation";
import { classifyTelegramError } from "../src/errors";
import { safeErrorDescription } from "../src/logger";
import { asChatId, asMessageId, asUserId, type ContentType, type MessageEntity, type QueueItemStatus, type SemanticOrigin, type StoredMessageSnapshot } from "../src/types";
import { snapshotFixture } from "./fixtures";

const message = (extra: Record<string, unknown> = {}): unknown => ({
  message_id: 10,
  date: 100,
  chat: { id: -100, type: "channel", title: "Queue" },
  ...extra,
});

const validContract = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  capturedLogicalStatus: "queued",
  capturedContentVersion: 1,
  capturedSourceGeneration: 0,
  sourceIds: [10],
  policy: { kind: "copy", reason: "direct_queue_post" },
  expectedTransferredMessageCount: 1,
  expectedOutputMessageCount: 1,
  requiresInlineEdit: false,
  requiresSeparateByline: false,
  ...overrides,
});

const validSnapshot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...snapshotFixture(),
  ...overrides,
});

describe("Telegram message normalization matrix", () => {
  test("classifies every supported Telegram content shape", () => {
    const cases: Array<[ContentType, Record<string, unknown>]> = [
      ["text", { text: "hello" }],
      ["photo", { photo: [{ file_id: "photo" }] }],
      ["video", { video: { file_id: "video" } }],
      ["animation", { animation: { file_id: "animation" } }],
      ["audio", { audio: { file_id: "audio" } }],
      ["document", { document: { file_id: "document" } }],
      ["voice", { voice: { file_id: "voice" } }],
      ["sticker", { sticker: { file_id: "sticker" } }],
      ["video_note", { video_note: { file_id: "video-note" } }],
      ["contact", { contact: { phone_number: "1", first_name: "A" } }],
      ["location", { location: { longitude: 1, latitude: 2 } }],
      ["venue", { venue: { location: { longitude: 1, latitude: 2 }, title: "Place", address: "Street" } }],
      ["dice", { dice: { emoji: "🎲", value: 1 } }],
      ["poll", { poll: { id: "poll", question: "Q", options: [], total_voter_count: 0, is_closed: false, is_anonymous: true, type: "regular", allows_multiple_answers: false } }],
      ["game", { game: { id: "game", short_name: "game", title: "Game", description: "D" } }],
      ["paid_media", { paid_media: { star_count: 1, paid_media: [] } }],
      ["giveaway", { giveaway: { chats: [], winners_selection_date: 1, winner_count: 1 } }],
      ["giveaway", { giveaway_winners: { chats: [], winners_selection_date: 1, winner_count: 1, winners: [], unclaimed_prize_count: 0, was_refunded: false } }],
      ["service", { new_chat_title: "renamed" }],
      ["unknown", {}],
    ];
    for (const [expected, fields] of cases) expect(contentTypeFromMessage(message(fields) as never)).toBe(expected);
  });

  test("normalizes text, captions, entities, media groups, markup, and edit dates", () => {
    const result = snapshotFromMessage(message({
      entities: [{ type: "bold", offset: 0, length: 5, url: "https://example.test" }],
      caption: "caption",
      caption_entities: [{ type: "italic", offset: 0, length: 7, language: "en" }],
      photo: [{ file_id: "photo" }],
      media_group_id: "album-1",
      show_caption_above_media: true,
      reply_markup: { inline_keyboard: [] },
      edit_date: 101,
    }) as never) as StoredMessageSnapshot;
    expect(result).toMatchObject({
      messageId: asMessageId(10),
      contentType: "photo",
      mediaGroupId: "album-1",
      caption: "caption",
      showCaptionAboveMedia: true,
      editDate: 101_000,
      hasReplyMarkup: true,
    });
    expect(result.captionEntities?.[0]).toEqual({ type: "italic", offset: 0, length: 7, language: "en" });
    const textResult = snapshotFromMessage(message({
      text: "hello",
      entities: [{ type: "text_mention", offset: 0, length: 5, user: { id: 7, first_name: "Ada", last_name: "L" }, custom_emoji_id: "emoji" }],
    }) as never);
    expect(textResult.entities?.[0]).toEqual({ type: "text_mention", offset: 0, length: 5, user: { id: asUserId(7), firstName: "Ada", lastName: "L" }, customEmojiId: "emoji" });
  });

  test("preserves each semantic forward origin and handles absent origins", () => {
    const origins: Array<[SemanticOrigin, Record<string, unknown> | undefined]> = [
      [{ kind: "absent" }, undefined],
      [{ kind: "channel", chatId: asChatId(-200), title: "Channel", username: "source", authorSignature: "Editor" }, { type: "channel", chat: { id: -200, type: "channel", title: "Channel", username: "source" }, author_signature: "Editor" }],
      [{ kind: "user", userId: asUserId(7), displayName: "Ada Lovelace", username: "ada" }, { type: "user", sender_user: { id: 7, first_name: "Ada", last_name: "Lovelace", username: "ada" } }],
      [{ kind: "hidden_user", senderUserName: "Hidden Sender" }, { type: "hidden_user", sender_user_name: "Hidden Sender" }],
      [{ kind: "chat", chatId: asChatId(-300), title: "Group", username: "group" }, { type: "chat", sender_chat: { id: -300, type: "group", title: "Group", username: "group" } }],
    ];
    for (const [expected, forwardOrigin] of origins) expect(originFromMessage(message(forwardOrigin === undefined ? {} : { forward_origin: forwardOrigin }) as never)).toEqual(expected);
    expect(originFromMessage(message({ forward_origin: { type: "future_origin" } }) as never)).toEqual({ kind: "unknown", type: "[object Object]" });
  });
});

describe("byline and publication policy matrix", () => {
  test("covers Unicode normalization, display fallback, entities, and limits", () => {
    expect(normalizeBylineName("  Ada\t\nLovelace  ")).toBe("Ada Lovelace");
    expect(validateAlias("é".repeat(64))).toHaveLength(64);
    expect(safeDisplayName(undefined)).toBe("Unknown");
    expect(safeDisplayName("\u202Ehidden")).toBe("Unknown");
    expect(captionLimitFor(true)).toBe(1024);
    expect(captionLimitFor(false)).toBe(1024);
    const entities: MessageEntity[] = [{ type: "bold", offset: 0, length: 3 }];
    validateEntities("hey", entities);
    validateEntities("hey", undefined);
    expect(appendInlineByline(undefined, "A", 4096, undefined)).toEqual({ text: "\n\nby A", entities: undefined, addedText: "\n\nby A" });
    expect(separateByline("  A  ")).toBe("by A");
    for (const value of ["", " ", "a".repeat(65), "bad\u0000name", "bad\u202Ename"]) expect(() => validateAlias(value)).toThrow();
    expect(() => validateEntities("hey", [{ type: "bold", offset: -1, length: 1 }])).toThrow(/offset/);
    expect(() => validateEntities("hey", [{ type: "bold", offset: 2, length: 2 }])).toThrow(/outside/);
  });

  test("chooses inline/separate bylines and blocks unsupported content", () => {
    for (const contentType of ["photo", "video", "animation", "audio", "document", "voice"] as const) expect(isInlineCaptionContent(contentType)).toBe(true);
    for (const contentType of ["sticker", "video_note", "contact", "location", "venue", "dice", "poll", "game"] as const) expect(isSeparateBylineContent(contentType)).toBe(true);
    const user = { kind: "user" as const, userId: asUserId(7), displayName: "Ada" };
    for (const contentType of ["text", "photo", "video", "animation", "audio", "document", "voice"] as const) expect(classifyPublicationPlan({ origin: user, contentType, channelIsWhitelisted: false })).toMatchObject({ kind: "copy_with_inline_byline" });
    for (const contentType of ["sticker", "video_note", "contact", "location", "venue", "dice", "poll", "game"] as const) expect(classifyPublicationPlan({ origin: user, contentType, channelIsWhitelisted: false })).toMatchObject({ kind: "copy_with_separate_byline" });
    for (const contentType of ["paid_media", "giveaway", "service", "unknown"] as const) expect(classifyPublicationPlan({ origin: user, contentType, channelIsWhitelisted: false })).toEqual({ kind: "blocked", reason: "unsupported_content" });
    expect(displayNameForOrigin({ kind: "unknown", type: "future" })).toBeUndefined();
    expect(displayNameForOrigin({ kind: "absent" })).toBeUndefined();
    expect(displayNameForOrigin({ kind: "chat", chatId: asChatId(-1) })).toBeUndefined();
  });
});

describe("queue state and schedule boundaries", () => {
  const item = (status: QueueItemStatus, overrides: Partial<Parameters<typeof isBlockingHead>[0]> = {}): Parameters<typeof isBlockingHead>[0] => ({
    id: 1,
    logicalSequence: 1,
    queueChatId: -100,
    firstMessageId: asMessageId(1),
    contentType: "text",
    origin: { kind: "absent" },
    status,
    maintenanceStatus: "idle",
    contentVersion: 1,
    sourceGeneration: 0,
    attempts: 0,
    enqueuedAt: 1,
    physicalCreatedAt: 1,
    destinationMessageIds: [],
    ...overrides,
  });

  test("enforces the complete queue transition table and blocking rules", () => {
    const allowed: Array<[QueueItemStatus, QueueItemStatus]> = [
      ["collecting", "queued"], ["collecting", "needs_review"], ["collecting", "deleted_external"], ["collecting", "deleted"],
      ["queued", "publishing"], ["queued", "blocked"], ["queued", "needs_edit"], ["queued", "needs_review"], ["queued", "deleted"], ["queued", "deleted_external"], ["queued", "collecting"],
      ["publishing", "queued"], ["publishing", "published_cleanup_pending"], ["publishing", "uncertain_publish"], ["publishing", "blocked"], ["publishing", "needs_edit"], ["publishing", "needs_review"], ["publishing", "deleted_external"], ["publishing", "deleted"],
      ["published_cleanup_pending", "done"], ["published_cleanup_pending", "uncertain_publish"], ["published_cleanup_pending", "deleted_external"],
      ["blocked", "queued"], ["blocked", "publishing"], ["blocked", "needs_review"], ["blocked", "deleted"], ["blocked", "deleted_external"],
      ["needs_edit", "queued"], ["needs_edit", "publishing"], ["needs_edit", "deleted"], ["needs_edit", "deleted_external"],
      ["needs_review", "queued"], ["needs_review", "publishing"], ["needs_review", "deleted"], ["needs_review", "deleted_external"],
      ["uncertain_publish", "published_cleanup_pending"], ["uncertain_publish", "queued"], ["uncertain_publish", "deleted"], ["uncertain_publish", "deleted_external"],
      ["delete_blocked", "deleted"], ["delete_blocked", "deleted_external"], ["delete_blocked", "queued"],
    ];
    for (const [from, to] of allowed) expect(() => assertStatusTransition(from, to)).not.toThrow();
    for (const status of ["done", "deleted", "deleted_external"] as const) expect(() => assertStatusTransition(status, "queued")).toThrow(/Invalid/);
    expect(isBlockingHead(item("done"), 1)).toBe(false);
    expect(isBlockingHead(item("queued"), 1)).toBe(false);
    expect(isBlockingHead(item("queued", { retryNotBefore: 2 }), 1)).toBe(true);
    expect(isBlockingHead(item("queued", { retryNotBefore: 1 }), 1)).toBe(false);
    expect(isBlockingHead(item("blocked"), 1)).toBe(true);
    expect(isBlockingHead(item("queued", { maintenanceStatus: "renewing" }), 1)).toBe(true);
  });

  test("sorts snapshots immutably and handles UTC slot boundaries", () => {
    const sorted = sortSnapshots([snapshotFixture({ messageId: asMessageId(3), ordinal: 8 }), snapshotFixture({ messageId: asMessageId(1), ordinal: 8 })]);
    expect(sorted.map((snapshot) => [snapshot.messageId, snapshot.ordinal])).toEqual([[asMessageId(1), 0], [asMessageId(3), 1]]);
    const day = Date.parse("2026-10-04T00:00:00Z");
    expect(utcDayStart(Date.parse("2026-10-04T23:59:00Z"))).toBe(day);
    expect(occurrenceFor(day, 1439)).toBe(Date.parse("2026-10-04T23:59:00Z"));
    expect(occurrencesBetween(day, day + 86_400_000, [0, 1439])).toEqual([day + 1439 * 60_000, day + 86_400_000]);
    expect(() => occurrenceFor(day + 1, 0)).toThrow(/midnight/);
    expect(() => formatUtcSlot(-1)).toThrow();
    expect(() => validateSlotCount([1, 1], false)).toThrow(/unique/);
    expect(() => validateSlotCount([1440], false)).toThrow(/range/);
    expect(() => validateSlotCount([], true)).toThrow(/Enabled/);
    expect(() => validateSlotCount(Array.from({ length: 97 }, (_, index) => index), false)).toThrow(/96/);
    expect(parseUtcSlot(" 23:59 ")).toBe(1439);
  });
});

describe("stored-data validation matrix", () => {
  test("accepts every semantic origin and optional snapshot field", () => {
    const origins: unknown[] = [
      { kind: "absent" },
      { kind: "unknown", type: "future" },
      { kind: "hidden_user", senderUserName: "Hidden" },
      { kind: "channel", chatId: -200, username: "source", title: "Source", authorSignature: "Editor" },
      { kind: "chat", chatId: -300, username: "group", title: "Group" },
      { kind: "user", userId: 7, displayName: "Ada", username: "ada" },
    ];
    for (const origin of origins) expect(validateSemanticOrigin(origin)).toBeDefined();
    const snapshot = validateStoredMessageSnapshot(validSnapshot({
      origin: origins[3],
      mediaGroupId: "album",
      text: "hello",
      caption: "caption",
      editDate: 4,
      showCaptionAboveMedia: false,
      entities: [{ type: "text_link", offset: 0, length: 5, url: "https://example.test", language: "en", customEmojiId: "emoji", user: { id: 7, firstName: "Ada", lastName: "L" } }],
      captionEntities: [],
    }));
    expect(snapshot.mediaGroupId).toBe("album");
    expect(parseStoredMessageSnapshot(JSON.stringify(snapshot)).messageId).toBe(snapshot.messageId);
    expect(validateJsonPayload({ ok: true }, "payload")).toEqual({ ok: true });
  });

  test("rejects invalid stored shapes and publication contracts", () => {
    const invalidSnapshots: unknown[] = [
      null, [], { ...validSnapshot(), schemaVersion: 2 }, { ...validSnapshot(), contentType: "not-real" }, { ...validSnapshot(), hasReplyMarkup: "no" },
      { ...validSnapshot(), messageId: 0 }, { ...validSnapshot(), ordinal: -1 }, { ...validSnapshot(), origin: { kind: "user" } },
      { ...validSnapshot(), entities: "not-array" }, { ...validSnapshot(), showCaptionAboveMedia: "no" }, { ...validSnapshot(), entities: [{ type: "bold", offset: -1, length: 1 }] },
    ];
    for (const value of invalidSnapshots) expect(() => validateStoredMessageSnapshot(value)).toThrow(StoredDataValidationError);
    expect(() => parseStoredMessageSnapshot("not-json")).toThrow(/Invalid stored/);
    for (const value of [null, [], {}, [0], [1, 1], Array.from({ length: 101 }, () => 1)]) expect(() => validateOrderedMessageIds(value)).toThrow();
    expect(validateOrderedMessageIds([1, 3])).toEqual([asMessageId(1), asMessageId(3)]);
    expect(() => validateJsonPayload({ ["x".repeat(65)]: true }, "payload")).toThrow(/oversized/);

    const invalidContracts: unknown[] = [
      null,
      validContract({ sourceIds: [] }),
      validContract({ capturedLogicalStatus: "bad" }),
      validContract({ policy: {} }),
      validContract({ policy: { kind: "forward", reason: "bad" } }),
      validContract({ policy: { kind: "copy", reason: "bad" } }),
      validContract({ policy: { kind: "copy_with_inline_byline" } }),
      validContract({ policy: { kind: "blocked", reason: "bad" } }),
      validContract({ policy: { kind: "bad" } }),
      validContract({ requiresInlineEdit: "no" }),
      validContract({ requiresSeparateByline: "no" }),
      validContract({ capturedContentVersion: 0 }),
      validContract({ expectedTransferredMessageCount: 2 }),
      validContract({ expectedOutputMessageCount: 0 }),
      validContract({ requiresInlineEdit: true, requiresSeparateByline: true }),
      validContract({ policy: { kind: "copy_with_inline_byline", name: "Ada" }, bylineText: undefined }),
    ];
    for (const value of invalidContracts) expect(() => validatePublicationContract(value)).toThrow();
    expect(validatePublicationContract(validContract())).toMatchObject({ capturedLogicalStatus: "queued", sourceIds: [asMessageId(10)] });
    expect(validatePublicationContract(validContract({ policy: { kind: "copy_with_inline_byline", name: "Ada" }, bylineText: "by Ada", requiresInlineEdit: true }))).toBeDefined();
  });

  test("classifies structured and unknown Telegram failures without leaking tokens", () => {
    const values: unknown[] = [
      { error_code: 429, description: "Too many requests", parameters: { retry_after: 5 } },
      { error_code: 500, description: "server failure" },
      { error_code: 403, description: "Forbidden: not enough rights" },
      { description: "message to delete not found" },
      { description: "content is protected" },
      { description: "message is too old" },
      { description: "chat not found" },
      { description: "can't copy this content" },
      { description: "message is too long" },
      new TypeError("network timeout"),
      { unexpected: true },
    ];
    for (const value of values) expect(classifyTelegramError(value).kind).toBeDefined();
    expect(classifyTelegramError({ kind: "source_missing", description: "missing" }, "deleteMessages")).toMatchObject({ kind: "source_missing", method: "deleteMessages" });
    expect(safeErrorDescription(new Error("123456:abcdefghijklmnopqrstuvwxyz-_"))).toBe("[redacted]");
  });
});
