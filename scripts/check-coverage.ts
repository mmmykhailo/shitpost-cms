import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import * as ts from "typescript";

export type CoverageRecord = {
  file: string;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
};

export type CoverageFailure = {
  kind: "missing_file" | "malformed_report" | "zero_lines" | "line_threshold" | "function_threshold" | "critical_file_threshold";
  file?: string;
  message: string;
};

export type CoverageReport = {
  records: CoverageRecord[];
  files: Array<CoverageRecord & { lineRate: number; functionRate: number; critical: boolean }>;
  directories: Array<{ directory: string; linesFound: number; linesHit: number; functionsFound: number; functionsHit: number; lineRate: number; functionRate: number }>;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
  lineRate: number;
  functionRate: number;
  failures: CoverageFailure[];
};

export type CoverageEvaluationInput = {
  lcov: string;
  sourceFiles: readonly string[];
  root?: string;
  lineThreshold?: number;
  functionThreshold?: number;
  criticalFileThreshold?: number;
  criticalPrefixes?: readonly string[];
  exclusions?: Readonly<Record<string, string>>;
};

const DEFAULT_LINE_THRESHOLD = 0.9;
const DEFAULT_FUNCTION_THRESHOLD = 0.9;
const DEFAULT_CRITICAL_FILE_THRESHOLD = 0.85;
const DEFAULT_CRITICAL_PREFIXES = ["src/domain/", "src/services/", "src/db/"] as const;

const asPosix = (value: string): string => value.replaceAll("\\", "/");

