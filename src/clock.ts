import type { Clock } from "./types";

export type FakeClock = Clock & { advance(milliseconds: number): void };

export const createFakeClock = (initialTime: number): FakeClock => {
  let current = initialTime;
  return {
    now: () => current,
    advance: (milliseconds) => { current += milliseconds; },
    sleep: async (milliseconds) => { current += milliseconds; },
  };
};
