import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createGeneratedMessageRepository, createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createRenewalService } from "../src/services/renewal";
import { createFakeClock } from "../src/clock";
import { createLogger } from "../src/logger";
import { asChatId, asMessageId, asUserId } from "../src/types";
import type { TelegramGateway } from "../src/telegram";
import { snapshotFixture } from "./fixtures";

const resources: Array<{ directory: string; close(): void }> = [];

const gatewayWithDeleteFailure = () => {
  let nextId = 900;
  let fail = true;
  const calls: string[] = [];
  const gateway: TelegramGateway = {
    getBotIdentity: async () => ({ id: asUserId(1) }),
    getChat: async () => ({ id: asChatId(-100), type: "channel" }),
    getBotMembership: async () => ({ status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: true }),
    forwardMessages: async ({ messageIds }) => { calls.push("forward"); return messageIds.map(() => asMessageId(nextId++)); },
    copyMessages: async ({ messageIds }) => { calls.push("copy"); return messageIds.map(() => asMessageId(nextId++)); },
    forwardMessage: async () => { throw new Error("unused"); },
    editText: async () => {},
    editCaption: async () => {},
    sendText: async () => asMessageId(nextId++),
    deleteMessages: async () => {
      calls.push("delete");
      if (fail) { fail = false; throw { kind: "transient_network", description: "old source temporarily unavailable" }; }
    },
    sendAdminMessage: async () => asMessageId(nextId++),
    editAdminMessage: async () => {},
    answerCallbackQuery: async () => {},
  };
  return { gateway, calls };
};

const open = (gateway: TelegramGateway) => {
  const directory = mkdtempSync(join(tmpdir(), "queuebot-renewal-"));
  const database = createDatabase(join(directory, "bot.sqlite"));
  const queue = createQueueRepository(database);
  const clock = createFakeClock(100_000);
  const renewal = createRenewalService({
    queue,
    policy: createPolicyRepository(database),
    generated: createGeneratedMessageRepository(database),
    gateway,
    queueChannelId: asChatId(-100),
    clock,
    logger: createLogger("error"),
    operationId: (() => { let i = 0; return () => `renew-${++i}`; })(),
  });
  resources.push({ directory, close: database.close });
  return { queue, renewal };
};

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("renewal service", () => {
  test("copies originless queue posts into a new generation and cleans the old source", async () => {
    const fake = gatewayWithDeleteFailure();
    const { queue, renewal } = open(fake.gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(50), telegramDate: 0, origin: { kind: "absent" } }), 1);
    const result = await renewal.renewNext(36_000);
    expect(result.kind).toBe("renewed");
    expect(queue.findItemById(1)?.sourceGeneration).toBe(1);
    expect(queue.currentSourceIds(1)).toEqual([asMessageId(900)]);
    expect(fake.calls).toEqual(["copy", "delete"]);
    expect(queue.findItemById(1)?.status).toBe("queued");
    expect(queue.findItemById(1)?.maintenanceStatus).toBe("idle");
  });

  test("re-forwards semantic channel origins", async () => {
    const fake = gatewayWithDeleteFailure();
    const { queue, renewal } = open(fake.gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(51), telegramDate: 0, origin: { kind: "channel", chatId: asChatId(-300) } }), 1);
    const result = await renewal.renewNext(36_000);
    expect(result.kind).toBe("renewed");
    expect(fake.calls[0]).toBe("forward");
  });
});
