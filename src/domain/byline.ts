import type { MessageEntity } from "../types";

export const TEXT_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;

const forbiddenNameCharacters = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

export const normalizeBylineName = (value: string): string => value.trim().replace(/[\t\n\r ]+/gu, " ");

export const validateAlias = (value: string): string => {
  const normalized = normalizeBylineName(value);
  const codePointCount = [...normalized].length;
  if (codePointCount < 1 || codePointCount > 64) throw new Error("Alias must contain 1–64 Unicode characters");
  if (forbiddenNameCharacters.test(normalized)) throw new Error("Alias contains a forbidden control or bidi character");
  return normalized;
};

export const safeDisplayName = (value: string | undefined): string => {
  const normalized = normalizeBylineName(value ?? "");
  return normalized && !forbiddenNameCharacters.test(normalized) ? normalized : "Unknown";
};

export const validateEntities = (text: string, entities: readonly MessageEntity[] | undefined): void => {
  if (!entities) return;
  for (const entity of entities) {
    if (!Number.isSafeInteger(entity.offset) || !Number.isSafeInteger(entity.length) || entity.offset < 0 || entity.length < 0) {
      throw new Error("Stored entity has an invalid offset or length");
    }
    if (entity.offset + entity.length > text.length) throw new Error("Stored entity is outside the message text");
  }
};

export type BylineResult = {
  text: string;
  entities: readonly MessageEntity[] | undefined;
  addedText: string;
};

export const appendInlineByline = (
  original: string | undefined,
  name: string,
  limit: number,
  entities: readonly MessageEntity[] | undefined,
): BylineResult => {
  const base = original ?? "";
  validateEntities(base, entities);
  const normalized = validateAlias(name);
  const addedText = `\n\nby ${normalized}`;
  const text = `${base}${addedText}`;
  if (text.length > limit) throw new Error(`Byline exceeds Telegram limit by ${text.length - limit} UTF-16 code units`);
  return { text, entities, addedText };
};

export const separateByline = (name: string): string => `by ${validateAlias(name)}`;

export const captionLimitFor = (hasCaption: boolean): number => (hasCaption ? CAPTION_LIMIT : CAPTION_LIMIT);
