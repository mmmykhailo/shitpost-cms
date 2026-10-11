import { asChatId, type StoredMessageSnapshot } from "../src/types";

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
