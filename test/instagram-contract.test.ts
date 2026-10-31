import { describe, expect, test } from "bun:test";
import { StoredDataValidationError, validatePreparationContractV1 } from "../src/domain/validation";
import { asMessageId, asUserId, type PreparationContractV1 } from "../src/types";
import { snapshotFixture } from "./fixtures";

const reel = "https://www.instagram.com/reel/Ab_12-/";
const importedContract = (): PreparationContractV1 => {
  const originalOrigin = { kind: "user" as const, userId: asUserId(42), displayName: "Alex" };
  return {
    version: 1, kind: "prepare", itemId: 12, capturedContentVersion: 3, capturedSourceGeneration: 2,
    originalOrigin, deliveryMode: "copy", targetNicknameRevision: 7, targetNicknameKey: "user:42", targetName: "Alex",
    capturedMembers: [{ memberKey: "raw:1", messageId: asMessageId(1), role: "content", deliveryMode: "copy", snapshot: snapshotFixture({ text: `😀 hi\n${reel}`, origin: originalOrigin }) }],
    steps: [],
    attribution: { ownership: "bot", placement: "inline_caption", memberKey: "raw:1", generatedText: "\n\nby Alex", generatedStartUtf16: 5, generatedLengthUtf16: 9, appliedNicknameRevision: 7 },
    importVideo: { version: 1, kind: "instagram_reel", url: reel, caption: "😀 hi\n\nby Alex", captionEntities: [
      { type: "custom_emoji", offset: 0, length: 2, customEmojiId: "123" },
      { type: "bold", offset: 3, length: 2 },
    ] },
  };
};

