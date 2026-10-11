export const MINUTES_PER_DAY = 24 * 60;
export const MINUTE_MS = 60_000;

export const parseUtcSlot = (input: string): number => {
  const value = input.trim();
  const match = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.exec(value);
  if (!match) throw new Error("Slot must use exact HH:MM UTC format");
  const [hourText, minuteText] = value.split(":");
  return Number(hourText) * 60 + Number(minuteText);
};

export const formatUtcSlot = (minuteOfDay: number): string => {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= MINUTES_PER_DAY) throw new Error("Invalid minute of day");
  return `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")} UTC`;
};

export const occurrenceFor = (dayStartUtc: number, minuteOfDay: number): number => {
  if (dayStartUtc % 86_400_000 !== 0) throw new Error("dayStartUtc must be at UTC midnight");
  return dayStartUtc + minuteOfDay * MINUTE_MS;
};

export const utcDayStart = (timestamp: number): number => {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

export const nextOccurrence = (now: number, slots: readonly number[]): number | undefined => {
  if (slots.length === 0) return undefined;
  const today = utcDayStart(now);
  for (const slot of [...slots].sort((a, b) => a - b)) {
    const occurrence = occurrenceFor(today, slot);
    if (occurrence > now) return occurrence;
  }
  return occurrenceFor(today + 86_400_000, [...slots].sort((a, b) => a - b)[0]!);
};

export const occurrencesBetween = (fromExclusive: number, toInclusive: number, slots: readonly number[]): number[] => {
  if (toInclusive <= fromExclusive || slots.length === 0) return [];
  const orderedSlots = [...new Set(slots)].sort((a, b) => a - b);
  const result: number[] = [];
  for (let day = utcDayStart(fromExclusive); day <= utcDayStart(toInclusive); day += 86_400_000) {
    for (const slot of orderedSlots) {
      const occurrence = occurrenceFor(day, slot);
      if (occurrence > fromExclusive && occurrence <= toInclusive) result.push(occurrence);
    }
  }
  return result;
};

export const validateSlotCount = (slots: readonly number[], enabled: boolean): void => {
  const unique = new Set(slots);
  if (unique.size !== slots.length) throw new Error("Publication slots must be unique");
  if (slots.some((slot) => !Number.isInteger(slot) || slot < 0 || slot >= MINUTES_PER_DAY)) throw new Error("Publication slot is out of range");
  if (enabled && (slots.length < 1 || slots.length > 96)) throw new Error("Enabled scheduling requires 1–96 UTC slots");
};
