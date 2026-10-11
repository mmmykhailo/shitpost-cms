import { describe, expect, test } from "bun:test";
import { appendInlineByline, separateByline, validateAlias } from "../src/domain/byline";
import { classifyPublicationPlan } from "../src/domain/origin-policy";
import { formatUtcSlot, nextOccurrence, occurrencesBetween, parseUtcSlot } from "../src/domain/schedule";
import { asChatId, asUserId, type StoredMessageSnapshot } from "../src/types";

const userOrigin = { kind: "user" as const, userId: asUserId(7), displayName: "Ada Lovelace", username: "ada" };

describe("origin policy", () => {
  test("forwards only currently whitelisted channel origins", () => {
    const origin = { kind: "channel" as const, chatId: asChatId(-1001), title: "Source" };
    expect(classifyPublicationPlan({ origin, contentType: "text", channelIsWhitelisted: true })).toEqual({ kind: "forward", reason: "whitelisted_channel" });
    expect(classifyPublicationPlan({ origin, contentType: "text", channelIsWhitelisted: false })).toEqual({ kind: "copy", reason: "unlisted_channel" });
  });

  test("uses aliases for user content and never aliases hidden users", () => {
    expect(classifyPublicationPlan({ origin: userOrigin, contentType: "text", channelIsWhitelisted: false, alias: "The Analyst" })).toEqual({ kind: "copy_with_inline_byline", name: "The Analyst" });
    expect(classifyPublicationPlan({ origin: { kind: "hidden_user", senderUserName: "Secret Sender" }, contentType: "text", channelIsWhitelisted: false, alias: "Wrong person" })).toEqual({ kind: "copy_with_inline_byline", name: "Secret Sender" });
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

export const snapshotFixture = (overrides: Partial<StoredMessageSnapshot> = {}): StoredMessageSnapshot => ({
  schemaVersion: 1,
  chatId: asChatId(-100),
  messageId: 1 as StoredMessageSnapshot["messageId"],
  ordinal: 0,
  contentType: "text",
  text: "hello",
  origin: { kind: "absent" },
  telegramDate: Date.parse("2026-10-04T10:00:00Z"),
  hasReplyMarkup: false,
  ...overrides,
});