describe("durable Instagram preparation contracts", () => {
  test("preserves import URL, Telegram caption, entities, attribution, source and policy revision through JSON", () => {
    const contract = importedContract();
    expect(validatePreparationContractV1(JSON.parse(JSON.stringify(contract)))).toEqual(contract);
    expect(validatePreparationContractV1(validatePreparationContractV1(contract))).toEqual(contract);
  });

  test("preserves canonical /p/ video URLs in persisted contracts", () => {
    const contract = importedContract();
    contract.importVideo!.url = "https://www.instagram.com/p/Deu_SjmxMEi/";
    expect(validatePreparationContractV1(JSON.parse(JSON.stringify(contract)))).toEqual(contract);
  });

  test("retains ordinary legacy preparation contracts without an import discriminator", () => {
    const { importVideo: _import, ...legacy } = importedContract();
    const contract: PreparationContractV1 = {
      ...legacy, steps: [{ stepKey: "copy-source", mode: "copy", grouped: false, members: legacy.capturedMembers }],
    };
    expect(validatePreparationContractV1(JSON.parse(JSON.stringify(contract)))).toEqual(contract);
    expect(validatePreparationContractV1(contract).importVideo).toBeUndefined();
  });

  test.each([{ version: 2 }, { version: "1" }, { kind: "instagram_reel" }, { kind: "publish" }])("rejects unsupported outer discriminators %j", (overrides) => {
    expect(() => validatePreparationContractV1({ ...importedContract(), ...overrides })).toThrow(StoredDataValidationError);
  });

  test.each([{ version: 2 }, { version: "1" }, { kind: "instagram_video" }, { kind: undefined }])("rejects unsupported nested import discriminators %j", (overrides) => {
    const contract = importedContract();
    expect(() => validatePreparationContractV1({ ...contract, importVideo: { ...contract.importVideo, ...overrides } })).toThrow(StoredDataValidationError);
  });

  test.each([
    "https://www.instagram.com/p/ABC", "https://www.instagram.com/p/ABC/?tracking=x", "https://www.instagram.com/p/ABC/extra/",
    "http://www.instagram.com/reel/Ab_12-/", "https://instagram.com/reel/Ab_12-/", "https://www.instagram.com/reels/Ab_12-/",
    "https://www.instagram.com/reel/Ab_12-", `${reel}?tracking=secret`, `${reel}#fragment`,
    "https://user:pass@www.instagram.com/reel/Ab_12-/", "https://www.instagram.com:8443/reel/Ab_12-/",
    "https://www.instagram.com/reel/%41/", "https://www.instagram.com/reel/é/", "https://www.instagram.com.evil.test/reel/Ab_12-/",
  ])("rejects noncanonical persisted URL %s", (url) => {
    const contract = importedContract();
    expect(() => validatePreparationContractV1({ ...contract, importVideo: { ...contract.importVideo, url } })).toThrow(/Instagram import contract/);
  });

  test("rejects forwarding, refresh imports and multiple source members", () => {
    const contract = importedContract();
    const second = { ...contract.capturedMembers[0]!, memberKey: "raw:2", messageId: asMessageId(2), snapshot: snapshotFixture({ messageId: asMessageId(2) }) };
    for (const overrides of [
      { deliveryMode: "forward" }, { kind: "refresh" }, { capturedMembers: [...contract.capturedMembers, second] },
    ]) expect(() => validatePreparationContractV1({ ...contract, ...overrides })).toThrow(/Instagram import contract/);
  });

  test("rejects import contracts carrying copy steps, an attached media source or an album member", () => {
    const contract = importedContract();
    const member = contract.capturedMembers[0]!;
    for (const overrides of [
      { steps: [{ stepKey: "copy-source", mode: "copy", grouped: false, members: [member] }] },
      { capturedMembers: [{ ...member, snapshot: snapshotFixture({ contentType: "video", caption: reel }) }] },
      { capturedMembers: [{ ...member, albumKey: "album:1" }] },
    ]) expect(() => validatePreparationContractV1({ ...contract, ...overrides })).toThrow(/Instagram import contract/);
  });

  test("checks final caption limit in UTF-16 code units, including the generated credit", () => {
    const contract = importedContract();
    const atLimit = { ...contract, importVideo: { ...contract.importVideo, caption: "😀".repeat(512), captionEntities: [] } };
    expect(validatePreparationContractV1(atLimit).importVideo!.caption.length).toBe(1024);
    expect(() => validatePreparationContractV1({ ...atLimit, importVideo: { ...atLimit.importVideo, caption: "😀".repeat(513) } })).toThrow(/Instagram import contract/);
    expect(() => validatePreparationContractV1({ ...atLimit, importVideo: { ...atLimit.importVideo, caption: `${"x".repeat(1024)}\n\nby Alex` } })).toThrow(/Instagram import contract/);
  });

  test("supports a captionless direct submission", () => {
    const contract = importedContract();
    const validated = validatePreparationContractV1({ ...contract, attribution: { ownership: "none" }, importVideo: { ...contract.importVideo, caption: "", captionEntities: [] } });
    expect(validated.importVideo!.caption).toBe("");
    expect(validated.importVideo!.captionEntities).toEqual([]);
  });

  test.each([null, [], "import", { caption: 123 }, { url: 123 }].map(value => ({ value })))("rejects malformed import object %j", ({ value: override }) => {
    const contract = importedContract();
    const importVideo = override !== null && !Array.isArray(override) && typeof override === "object" ? { ...contract.importVideo, ...override } : override;
    expect(() => validatePreparationContractV1({ ...contract, importVideo })).toThrow(StoredDataValidationError);
  });

  test.each([
    "entities", [null], [{ type: 123, offset: 0, length: 1 }], [{ type: "bold", offset: -1, length: 1 }],
    [{ type: "bold", offset: 0.5, length: 1 }], [{ type: "bold", offset: 0, length: -1 }],
    [{ type: "text_link", offset: 0, length: 1, url: 123 }],
    [{ type: "text_mention", offset: 0, length: 1, user: { id: 1 } }],
  ].map(value => ({ value })))("rejects invalid entity schema %j", ({ value: captionEntities }) => {
    const contract = importedContract();
    expect(() => validatePreparationContractV1({ ...contract, importVideo: { ...contract.importVideo, captionEntities } })).toThrow(StoredDataValidationError);
  });

  test.each([
    [{ type: "bold", offset: 100, length: 1 }],
    [{ type: "bold", offset: 2, length: 100 }],
  ].map(value => ({ value })))("rejects entity ranges outside the durable caption %j", ({ value: captionEntities }) => {
    const contract = importedContract();
    expect(() => validatePreparationContractV1({ ...contract, importVideo: { ...contract.importVideo, captionEntities } })).toThrow(StoredDataValidationError);
  });
});
