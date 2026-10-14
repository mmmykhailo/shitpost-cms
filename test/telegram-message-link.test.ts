import { describe, expect, test } from "bun:test";
import { buildQueueMessageLink } from "../src/domain/telegram-message-link";

describe("buildQueueMessageLink", () => {
  test("builds a private channel link from Bot API channel and message IDs", () => {
    expect(buildQueueMessageLink(-1_001_234_567_890, 901)).toBe("https://t.me/c/1234567890/901");
  });

  test.each([
    [0, 901],
    [123, 901],
    [-123_456_789, 901],
    [-100, 901],
    [-1_000_000_000_000, 901],
    [-1_000_000_000_000_000_000, 901],
    [-1_001_234_567_890, 0],
    [-1_001_234_567_890, -1],
    [-1_001_234_567_890, 1.5],
    [-1_001_234_567_890, Number.MAX_SAFE_INTEGER + 1],
  ])("rejects invalid channel/message pair %s/%s", (chatId, messageId) => {
    expect(buildQueueMessageLink(chatId, messageId)).toBeUndefined();
  });
});
