import { describe, expect, test } from "bun:test";
import { formatAge } from "../src/domain/age";

describe("formatAge", () => {
  test.each([
    [0, "0 seconds"],
    [-1, "0 seconds"],
    [1_000, "1 second"],
    [1_234, "1.23 seconds"],
    [45_000, "45 seconds"],
    [59_999, "1 minute"],
    [60_000, "1 minute"],
    [90_000, "1.5 minutes"],
    [3_599_999, "1 hour"],
    [3_600_000, "1 hour"],
    [12_600_000, "3.5 hours"],
    [86_400_000, "1 day"],
    [247_668_018, "2.87 days"],
    [30 * 86_400_000, "1 month"],
    [36 * 86_400_000, "1.2 months"],
    [365 * 86_400_000, "12.17 months"],
  ])("formats %s ms as %s", (milliseconds, expected) => {
    expect(formatAge(milliseconds)).toBe(expected);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects non-finite age %s", (milliseconds) => {
    expect(() => formatAge(milliseconds)).toThrow(RangeError);
  });
});
