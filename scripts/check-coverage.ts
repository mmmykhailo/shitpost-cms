type CoverageRecord = { file: string; linesFound?: number; linesHit?: number };

const coveragePath = process.env.COVERAGE_FILE?.trim() || "coverage/lcov.info";
const thresholdRaw = process.env.COVERAGE_THRESHOLD?.trim() || "0.90";
const threshold = Number(thresholdRaw);
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("COVERAGE_THRESHOLD must be a number between 0 and 1");

const records: CoverageRecord[] = [];
let current: CoverageRecord | undefined;
for (const line of await Bun.file(coveragePath).text().then((value) => value.split("\n"))) {
  if (line.startsWith("SF:")) {
    current = { file: line.slice(3) };
    records.push(current);
  } else if (current !== undefined && line.startsWith("LF:")) {
    current.linesFound = Number(line.slice(3));
  } else if (current !== undefined && line.startsWith("LH:")) {
    current.linesHit = Number(line.slice(3));
  } else if (line === "end_of_record") {
    current = undefined;
  }
}

const inDeploymentSafetyScope = (file: string): boolean => file.startsWith("src/domain/") || file.startsWith("src/services/") || file.startsWith("src/db/");
const scoped = records.filter((record) => inDeploymentSafetyScope(record.file));
const linesFound = scoped.reduce((total, record) => total + (record.linesFound ?? 0), 0);
const linesHit = scoped.reduce((total, record) => total + (record.linesHit ?? 0), 0);
if (scoped.length === 0 || linesFound === 0) throw new Error("coverage report contains no domain, service, or database records");

const rate = linesHit / linesFound;
console.log(`Deployment safety-scope line coverage: ${(rate * 100).toFixed(2)}% (${linesHit}/${linesFound}), required ${(threshold * 100).toFixed(2)}%`);
if (rate < threshold) process.exit(1);
