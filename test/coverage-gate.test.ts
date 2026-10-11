import { describe, expect, test } from "bun:test";
import { evaluateCoverage, normalizeCoveragePath, parseLcov } from "../scripts/check-coverage";

const record = (file: string, linesFound: number, linesHit: number, functionsFound = 2, functionsHit = 2): string => [
  `SF:${file}`,
  `FNF:${functionsFound}`,
  `FNH:${functionsHit}`,
  `LF:${linesFound}`,
  `LH:${linesHit}`,
  "end_of_record",
].join("\n");

describe("coverage gate", () => {
  test("normalizes relative, absolute, and Windows LCOV source paths", () => {
    expect(normalizeCoveragePath("src/domain/message.ts", "/repo")).toBe("src/domain/message.ts");
    expect(normalizeCoveragePath("/repo/src/domain/message.ts", "/repo")).toBe("src/domain/message.ts");
    expect(normalizeCoveragePath("C:\\build\\repo\\src\\domain\\message.ts", "/repo")).toBe("src/domain/message.ts");
  });

  test("rejects malformed LCOV records", () => {
    expect(() => parseLcov("SF:src/a.ts\nLF:1\nLH:1\nFNF:0\nFNH:0", "/repo")).toThrow(/not terminated/);
    expect(() => parseLcov("SF:src/a.ts\nLF:1\nLH:2\nFNF:0\nFNH:0\nend_of_record", "/repo")).toThrow(/LH greater/);
    expect(() => parseLcov("SF:src/a.ts\nLF:x\nLH:0\nFNF:0\nFNH:0\nend_of_record", "/repo")).toThrow(/non-negative integer/);
  });

  test("fails closed when an executable source file is absent", () => {
    const result = evaluateCoverage({
      lcov: record("src/a.ts", 10, 10),
      sourceFiles: ["src/a.ts", "src/b.ts"],
      root: "/repo",
    });
    expect(result.failures.some((failure) => failure.kind === "missing_file" && failure.file === "src/b.ts")).toBe(true);
  });

  test("fails closed for a zero-line report", () => {
    const result = evaluateCoverage({
      lcov: record("src/a.ts", 0, 0, 0, 0),
      sourceFiles: ["src/a.ts"],
      root: "/repo",
    });
    expect(result.failures.some((failure) => failure.kind === "zero_lines")).toBe(true);
  });

  test("accepts exact threshold boundaries and enforces the critical-file floor", () => {
    const result = evaluateCoverage({
      lcov: [record("src/domain/a.ts", 20, 18), record("src/services/b.ts", 20, 17), record("src/handlers/c.ts", 10, 9)].join("\n"),
      sourceFiles: ["src/domain/a.ts", "src/services/b.ts", "src/handlers/c.ts"],
      root: "/repo",
      lineThreshold: 0.9,
      functionThreshold: 0.9,
      criticalFileThreshold: 0.85,
    });
    expect(result.lineRate).toBe(0.88);
    expect(result.failures.some((failure) => failure.kind === "line_threshold")).toBe(true);
    expect(result.failures.some((failure) => failure.kind === "critical_file_threshold")).toBe(false);
  });

  test("reports a failed function threshold independently of line coverage", () => {
    const result = evaluateCoverage({
      lcov: record("src/a.ts", 10, 10, 10, 8),
      sourceFiles: ["src/a.ts"],
      root: "/repo",
    });
    expect(result.lineRate).toBe(1);
    expect(result.failures.some((failure) => failure.kind === "function_threshold")).toBe(true);
  });

  test("supports reviewed exclusions without hiding other missing files", () => {
    const result = evaluateCoverage({
      lcov: record("src/a.ts", 10, 10),
      sourceFiles: ["src/a.ts", "src/generated.ts"],
      exclusions: { "src/generated.ts": "generated declaration bridge" },
      root: "/repo",
    });
    expect(result.failures).toEqual([]);
  });
});
