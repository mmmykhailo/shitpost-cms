import type { AttributionDescriptor } from "../types";

export type CreditEditDecision = "preserve_bot_ownership" | "admin_override" | "no_bot_credit";
export type BotAttribution = Extract<AttributionDescriptor, { ownership: "bot" }>;

export const botInlineAttribution = (
  base: string,
  generatedText: string,
  memberKey: string,
  placement: "inline_text" | "inline_caption",
  revision: number,
): BotAttribution => ({
  ownership: "bot",
  placement,
  memberKey,
  generatedText,
  generatedStartUtf16: base.length,
  generatedLengthUtf16: generatedText.length,
  appliedNicknameRevision: revision,
});

/** Preserve ownership only while the exact generated suffix remains untouched. */
export const inspectInlineCreditEdit = (
  attribution: AttributionDescriptor,
  latestText: string | undefined,
): { decision: CreditEditDecision; attribution: AttributionDescriptor } => {
  if (attribution.ownership !== "bot" || (attribution.placement !== "inline_text" && attribution.placement !== "inline_caption")) {
    return { decision: "no_bot_credit", attribution };
  }
  if (latestText?.endsWith(attribution.generatedText)) {
    const start = latestText.length - attribution.generatedText.length;
    return {
      decision: "preserve_bot_ownership",
      attribution: { ...attribution, generatedStartUtf16: start, generatedLengthUtf16: attribution.generatedText.length },
    };
  }
  return { decision: "admin_override", attribution: { ownership: "admin", previousMemberKey: attribution.memberKey } };
};

export const attributionNeedsRefresh = (attribution: AttributionDescriptor, wantedRevision: number): boolean =>
  attribution.ownership === "bot" && attribution.appliedNicknameRevision !== wantedRevision;

/** Hidden sender names are exact keys: callers must never trim or Unicode-normalize them. */
export const hiddenSenderKey = (senderName: string): string => senderName;
