import { afterEach, describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelegramGateway } from "../src/telegram";
import { createDatabase } from "../src/db/database";
import { createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createPublicationService } from "../src/services/publisher";
import { createFakeClock } from "../src/clock";
import { createLogger } from "../src/logger";
import { asChatId, asMessageId } from "../src/types";
import { snapshotFixture } from "./fixtures";

type TransferCall = { method: "copyMessages" | "forwardMessages"; sourceIds: number[] };
type Harness = { directory: string; close(): void };

const resources: Harness[] = [];

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

const variants = [
  { name: "copied single", method: "copyMessages" as const, sourceIds: [10], destinationIds: [701], origin: { kind: "absent" as const }, album: false },
  { name: "forwarded single", method: "forwardMessages" as const, sourceIds: [20], destinationIds: [801], origin: { kind: "channel" as const, chatId: asChatId(-300), title: "Whitelisted" }, album: false },
  { name: "copied album", method: "copyMessages" as const, sourceIds: [30, 32], destinationIds: [901, 902], origin: { kind: "absent" as const }, album: true },
  { name: "forwarded album", method: "forwardMessages" as const, sourceIds: [40, 42], destinationIds: [951, 952], origin: { kind: "channel" as const, chatId: asChatId(-400), title: "Whitelisted" }, album: true },
] as const;

describe("publication service through the grammY adapter", () => {
  for (const variant of variants) test(`publishes a ${variant.name} with numeric ordered output IDs`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "queuebot-publication-adapter-"));
    const database = createDatabase(join(directory, "bot.sqlite"));
    resources.push({ directory, close: database.close });
    const transferCalls: TransferCall[] = [];
    const deleted: number[][] = [];
    const transfer = async (method: "copyMessages" | "forwardMessages", sourceIds: number[]) => {
      transferCalls.push({ method, sourceIds: [...sourceIds] });
      return variant.destinationIds.map((messageId) => ({ message_id: messageId }));
    };
    const api = {
      copyMessages: async (_target: unknown, _source: unknown, sourceIds: number[]) => transfer("copyMessages", sourceIds),
      forwardMessages: async (_target: unknown, _source: unknown, sourceIds: number[]) => transfer("forwardMessages", sourceIds),
      deleteMessages: async (_chatId: unknown, messageIds: number[]) => { deleted.push([...messageIds]); return true; },
    } as unknown as Api;
    const gateway = createTelegramGateway(api, asChatId(999));
    const queue = createQueueRepository(database);
    const policy = createPolicyRepository(database);
    if (variant.origin.kind === "channel") policy.upsertChannel(variant.origin.chatId, "source", variant.origin.title, 1, 1);
    const clock = createFakeClock(10_000);
    const service = createPublicationService({
      queue,
      policy,
      gateway,
      queueChannelId: asChatId(-100),
      targetChannelId: asChatId(-200),
      clock,
      logger: createLogger("error"),
      operationId: () => `adapter-${variant.name}`,
    });

    const first = snapshotFixture({ messageId: asMessageId(variant.sourceIds[0]!), origin: variant.origin, ...(variant.album ? { mediaGroupId: `album-${variant.name}` } : {}) });
    queue.observeQueueSnapshot(first, 1_000);
    if (variant.album) {
      queue.addAlbumMember(1, snapshotFixture({ messageId: asMessageId(variant.sourceIds[1]!), ordinal: 1, mediaGroupId: `album-${variant.name}`, origin: variant.origin }), 1_001);
      queue.finalizeAlbums(12_000);
    }

    const result = await service.publishNext("manual_publish");

    expect(result.kind).toBe("published");
    expect(transferCalls).toEqual([{ method: variant.method, sourceIds: [...variant.sourceIds] }]);
    expect(deleted).toEqual([[...variant.sourceIds]]);
    expect(queue.findItemById(1)?.status).toBe("done");
    expect(queue.findItemById(1)?.destinationMessageIds).toEqual(variant.destinationIds.map(asMessageId));
    const row = database.raw.query("SELECT destination_message_ids_json FROM queue_items WHERE id = 1").get() as { destination_message_ids_json: string };
    expect(JSON.parse(row.destination_message_ids_json)).toEqual(variant.destinationIds);
    const outputs = database.raw.query("SELECT telegram_message_id, ordinal FROM operation_outputs WHERE operation_id = ? AND kind = 'destination' ORDER BY ordinal").all(`adapter-${variant.name}`) as Array<{ telegram_message_id: number; ordinal: number }>;
    expect(outputs).toEqual(variant.destinationIds.map((telegramMessageId, ordinal) => ({ telegram_message_id: telegramMessageId, ordinal })));
    expect(outputs.every((output) => Number.isInteger(output.telegram_message_id))).toBe(true);
    expect(queue.getHead()).toBeUndefined();
    expect((await service.publishNext("manual_publish")).kind).toBe("empty");
  });
});
