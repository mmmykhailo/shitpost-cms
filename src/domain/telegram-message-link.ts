const CHANNEL_ID_OFFSET = 1_000_000_000_000;

/** Build a private Telegram channel message link from validated Bot API IDs. */
export const buildQueueMessageLink = (chatId: number, messageId: number): string | undefined => {
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId) || messageId <= 0) return undefined;
  if (chatId >= 0 || !String(chatId).startsWith("-100")) return undefined;

  const channelId = -chatId - CHANNEL_ID_OFFSET;
  if (!Number.isSafeInteger(channelId) || channelId <= 0) return undefined;

  return `https://t.me/c/${channelId}/${messageId}`;
};
