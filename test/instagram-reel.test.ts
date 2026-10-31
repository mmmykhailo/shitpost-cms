import { describe, expect, test } from "bun:test";
import { parseInstagramReel } from "../src/domain/instagram-reel";
import type { MessageEntity } from "../src/types";
import { snapshotFromMessage } from "../src/domain/message";
import { validateStoredMessageSnapshot } from "../src/domain/validation";
import { snapshotFixture } from "./fixtures";

const reel = "https://www.instagram.com/reel/Ab_12-/";
const parse = (text: string, entities?: readonly MessageEntity[]) => {
  const result = parseInstagramReel(text, entities);
  if (result?.kind !== "reel") throw new Error(`Expected Reel: ${JSON.stringify(result)}`);
  return result;
};

describe("Instagram Reel input", () => {
  test("canonicalizes aliases, protocol, tracking and fragment without importing metadata", () => {
    expect(parse("http://instagram.com/reels/Ab_12-?igsh=private#tracking")).toEqual({ kind: "reel", url: reel, caption: "", entities: [] });
    expect(parse("https://INSTAGRAM.com:443/reel/Ab_12-/").url).toBe(reel);
  });

  test.each([
    "ordinary text", "https://instagram.com/p/ABC/", "https://instagram.com/stories/user/123/",
    "https://instagram.com/user/", "https://instagram.com/share/reel/ABC/", "https://instagram.com/reelish/ABC/",
    "https://instagram.com.evil.test/reel/ABC/", "https://evilinstagram.com/reel/ABC/", "https://m.instagram.com/reel/ABC/",
  ])("leaves unrelated content alone: %s", (text) => expect(parseInstagramReel(text)).toBeUndefined());

  test.each([
    "https://instagram.com/reel/", "https://instagram.com/reels", "https://instagram.com/reel/a.b/",
    "https://instagram.com/reel/é/", "https://instagram.com/reel/%41/", "https://instagram.com/reel/ABC/extra",
    "https://instagram.com:bad/reel/ABC/", "https://instagram.com/reel/ABC/../other/", "https://instagram.com/reel/../p/ABC/",
    "https://user:password@instagram.com/reel/ABC/", "https://instagram.com:8443/reel/ABC/", "ftp://instagram.com/reel/ABC/",
  ])("rejects malformed Reel candidates: %s", (text) => expect(parseInstagramReel(text)?.kind).toBe("invalid"));

  test("deduplicates all copies of the same Reel but rejects multiple Reels", () => {
    expect(parse(`${reel}\nhttp://instagram.com/reels/Ab_12-?igsh=x\ncaption`).caption).toBe("caption");
    expect(parseInstagramReel(`${reel} https://instagram.com/reel/other/`)).toEqual({ kind: "invalid", reason: "Submit one Instagram Reel per message." });
  });

  test("keeps surrounding punctuation, unrelated URLs and intentional internal spaces", () => {
    expect(parse(`  Intro (${reel}),  https://example.com\n\nend  `).caption).toBe("Intro (),  https://example.com\n\nend");
    expect(parse(`${reel} hello`).caption).toBe("hello");
    expect(parse(`hello ${reel}`).caption).toBe("hello");
  });

  test("removes URL-only lines with CRLF while retaining paragraph whitespace", () => {
    expect(parse(` \r\nFirst\n  ${reel}\r\n\nLast\n `).caption).toBe("First\n\nLast");
    expect(parse(`${reel}\n\n`).caption).toBe("");
  });

  test("uses Telegram URL entity extents and rebases UTF-16 offsets", () => {
    const text = `😀 ${reel}\nCaption ✨`;
    const entities: MessageEntity[] = [
      { type: "custom_emoji", offset: 0, length: 2, customEmojiId: "123" },
      { type: "url", offset: 3, length: reel.length },
      { type: "bold", offset: 4 + reel.length, length: 7 },
    ];
    expect(parse(text, entities)).toEqual({ kind: "reel", url: reel, caption: "😀 \nCaption ✨", entities: [entities[0]!, { type: "bold", offset: 4, length: 7 }] });
  });

  test("hidden hyperlinks keep visible labels and other formatting", () => {
    const text = "  Watch this and example  ";
    const entities: MessageEntity[] = [
      { type: "text_link", offset: 2, length: 10, url: reel },
      { type: "italic", offset: 2, length: 10 },
      { type: "text_link", offset: 17, length: 7, url: "https://example.com" },
    ];
    expect(parse(text, entities).entities).toEqual([
      { type: "italic", offset: 0, length: 10 },
      { type: "text_link", offset: 15, length: 7, url: "https://example.com" },
    ]);
    expect(parse(text, entities).caption).toBe("Watch this and example");
  });

  test("hidden links take precedence over URLs in labels", () => {
    expect(parseInstagramReel(reel, [{ type: "text_link", offset: 0, length: reel.length, url: "https://example.com" }])).toBeUndefined();
    expect(parse("https://example.com", [{ type: "text_link", offset: 0, length: 19, url: reel }]).caption).toBe("https://example.com");
    expect(parseInstagramReel("label", [{ type: "text_link", offset: 0, length: 5, url: "not a URL" }])).toBeUndefined();
  });

  test("splits formatting across removed text and drops atomic spans crossing it", () => {
    const text = `left ${reel} right`;
    expect(parseInstagramReel(text, [
      { type: "bold", offset: 0, length: text.length },
      { type: "text_link", offset: 0, length: text.length, url: "https://example.com" },
    ])).toBeUndefined(); // A containing hidden hyperlink owns its label.
    expect(parse(text, [
      { type: "bold", offset: 0, length: text.length },
      { type: "mention", offset: 0, length: text.length },
    ]).entities).toEqual([
      { type: "bold", offset: 0, length: 5 }, { type: "bold", offset: 5, length: 6 },
    ]);
  });

  test("drops malformed, empty, unknown and surrogate-splitting entities", () => {
    const text = `😀 ${reel}`;
    expect(parse(text, [
      { type: "bold", offset: -1, length: 2 }, { type: "italic", offset: 0, length: 0 },
      { type: "bold", offset: NaN, length: 2 }, { type: "bold", offset: 0, length: text.length + 1 },
      { type: "bold", offset: 1, length: 1 }, { type: "bold", offset: 0, length: 1 },
      { type: "unknown", offset: 0, length: 2 },
    ]).entities).toEqual([]);
  });

  test("does not mutate input entities", () => {
    const entity = Object.freeze({ type: "italic", offset: reel.length + 1, length: 4 });
    expect(parse(`${reel}\ntext`, Object.freeze([entity])).entities).toEqual([{ type: "italic", offset: 0, length: 4 }]);
    expect(entity.offset).toBe(reel.length + 1);
  });
});

