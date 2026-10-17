import { asMessageId, type ChatId, type MessageId, type PreparedMember, type TransferStep } from "../types";
import { classifyTelegramError } from "../errors";
import type { TelegramGateway } from "../telegram";

export type PreparedTransferOutput = {
  chatId: ChatId;
  messageId: MessageId;
  ordinal: number;
  stepKey: string;
  role: PreparedMember["role"];
  sourceMemberKey?: string;
};

export type PreparedTransferRequest<T> = {
  method: "copyMessages" | "forwardMessages" | "copyMessage" | "forwardMessage";
  targetChatId: ChatId;
  stepKey: string;
  work: () => Promise<T>;
};

export const transferPreparedStep = async (input: {
  gateway: TelegramGateway;
  targetChatId: ChatId;
  sourceChatId: ChatId;
  step: TransferStep;
  /** Persist transfer_pending before each potentially visible Telegram call. */
  beforeRequest(): Promise<void> | void;
  /** Runs the raw mutation inside shared admission and request-evidence scope. */
  runRequest?<T>(request: PreparedTransferRequest<T>): Promise<T>;
  /** Persist each returned ID immediately. Unmapped outputs intentionally omit sourceMemberKey. */
  recordOutput(output: PreparedTransferOutput): Promise<void> | void;
}): Promise<PreparedTransferOutput[]> => {
  const { step } = input;
  if (!step.stepKey || step.members.length === 0) throw new Error("Prepared transfer step must have a key and members");
  if (step.grouped && (step.members.length < 2 || !step.members[0]?.albumKey || step.members.some((member) => member.albumKey !== step.members[0]!.albumKey || member.deliveryMode !== step.mode))) {
    throw new Error("Grouped transfer must contain one complete album with a shared delivery mode");
  }
  if (step.members.some((member) => member.deliveryMode !== step.mode)) throw new Error("Transfer step mode does not match every prepared member");
  const outputs: PreparedTransferOutput[] = [];
  const runRequest = <T>(method: PreparedTransferRequest<T>["method"], work: () => Promise<T>): Promise<T> => input.runRequest
    ? input.runRequest({ method, targetChatId: input.targetChatId, stepKey: step.stepKey, work })
    : Promise.resolve(input.beforeRequest()).then(work);
  const accept = async (messageId: MessageId, ordinal: number, member?: PreparedMember): Promise<void> => {
    const output: PreparedTransferOutput = { chatId: input.targetChatId, messageId, ordinal, stepKey: step.stepKey, role: member?.role ?? "content" };
    if (member !== undefined) output.sourceMemberKey = member.memberKey;
    await input.recordOutput(output);
    outputs.push(output);
  };

  if (step.grouped) {
    try {
      const transferInput = { targetChatId: input.targetChatId, sourceChatId: input.sourceChatId, messageIds: step.members.map((member) => member.messageId) };
      const ids = await runRequest(step.mode === "copy" ? "copyMessages" : "forwardMessages", () => step.mode === "copy" ? input.gateway.copyMessages(transferInput) : input.gateway.forwardMessages(transferInput));
      if (ids.length !== step.members.length) throw { kind: "ambiguous_send_result", method: step.mode === "copy" ? "copyMessages" : "forwardMessages", description: `Expected ${step.members.length} outputs, received ${ids.length}`, knownOutputs: ids, requestMayHaveSucceeded: true };
      const distinct = new Set<number>();
      const invalid = ids.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0 || distinct.has(Number(id)) || !distinct.add(Number(id)));
      if (invalid) {
        const evidence = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && Number(id) > 0).map(Number))].map((id) => asMessageId(id));
        for (const [index, id] of evidence.entries()) await accept(id, index);
        throw { kind: "ambiguous_send_result", method: step.mode === "copy" ? "copyMessages" : "forwardMessages", description: "Transfer returned invalid or duplicate output IDs", knownOutputs: [], requestMayHaveSucceeded: true };
      }
      for (const [index, id] of ids.entries()) await accept(id, index, step.members[index]);
      return outputs;
    } catch (error) {
      const normalized = classifyTelegramError(error);
      for (const [index, id] of (normalized.knownOutputs ?? []).entries()) await accept(id, index);
      throw normalized;
    }
  }

  for (const [index, member] of step.members.entries()) {
    try {
      let outputId: MessageId;
      if (step.mode === "copy") {
        if (!input.gateway.copyMessage) throw new Error("Single-message copy is unavailable in this Telegram gateway");
        outputId = await runRequest("copyMessage", () => input.gateway.copyMessage!({ targetChatId: input.targetChatId, sourceChatId: input.sourceChatId, messageId: member.messageId }));
        if (!Number.isSafeInteger(outputId) || Number(outputId) <= 0) throw { kind: "ambiguous_send_result", method: "copyMessage", description: "Telegram returned an invalid message ID", requestMayHaveSucceeded: true };
      } else {
        const output = await runRequest("forwardMessage", () => input.gateway.forwardMessage({ targetChatId: input.targetChatId, sourceChatId: input.sourceChatId, messageId: member.messageId }));
        if (!Number.isSafeInteger(output.message_id) || output.message_id <= 0) throw { kind: "ambiguous_send_result", method: "forwardMessage", description: "Telegram returned an invalid message ID", requestMayHaveSucceeded: true };
        outputId = asMessageId(output.message_id);
      }
      await accept(outputId, index, member);
    } catch (error) {
      const normalized = classifyTelegramError(error, step.mode === "copy" ? "copyMessage" : "forwardMessage");
      for (const [knownIndex, id] of (normalized.knownOutputs ?? []).entries()) {
        if (Number.isSafeInteger(id) && id > 0) await accept(id, knownIndex);
      }
      throw normalized;
    }
  }
  return outputs;
};
