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

export const transferPreparedStep = async (input: {
  gateway: TelegramGateway;
  targetChatId: ChatId;
  sourceChatId: ChatId;
  step: TransferStep;
  /** Persist transfer_pending before each potentially visible Telegram call. */
  beforeRequest(): Promise<void> | void;
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
  const accept = async (messageId: MessageId, ordinal: number, member?: PreparedMember): Promise<void> => {
    const output: PreparedTransferOutput = { chatId: input.targetChatId, messageId, ordinal, stepKey: step.stepKey, role: member?.role ?? "content" };
    if (member !== undefined) output.sourceMemberKey = member.memberKey;
    await input.recordOutput(output);
    outputs.push(output);
  };

  if (step.grouped) {
    await input.beforeRequest();
    try {
      const transferInput = { targetChatId: input.targetChatId, sourceChatId: input.sourceChatId, messageIds: step.members.map((member) => member.messageId) };
      const ids = step.mode === "copy" ? await input.gateway.copyMessages(transferInput) : await input.gateway.forwardMessages(transferInput);
      if (ids.length !== step.members.length) throw { kind: "ambiguous_send_result", method: step.mode === "copy" ? "copyMessages" : "forwardMessages", description: `Expected ${step.members.length} outputs, received ${ids.length}`, knownOutputs: ids, requestMayHaveSucceeded: true };
      for (const [index, id] of ids.entries()) await accept(id, index, step.members[index]);
      return outputs;
    } catch (error) {
      const normalized = classifyTelegramError(error);
      for (const [index, id] of (normalized.knownOutputs ?? []).entries()) await accept(id, index);
      throw normalized;
    }
  }

  for (const [index, member] of step.members.entries()) {
    await input.beforeRequest();
    try {
      let outputId: MessageId;
      if (step.mode === "copy") {
        if (!input.gateway.copyMessage) throw new Error("Single-message copy is unavailable in this Telegram gateway");
        outputId = await input.gateway.copyMessage({ targetChatId: input.targetChatId, sourceChatId: input.sourceChatId, messageId: member.messageId });
      } else {
        const output = await input.gateway.forwardMessage({ targetChatId: input.targetChatId, sourceChatId: input.sourceChatId, messageId: member.messageId });
        if (!Number.isSafeInteger(output.message_id) || output.message_id <= 0) throw { kind: "ambiguous_send_result", method: "forwardMessage", description: "Telegram returned an invalid message ID", requestMayHaveSucceeded: true };
        outputId = asMessageId(output.message_id);
      }
      await accept(outputId, index, member);
    } catch (error) {
      throw classifyTelegramError(error, step.mode === "copy" ? "copyMessage" : "forwardMessage");
    }
  }
  return outputs;
};

