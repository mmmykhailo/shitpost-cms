import { describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import { createTelegramGateway } from "../src/telegram";
import { asChatId, asMessageId } from "../src/types";

const source = { targetChatId: asChatId(-200), sourceChatId: asChatId(-100), messageIds: [asMessageId(10)] };

const rejected = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the gateway call to reject");
};

describe("grammY/Bun compatibility spike", () => {
  test("the selected grammY API exposes the required typed methods", () => {
    const gateway = createTelegramGateway({} as Api, asChatId(1));
    expect(gateway.forwardMessages).toBeFunction();
    expect(gateway.copyMessages).toBeFunction();
    expect(gateway.deleteMessages).toBeFunction();
    expect(gateway.editText).toBeFunction();
    expect(gateway.editCaption).toBeFunction();
  });

  test("normalizes copyMessages response objects to numeric IDs", async () => {
    const deleted: number[][] = [];
    const api = {
      copyMessages: async () => [{ message_id: 701 }],
      deleteMessages: async (_chatId: unknown, messageIds: number[]) => { deleted.push(messageIds); return true; },
    } as unknown as Api;
    const gateway = createTelegramGateway(api, asChatId(1));

    const ids = await gateway.copyMessages(source);

    expect(ids).toEqual([asMessageId(701)]);
    expect(ids.every((id) => typeof id === "number")).toBe(true);
    await gateway.deleteMessages(source.targetChatId, ids);
    expect(deleted).toEqual([[701]]);
  });

  test("normalizes forwardMessages response objects in Telegram order", async () => {
    const deleted: number[][] = [];
    const api = {
      forwardMessages: async () => [{ message_id: 801 }, { message_id: 802 }],
      deleteMessages: async (_chatId: unknown, messageIds: number[]) => { deleted.push(messageIds); return true; },
    } as unknown as Api;
    const gateway = createTelegramGateway(api, asChatId(1));

    const ids = await gateway.forwardMessages({ ...source, messageIds: [asMessageId(10), asMessageId(11)] });

    expect(ids).toEqual([asMessageId(801), asMessageId(802)]);
    expect(ids.every((id) => typeof id === "number")).toBe(true);
    await gateway.deleteMessages(source.targetChatId, ids);
    expect(deleted).toEqual([[801, 802]]);
  });

  test.each([
    ["malformed object", { unexpected: true }],
    ["missing field", {}],
    ["fractional ID", { message_id: 12.5 }],
    ["zero ID", { message_id: 0 }],
  ])("classifies a %s transfer response as ambiguous", async (_label, response) => {
    const api = { copyMessages: async () => [response] } as unknown as Api;
    const gateway = createTelegramGateway(api, asChatId(1));

    const error = await rejected(() => gateway.copyMessages(source));

    expect(error).toMatchObject({ kind: "ambiguous_send_result", method: "copyMessages" });
    expect((error as { description: string }).description).not.toContain("message_id");
  });

  test("rejects invalid deletion IDs before calling Telegram", async () => {
    let calls = 0;
    const api = { deleteMessages: async () => { calls += 1; return true; } } as unknown as Api;
    const gateway = createTelegramGateway(api, asChatId(1));

    const error = await rejected(() => gateway.deleteMessages(source.targetChatId, [{} as unknown as ReturnType<typeof asMessageId>]));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("positive safe integer");
    expect(calls).toBe(0);
  });
});