describe("Instagram import snapshot marker", () => {
  const snapshot = (extra: Record<string, unknown>) => snapshotFromMessage({
    message_id: 1, date: 100, chat: { id: -100, type: "channel", title: "Queue" }, ...extra,
  } as never);

  test("marks new valid, invalid and hidden Reel text candidates", () => {
    expect(snapshot({ text: reel }).instagramReel).toBe(true);
    expect(snapshot({ text: "https://instagram.com/reel/invalid/path" }).instagramReel).toBe(true);
    expect(snapshot({ text: "watch", entities: [{ type: "text_link", offset: 0, length: 5, url: reel }] }).instagramReel).toBe(true);
  });

  test("ordinary text, attached captions and albums stay unmarked", () => {
    expect(snapshot({ text: "ordinary" }).instagramReel).toBeUndefined();
    expect(snapshot({ text: reel, media_group_id: "album" }).instagramReel).toBeUndefined();
    expect(snapshot({ caption: reel, video: { file_id: "file", file_unique_id: "unique", width: 100, height: 200, duration: 1 } }).instagramReel).toBeUndefined();
  });

  test("keeps legacy snapshots unmarked and validates standalone import markers", () => {
    expect(validateStoredMessageSnapshot(snapshotFixture()).instagramReel).toBeUndefined();
    expect(validateStoredMessageSnapshot(snapshotFixture({ text: reel, instagramReel: true })).instagramReel).toBe(true);
    for (const invalid of [
      { instagramReel: false }, { instagramReel: "true" },
      { instagramReel: true, contentType: "video" }, { instagramReel: true, mediaGroupId: "album" },
    ]) expect(() => validateStoredMessageSnapshot({ ...snapshotFixture(), ...invalid })).toThrow(/instagramReel/);
  });
});
