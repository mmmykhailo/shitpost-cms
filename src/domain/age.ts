const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;

const UNITS = [
  { sizeMs: MONTH_MS, singular: "month", plural: "months" },
  { sizeMs: DAY_MS, singular: "day", plural: "days" },
  { sizeMs: HOUR_MS, singular: "hour", plural: "hours" },
  { sizeMs: MINUTE_MS, singular: "minute", plural: "minutes" },
  { sizeMs: SECOND_MS, singular: "second", plural: "seconds" },
] as const;

const roundToTwoPlaces = (value: number): number => Number(value.toFixed(2));

/** Format an elapsed duration as one readable unit, without changing its numeric source. */
export const formatAge = (milliseconds: number): string => {
  if (!Number.isFinite(milliseconds)) throw new RangeError("Age must be a finite number");

  const elapsed = Math.max(0, milliseconds);
  let unitIndex = UNITS.findIndex((unit) => elapsed >= unit.sizeMs);
  if (unitIndex < 0) unitIndex = UNITS.length - 1;

  let amount = roundToTwoPlaces(elapsed / UNITS[unitIndex]!.sizeMs);
  if (unitIndex > 0 && amount * UNITS[unitIndex]!.sizeMs >= UNITS[unitIndex - 1]!.sizeMs) {
    unitIndex -= 1;
    amount = roundToTwoPlaces(elapsed / UNITS[unitIndex]!.sizeMs);
  }

  const unit = UNITS[unitIndex]!;
  return `${amount} ${amount === 1 ? unit.singular : unit.plural}`;
};