const normalizedRelative = (value: string): string => {
  const result = asPosix(value).replace(/^\.\//u, "");
  return result.replace(/\/+/gu, "/");
};

const parseCounter = (value: string, label: string): number => {
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is outside the safe integer range`);
  return parsed;
};

const assertThreshold = (value: number, label: string, minimum: number): number => {
  if (!Number.isFinite(value) || value < minimum || value > 1) throw new Error(`${label} must be between ${(minimum * 100).toFixed(0)}% and 100%`);
  return value;
};

const isTypeOnlyExport = (statement: ts.Statement): boolean => {
  if (!ts.isExportDeclaration(statement)) return false;
  if (statement.isTypeOnly) return true;
  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) return false;
  return statement.exportClause.elements.length > 0 && statement.exportClause.elements.every((element) => element.isTypeOnly);
};

const isExecutableStatement = (statement: ts.Statement): boolean => {
  if (ts.isImportDeclaration(statement)) return false;
  if (ts.isImportEqualsDeclaration(statement)) return !ts.isExternalModuleReference(statement.moduleReference);
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement)) return false;
  if (isTypeOnlyExport(statement)) return false;
  if (ts.isExportDeclaration(statement)) return true;
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  return !modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
};

export const isExecutableTypeScript = (source: string, fileName = "source.ts"): boolean => {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return file.statements.some(isExecutableStatement);
};

const walk = (directory: string, root: string, output: string[]): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, root, output);
    else if (entry.isFile() && entry.name.endsWith(".ts") && isExecutableTypeScript(readFileSync(path, "utf8"), path)) {
      output.push(normalizedRelative(relative(root, path)));
    }
  }
};

export const inventorySourceFiles = (root = process.cwd()): string[] => {
  const sourceRoot = resolve(root, "src");
  if (!statSync(sourceRoot).isDirectory()) throw new Error(`Source directory does not exist: ${sourceRoot}`);
  const files: string[] = [];
  walk(sourceRoot, resolve(root), files);
  return files.sort();
};

/** Convert Bun/LCOV paths to the repository-relative form used by the inventory. */
export const normalizeCoveragePath = (rawPath: string, root = process.cwd()): string => {
  const raw = normalizedRelative(rawPath.trim().replace(/^file:\/\//u, ""));
  const repositoryRoot = asPosix(resolve(root)).replace(/\/$/u, "");
  const absoluteRoot = isAbsolute(rawPath) || /^[A-Za-z]:\//u.test(raw);
  if (absoluteRoot) {
    const absolute = asPosix(raw);
    const relativeToRoot = normalizedRelative(relative(repositoryRoot, absolute));
    if (relativeToRoot !== "" && !relativeToRoot.startsWith("../") && relativeToRoot !== "..") return relativeToRoot;
  }
  const sourceMarker = "/src/";
  const markerIndex = raw.lastIndexOf(sourceMarker);
  if (markerIndex >= 0) return raw.slice(markerIndex + 1);
  if (raw.startsWith("src/")) return raw;
  return raw;
};

const validateRecord = (record: Partial<CoverageRecord> & { file: string }): CoverageRecord => {
  if (record.linesFound === undefined || record.linesHit === undefined || record.functionsFound === undefined || record.functionsHit === undefined) {
    throw new Error(`LCOV record for ${record.file} is missing LF/LH/FNF/FNH counters`);
  }
  if (record.linesHit > record.linesFound) throw new Error(`LCOV record for ${record.file} has LH greater than LF`);
  if (record.functionsHit > record.functionsFound) throw new Error(`LCOV record for ${record.file} has FNH greater than FNF`);
  return record as CoverageRecord;
};

export const parseLcov = (text: string, root = process.cwd()): CoverageRecord[] => {
  const records: CoverageRecord[] = [];
  let current: Partial<CoverageRecord> & { file?: string } | undefined;
  const finish = (): void => {
    if (current === undefined) return;
    if (current.file === undefined) throw new Error("LCOV record is missing an SF path");
    records.push(validateRecord({ ...current, file: normalizeCoveragePath(current.file, root) }));
    current = undefined;
  };
  for (const rawLine of text.split(/\r?\n/u)) {
    if (rawLine === "") continue;
    if (rawLine.startsWith("SF:")) {
      if (current !== undefined) throw new Error("LCOV record started before end_of_record");
      const file = rawLine.slice(3).trim();
      if (file === "") throw new Error("LCOV SF record is empty");
      current = { file };
      continue;
    }
    if (rawLine === "end_of_record") {
      finish();
      continue;
    }
    if (current === undefined) continue;
    const counter = (prefix: string, key: "linesFound" | "linesHit" | "functionsFound" | "functionsHit"): void => {
      if (!rawLine.startsWith(prefix)) return;
      if (current![key] !== undefined) throw new Error(`LCOV record for ${current!.file ?? "unknown"} repeats ${prefix.slice(0, -1)}`);
      current![key] = parseCounter(rawLine.slice(prefix.length), prefix.slice(0, -1));
    };
    counter("LF:", "linesFound");
    counter("LH:", "linesHit");
    counter("FNF:", "functionsFound");
    counter("FNH:", "functionsHit");
  }
  if (current !== undefined) throw new Error(`LCOV record for ${current.file ?? "unknown"} is not terminated`);
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.file)) throw new Error(`LCOV contains duplicate records for ${record.file}`);
    seen.add(record.file);
  }
  return records;
};

const rate = (hit: number, found: number): number => found === 0 ? 1 : hit / found;

const addDirectory = (directories: Map<string, { linesFound: number; linesHit: number; functionsFound: number; functionsHit: number }>, record: CoverageRecord): void => {
  const slash = record.file.lastIndexOf("/");
  const directory = slash < 0 ? "." : record.file.slice(0, slash);
  const current = directories.get(directory) ?? { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 };
  current.linesFound += record.linesFound;
  current.linesHit += record.linesHit;
  current.functionsFound += record.functionsFound;
  current.functionsHit += record.functionsHit;
  directories.set(directory, current);
};

export const evaluateCoverage = (input: CoverageEvaluationInput): CoverageReport => {
  const root = input.root ?? process.cwd();
  const lineThreshold = assertThreshold(input.lineThreshold ?? DEFAULT_LINE_THRESHOLD, "line threshold", 0.9);
  const functionThreshold = assertThreshold(input.functionThreshold ?? DEFAULT_FUNCTION_THRESHOLD, "function threshold", 0.9);
  const criticalFileThreshold = assertThreshold(input.criticalFileThreshold ?? DEFAULT_CRITICAL_FILE_THRESHOLD, "critical-file threshold", 0.85);
  const criticalPrefixes = (input.criticalPrefixes ?? DEFAULT_CRITICAL_PREFIXES).map(normalizedRelative);
  const exclusions = new Map(Object.entries(input.exclusions ?? {}).map(([file, reason]) => [normalizedRelative(file), reason]));
  const expected = [...new Set(input.sourceFiles.map(normalizedRelative))].filter((file) => !exclusions.has(file)).sort();
  if (expected.length === 0) throw new Error("source inventory contains no executable TypeScript files");

  let records: CoverageRecord[];
  try {
    records = parseLcov(input.lcov, root);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown LCOV parse error";
    return {
      records: [], files: [], directories: [], linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0, lineRate: 0, functionRate: 0,
      failures: [{ kind: "malformed_report", message }],
    };
  }
  const byFile = new Map(records.map((record) => [record.file, record]));
  const failures: CoverageFailure[] = [];
  for (const file of expected) if (!byFile.has(file)) failures.push({ kind: "missing_file", file, message: `LCOV has no record for executable source file ${file}` });
  if (records.length > 0 && records.every((record) => record.linesFound === 0)) failures.push({ kind: "zero_lines", message: "LCOV report contains zero executable lines" });

  const files = expected.flatMap((file) => {
    const record = byFile.get(file);
    if (record === undefined) return [];
    const critical = criticalPrefixes.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix));
    const item = { ...record, lineRate: rate(record.linesHit, record.linesFound), functionRate: rate(record.functionsHit, record.functionsFound), critical };
    if (critical && item.lineRate < criticalFileThreshold) failures.push({ kind: "critical_file_threshold", file, message: `${file} line coverage ${(item.lineRate * 100).toFixed(2)}% is below ${(criticalFileThreshold * 100).toFixed(2)}%` });
    return [item];
  });
  const included = records.filter((record) => expected.includes(record.file));
  const totals = included.reduce((result, record) => ({
    linesFound: result.linesFound + record.linesFound,
    linesHit: result.linesHit + record.linesHit,
    functionsFound: result.functionsFound + record.functionsFound,
    functionsHit: result.functionsHit + record.functionsHit,
  }), { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 });
  if (totals.linesFound === 0) failures.push({ kind: "zero_lines", message: "coverage report contains no executable lines" });
  const lineRate = rate(totals.linesHit, totals.linesFound);
  const functionRate = rate(totals.functionsHit, totals.functionsFound);
  if (lineRate < lineThreshold) failures.push({ kind: "line_threshold", message: `aggregate line coverage ${(lineRate * 100).toFixed(2)}% is below ${(lineThreshold * 100).toFixed(2)}%` });
  if (functionRate < functionThreshold) failures.push({ kind: "function_threshold", message: `aggregate function coverage ${(functionRate * 100).toFixed(2)}% is below ${(functionThreshold * 100).toFixed(2)}%` });
  const directoryTotals = new Map<string, { linesFound: number; linesHit: number; functionsFound: number; functionsHit: number }>();
  for (const record of included) addDirectory(directoryTotals, record);
  const directories = [...directoryTotals.entries()].map(([directory, totalsForDirectory]) => ({ ...totalsForDirectory, directory, lineRate: rate(totalsForDirectory.linesHit, totalsForDirectory.linesFound), functionRate: rate(totalsForDirectory.functionsHit, totalsForDirectory.functionsFound) })).sort((left, right) => left.lineRate - right.lineRate || left.directory.localeCompare(right.directory));
  return { records, files: files.sort((left, right) => left.lineRate - right.lineRate || left.file.localeCompare(right.file)), directories, ...totals, lineRate, functionRate, failures };
};

export const formatCoverageReport = (report: CoverageReport): string => {
  const lines = [
    `Application line coverage: ${(report.lineRate * 100).toFixed(2)}% (${report.linesHit}/${report.linesFound})`,
    `Application function coverage: ${(report.functionRate * 100).toFixed(2)}% (${report.functionsHit}/${report.functionsFound})`,
    "Lowest-covered files:",
    ...report.files.map((file) => `  ${(file.lineRate * 100).toFixed(2)}% ${file.linesHit}/${file.linesFound} ${file.file}`),
    "Directory totals:",
    ...report.directories.map((directory) => `  ${(directory.lineRate * 100).toFixed(2)}% ${(directory.functionRate * 100).toFixed(2)}% ${directory.directory}`),
  ];
  if (report.failures.length > 0) lines.push("Failures:", ...report.failures.map((failure) => `  ${failure.message}`));
  return lines.join("\n");
};

export const runCoverageGate = (options: { root?: string; coveragePath?: string } = {}): CoverageReport => {
  const root = options.root ?? process.cwd();
  const coveragePath = resolve(root, options.coveragePath ?? process.env.COVERAGE_FILE?.trim() ?? "coverage/lcov.info");
  const report = evaluateCoverage({ lcov: readFileSync(coveragePath, "utf8"), sourceFiles: inventorySourceFiles(root), root });
  console.log(formatCoverageReport(report));
  if (report.failures.length > 0) throw new Error("coverage gate failed");
  return report;
};

if (import.meta.main) {
  try {
    runCoverageGate();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
