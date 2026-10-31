import type { MessageEntity } from "../types";

export const INSTAGRAM_UPLOAD_TIMEOUT_MS = 120_000;

export type InstagramReelInput =
  | { kind: "invalid"; reason: string }
  | { kind: "reel"; url: string; caption: string; entities: readonly MessageEntity[] };

type Link = { start: number; end: number; url: string; hidden: boolean; entity?: MessageEntity };
const formatting = new Set(["bold", "italic", "underline", "strikethrough", "spoiler", "code", "pre", "blockquote", "expandable_blockquote"]);
const atomic = new Set(["mention", "hashtag", "cashtag", "bot_command", "url", "email", "phone_number", "text_link", "text_mention", "custom_emoji"]);

function boundary(text: string, offset: number): boolean {
  return offset === 0 || offset === text.length || !(text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff);
}

function validEntity(text: string, entity: MessageEntity): boolean {
  return Number.isSafeInteger(entity.offset) && Number.isSafeInteger(entity.length) && entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= text.length && boundary(text, entity.offset) && boundary(text, entity.offset + entity.length);
}

function reelUrl(value: string): string | false | undefined {
  let url: URL;
  try { url = new URL(value); } catch {
    return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/@]*@)?(?:www\.)?instagram\.com(?::[^/]*)?\/reels?(?:\/|$)/iu.test(value) ? false : undefined;
  }
  if (url.hostname !== "instagram.com" && url.hostname !== "www.instagram.com") return undefined;
  const literalPath = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+(\/[^?#]*)/u.exec(value)?.[1];
  if (!/^\/reels?(?:\/|$)/u.test(url.pathname) && !/^\/reels?(?:\/|$)/u.test(literalPath ?? "")) return undefined;
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port) return false;
  // Validate the literal path as well: URL normalizes dot segments and backslashes.
  const path = /^\/reels?\/([A-Za-z0-9_-]+)\/?$/u.exec(literalPath ?? "");
  return path ? `https://www.instagram.com/reel/${path[1]}/` : false;
}

/** Detect a single Reel and preserve only the Telegram-authored caption (UTF-16 offsets). */
export function parseInstagramReel(text: string, entities: readonly MessageEntity[] = []): InstagramReelInput | undefined {
  const valid = entities.filter((entity) => validEntity(text, entity));
  const links: Link[] = [];
  for (const entity of valid) {
    if (entity.type === "url" || (entity.type === "text_link" && entity.url)) {
      links.push({ start: entity.offset, end: entity.offset + entity.length, url: entity.type === "text_link" ? entity.url! : text.slice(entity.offset, entity.offset + entity.length), hidden: entity.type === "text_link", entity });
    }
  }
  // Entity ranges take precedence, including hidden links whose labels resemble URLs.
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+/gu)) {
    const start = match.index;
    const value = match[0].replace(/[.,!?;:)\]}]+$/u, "");
    const end = start + value.length;
    if (!links.some((link) => start < link.end && end > link.start)) links.push({ start, end, url: value, hidden: false });
  }
  const selected: Link[] = [];
  const urls = new Set<string>();
  for (const link of links) {
    const url = reelUrl(link.url);
    if (url === false) return { kind: "invalid", reason: "Invalid Instagram Reel URL. Use /reel/<shortcode>/ or /reels/<shortcode>/." };
    if (url) { urls.add(url); selected.push(link); }
  }
  if (urls.size === 0) return undefined;
  if (urls.size > 1) return { kind: "invalid", reason: "Submit one Instagram Reel per message." };

  const deleted = new Uint8Array(text.length);
  const unlinked = new Set(selected.flatMap((link) => link.entity ? [link.entity] : []));
  for (const link of selected) if (!link.hidden) deleted.fill(1, link.start, link.end);
  // Remove a whole URL-only line, but retain intentional existing blank paragraphs.
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    if (selected.some((link) => !link.hidden && link.start >= start && link.end <= end)
      && match[0].split("").every((character, index) => /\s/u.test(character) || deleted[start + index] === 1)) deleted.fill(1, start, end);
  }
  let first = 0;
  let last = text.length;
  while (first < last && (deleted[first] || /\s/u.test(text[first]!))) deleted[first++] = 1;
  while (last > first && (deleted[last - 1] || /\s/u.test(text[last - 1]!))) deleted[--last] = 1;
  const offsets = new Uint32Array(text.length + 1);
  const characters: string[] = [];
  for (let index = 0; index < text.length; index++) {
    if (!deleted[index]) characters.push(text[index]!);
    offsets[index + 1] = characters.length;
  }
  const resultEntities: MessageEntity[] = [];
  for (const entity of valid) {
    if (unlinked.has(entity)) continue;
    const end = entity.offset + entity.length;
    const split = formatting.has(entity.type);
    if (!split && (!atomic.has(entity.type) || deleted.subarray(entity.offset, end).some(Boolean))) continue;
    let start = entity.offset;
    while (start < end) {
      while (start < end && deleted[start]) start++;
      let stop = start;
      while (stop < end && !deleted[stop]) stop++;
      if (stop > start) resultEntities.push({ ...entity, offset: offsets[start]!, length: offsets[stop]! - offsets[start]! });
      start = stop;
    }
  }
  return { kind: "reel", url: [...urls][0]!, caption: characters.join(""), entities: resultEntities };
}
