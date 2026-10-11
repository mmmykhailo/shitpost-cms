import type { Clock } from "./types";

export class FakeClock implements Clock {
  constructor(private current: number) {}

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }

  sleep(milliseconds: number): Promise<void> {
    this.advance(milliseconds);
    return Promise.resolve();
  }
}
