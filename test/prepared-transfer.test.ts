import { describe, expect, test } from "bun:test";
import { asChatId, asMessageId, type PreparedMember, type TransferStep } from "../src/types";
import { transferPreparedStep } from "../src/services/prepared-transfer";
import type { TelegramGateway } from "../src/telegram";
import { snapshotFixture } from "./fixtures";

const member = (id: number, mode: "copy" | "forward" = "copy", albumKey?: string): PreparedMember => ({
  memberKey: `member:${id}`,
  messageId: asMessageId(id),
  role: "content",
  deliveryMode: mode,
  ...(albumKey === undefined ? {} : { albumKey }),
  snapshot: snapshotFixture({ messageId: asMessageId(id) }),
});

const gateway = (overrides: Partial<TelegramGateway> = {}): TelegramGateway => ({
  getBotIdentity: async () => ({ id: 1 as never }), getChat: async () => ({ id: asChatId(-1), type: "channel" }),
  getBotMembership: async () => ({ status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: true }),
  forwardMessages: async () => [asMessageId(201), asMessageId(202)], copyMessages: async () => [asMessageId(301), asMessageId(302)],
  forwardMessage: async () => ({ message_id: 401 } as never), copyMessage: async () => asMessageId(501),
  editText: async () => {}, editCaption: async () => {}, sendText: async () => asMessageId(1), deleteMessages: async () => {},
  sendAdminMessage: async () => asMessageId(1), editAdminMessage: async () => {}, answerCallbackQuery: async () => {},
  ...overrides,
});

const run = async (step: TransferStep, api: TelegramGateway) => {
  const before: number[] = [];
  const recorded: Array<{ messageId: number; sourceMemberKey?: string }> = [];
  const outputs = await transferPreparedStep({
    gateway: api, targetChatId: asChatId(-200), sourceChatId: asChatId(-100), step,
    beforeRequest: () => { before.push(1); },
    recordOutput: (output) => { recorded.push({ messageId: output.messageId, ...(output.sourceMemberKey === undefined ? {} : { sourceMemberKey: output.sourceMemberKey }) }); },
  });
  return { before, recorded, outputs };
};

describe("prepared Telegram transfer", () => {
  test("uses per-message calls for standalone members and reports exact source association", async () => {
    const calls: number[] = [];
    const result = await run({ stepKey: "body", mode: "copy", grouped: false, members: [member(10), member(11)] }, gateway({ copyMessage: async ({ messageId }) => { calls.push(messageId); return asMessageId(Number(messageId) + 100); } }));
    expect(calls).toEqual([10, 11]);
    expect(result.before).toHaveLength(2);
    expect(result.recorded).toEqual([{ messageId: 110, sourceMemberKey: "member:10" }, { messageId: 111, sourceMemberKey: "member:11" }]);
  });

  test("uses a native bulk call for a real album and keeps member order", async () => {
    const calls: number[][] = [];
    const result = await run({ stepKey: "album", mode: "forward", grouped: true, members: [member(10, "forward", "album"), member(11, "forward", "album")] }, gateway({ forwardMessages: async ({ messageIds }) => { calls.push([...messageIds]); return [asMessageId(210), asMessageId(211)]; } }));
    expect(calls).toEqual([[10, 11]]);
    expect(result.recorded).toEqual([{ messageId: 210, sourceMemberKey: "member:10" }, { messageId: 211, sourceMemberKey: "member:11" }]);
  });

  test("records known outputs from malformed album results without guessing associations", async () => {
    const recorded: Array<{ messageId: number; sourceMemberKey?: string }> = [];
    const api = gateway({ copyMessages: async () => { throw { kind: "ambiguous_send_result", method: "copyMessages", description: "partial response", knownOutputs: [asMessageId(801), asMessageId(803)], requestMayHaveSucceeded: true }; } });
    await expect(transferPreparedStep({ gateway: api, targetChatId: asChatId(-200), sourceChatId: asChatId(-100), step: { stepKey: "album", mode: "copy", grouped: true, members: [member(10, "copy", "g"), member(11, "copy", "g"), member(12, "copy", "g")] }, beforeRequest() {}, recordOutput: (output) => { recorded.push({ messageId: output.messageId, ...(output.sourceMemberKey === undefined ? {} : { sourceMemberKey: output.sourceMemberKey }) }); } })).rejects.toMatchObject({ kind: "ambiguous_send_result" });
    expect(recorded).toEqual([{ messageId: 801 }, { messageId: 803 }]);
  });

  test("rejects fake album groupings before any request", async () => {
    let sends = 0;
    await expect(run({ stepKey: "bad", mode: "copy", grouped: true, members: [member(10, "copy", "a"), member(11, "copy", "b")] }, gateway({ copyMessages: async () => { sends += 1; return []; } }))).rejects.toThrow(/complete album/);
    expect(sends).toBe(0);
  });
});
