import { describe, expect, test } from "bun:test";
import { appendInlineByline, separateByline, validateAlias } from "../src/domain/byline";
import { classifyPublicationPlan } from "../src/domain/origin-policy";
import { formatUtcSlot, nextOccurrence, occurrencesBetween, parseUtcSlot } from "../src/domain/schedule";
import { asChatId, asUserId } from "../src/types";
import { safeErrorDescription } from "../src/logger";
import { classifyTelegramError } from "../src/errors";
import { validatePublicationContract, validateStoredMessageSnapshot } from "../src/domain/validation";
import { asMessageId } from "../src/types";
import { snapshotFixture } from "./fixtures";

const userOrigin = { kind: "user" as const, userId: asUserId(7), displayName: "Ada Lovelace", username: "ada" };

describe("origin policy", () => {
  test("forwards only currently whitelisted channel origins", () => {
    const origin = { kind: "channel" as const, chatId: asChatId(-1001), title: "Source" };
    expect(classifyPublicationPlan({ origin, contentType: "text", channelIsWhitelisted: true })).toEqual({ kind: "forward", reason: "whitelisted_channel" });
    expect(classifyPublicationPlan({ origin, contentType: "text", channelIsWhitelisted: false })).toEqual({ kind: "copy", reason: "unlisted_channel" });
  });

  test("uses independent aliases for identifiable and exact-name hidden users", () => {
    expect(classifyPublicationPlan({ origin: userOrigin, contentType: "text", channelIsWhitelisted: false, alias: "The Analyst" })).toEqual({ kind: "copy_with_inline_byline", name: "The Analyst" });
    expect(classifyPublicationPlan({ origin: { kind: "hidden_user", senderUserName: "Secret Sender" }, contentType: "text", channelIsWhitelisted: false, alias: "Professor" })).toEqual({ kind: "copy_with_inline_byline", name: "Professor" });
    expect(classifyPublicationPlan({ origin: { kind: "hidden_user", senderUserName: "Secret Sender" }, contentType: "text", channelIsWhitelisted: false })).toEqual({ kind: "copy_with_inline_byline", name: "Secret Sender" });
  });

  test("uses a separate byline for captionless user content", () => {
    expect(classifyPublicationPlan({ origin: userOrigin, contentType: "sticker", channelIsWhitelisted: false })).toEqual({ kind: "copy_with_separate_byline", name: "Ada Lovelace" });
    expect(classifyPublicationPlan({ origin: { kind: "absent" }, contentType: "sticker", channelIsWhitelisted: false })).toEqual({ kind: "copy", reason: "direct_queue_post" });
  });
});

describe("bylines", () => {
  test("preserve existing entities and use plain text", () => {
    const entities = [{ type: "bold", offset: 0, length: 3 }];
    const result = appendInlineByline("hey", "A\tName", 4096, entities);
    expect(result.text).toBe("hey\n\nby A Name");
    expect(result.entities).toBe(entities);
  });

  test("reject overflow and unsafe aliases", () => {
    expect(() => appendInlineByline("x".repeat(4095), "A", 4096, undefined)).toThrow(/exceeds/);
    expect(() => validateAlias("bad\u202Ename")).toThrow(/forbidden/);
    expect(separateByline("  Name  ")).toBe("by Name");
  });
});

describe("UTC slots", () => {
  test("parses and formats exact UTC slots", () => {
    expect(parseUtcSlot("08:05")).toBe(485);
    expect(formatUtcSlot(485)).toBe("08:05 UTC");
    expect(() => parseUtcSlot("8:05")).toThrow();
  });

  test("does not burst missed occurrences", () => {
    const now = Date.parse("2026-10-04T12:00:00Z");
    const slots = [60, 720, 1439];
    expect(nextOccurrence(now, slots)).toBe(Date.parse("2026-10-04T23:59:00Z"));
    expect(occurrencesBetween(Date.parse("2026-10-03T00:00:00Z"), now, slots)).toHaveLength(5);
  });
});

describe("error boundaries", () => {
  test("redacts Telegram bot tokens with URL-safe characters", () => {
    expect(safeErrorDescription(new Error("request failed for 123456789:AAaa_bb-ccddeeff00112233445566778899"))).toBe("request failed for [redacted]");
  });

  test("classifies Telegram's ordinary age-limit deletion response", () => {
    expect(classifyTelegramError(new Error("Bad Request: message can't be deleted for everyone")).kind).toBe("telegram_age_limit");
  });

  test("classifies Telegram descriptions at the boundary", () => {
    const cases = [
      [new Error("Too Many Requests: retry later"), "rate_limited"],
      [new Error("Bad Request: message to delete not found"), "source_missing"],
      [new Error("Bad Request: message to copy not found"), "source_missing"],
      [new Error("Bad Request: message to forward not found"), "source_missing"],
      [new Error("Bad Request: message to edit not found"), "source_missing"],
      [new Error("Bad Request: message_id_invalid"), "unknown_permanent"],
      [new Error("Bad Request: the message can't be forwarded"), "content_protected"],
      [new Error("Forbidden: not enough rights"), "permission_denied"],
      [new Error("Bad Request: chat not found"), "destination_unavailable"],
      [new Error("Bad Request: message is too long"), "invalid_content_or_entities"],
      [new Error("Bad Request: unsupported paid media"), "unsupported_content"],
      [Object.assign(new Error("server failed"), { error_code: 500 }), "transient_server"],
      [new Error("fetch failed: socket reset"), "transient_network"],
    ] as const;
    for (const [error, kind] of cases) expect(classifyTelegramError(error).kind).toBe(kind);
    expect(classifyTelegramError(new Error("forbidden"), "deleteMessages").method).toBe("deleteMessages");
  });

  test("rejects malformed stored booleans and incomplete contracts", () => {
    expect(() => validateStoredMessageSnapshot({ ...snapshotFixture(), messageId: asMessageId(10), hasReplyMarkup: "false" })).toThrow(/hasReplyMarkup/);
    expect(() => validatePublicationContract({
      capturedLogicalStatus: "queued",
      capturedContentVersion: 1,
      capturedSourceGeneration: 0,
      sourceIds: [asMessageId(10)],
      policy: { kind: "copy_with_inline_byline", name: "Ada" },
      expectedTransferredMessageCount: 1,
      expectedOutputMessageCount: 1,
      requiresInlineEdit: true,
      requiresSeparateByline: false,
    })).toThrow(/bylineText/);
  });
});
