import { safeDisplayName } from "./byline";
import type { ContentType, PublicationPlan, SemanticOrigin } from "../types";

const inlineCaptionTypes = new Set<ContentType>([
  "photo",
  "video",
  "animation",
  "audio",
  "document",
  "voice",
]);

const separateBylineTypes = new Set<ContentType>([
  "sticker",
  "video_note",
  "contact",
  "location",
  "venue",
  "dice",
  "poll",
  "game",
]);

export const isInlineCaptionContent = (contentType: ContentType): boolean => inlineCaptionTypes.has(contentType);
export const isSeparateBylineContent = (contentType: ContentType): boolean => separateBylineTypes.has(contentType);

export const displayNameForOrigin = (origin: SemanticOrigin, alias?: string): string | undefined => {
  switch (origin.kind) {
    case "user": return safeDisplayName(alias ?? origin.displayName);
    case "hidden_user": return safeDisplayName(origin.senderUserName);
    case "channel":
    case "chat":
    case "absent":
      return undefined;
    case "unknown":
      return undefined;
    default: {
      const exhaustive: never = origin;
      return exhaustive;
    }
  }
};

export const classifyPublicationPlan = (input: {
  origin: SemanticOrigin;
  contentType: ContentType;
  channelIsWhitelisted: boolean;
  alias?: string;
}): PublicationPlan => {
  const { origin, contentType } = input;
  if (contentType === "paid_media" || contentType === "giveaway" || contentType === "service" || contentType === "unknown") {
    return { kind: "blocked", reason: "unsupported_content" };
  }
  switch (origin.kind) {
    case "channel":
      return input.channelIsWhitelisted
        ? { kind: "forward", reason: "whitelisted_channel" }
        : { kind: "copy", reason: "unlisted_channel" };
    case "user":
    case "hidden_user": {
      const name = displayNameForOrigin(origin, input.alias) ?? "Unknown";
      if (contentType === "text" || isInlineCaptionContent(contentType)) return { kind: "copy_with_inline_byline", name };
      if (isSeparateBylineContent(contentType)) return { kind: "copy_with_separate_byline", name };
      return { kind: "blocked", reason: "unsupported_content" };
    }
    case "chat": return { kind: "copy", reason: "chat_origin" };
    case "absent": return { kind: "copy", reason: "direct_queue_post" };
    case "unknown": return { kind: "blocked", reason: "unknown_origin" };
    default: {
      const exhaustive: never = origin;
      return exhaustive;
    }
  }
};
