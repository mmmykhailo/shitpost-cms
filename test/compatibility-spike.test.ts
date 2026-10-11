import { describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import { createTelegramGateway } from "../src/telegram";
import { asChatId, asMessageId } from "../src/types";

describe("grammY/Bun compatibility spike", () => {
  test("the selected grammY API exposes the required typed methods", () => {
    const gateway = createTelegramGateway({} as Api, asChatId(1));
    expect(gateway.forwardMessages).toBeFunction();
    expect(gateway.copyMessages).toBeFunction();
    expect(gateway.deleteMessages).toBeFunction();
    expect(gateway.editText).toBeFunction();
    expect(gateway.editCaption).toBeFunction();
    expect(asMessageId(1)).toBe(asMessageId(1));
  });
});
