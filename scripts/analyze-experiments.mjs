import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUN_COLUMNS,
  compareWithStatic,
  coverageReport,
  flattenManifest,
  manifestProblems,
  summarizeRuns,
  toCsv,
} from "../lib/experiment-analysis.mjs";
import { positiveInteger } from "../lib/experiment-runner.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsRoot = resolve(projectRoot, process.env.RESULTS_DIR ?? "results");
const analysisDirectory = resolve(projectRoot, process.env.ANALYSIS_DIR ?? "analysis");
const expectedRepetitions = positiveInteger(process.env.EXPECTED_REPETITIONS, 5, "EXPECTED_REPETITIONS");

const SUMMARY_COLUMNS = ["deploymentPolicy", "scenario", "metric", "count", "mean", "median", "sampleStdDev", "p95", "minimum", "maximum"];
const COMPARISON_COLUMNS = ["scenario", "deploymentPolicy", "baselinePolicy", "metric", "sampleCount", "baselineSampleCount", "mean", "baselineMean", "absoluteDifference", "relativeChangePercent"];
const COVERAGE_COLUMNS = ["deploymentPolicy", "scenario", "runCount", "expectedRunCount", "missingRunCount", "repetitions", "missingRepetitions", "unexpectedRepetitions"];
const TIME_SERIES_FIELDS = [
  "timestamp",
  "queueLength",
  "activeJobs",
  "activeWorkers",
  "throughputLast60Seconds",
  "averageProcessingMs",
  "medianProcessingMs",
  "p95ProcessingMs",
  "averageQueueWaitMs",
  "averageWorkerCpuPercent",
  "averageWorkerMemoryBytes",
  "allocatedCpuCores",
  "allocatedMemoryMiB",
  "completedJobs",
  "failedJobs",
  "processedBytes",
];
const TIME_SERIES_COLUMNS = ["runId", "deploymentPolicy", "scenario", "repetition", "elapsedSeconds", ...TIME_SERIES_FIELDS];

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function discoverRuns() {
  let entries;
  try {
    entries = await readdir(resultsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Direktorij rezultata ne postoji: ${resultsRoot}`);
    throw error;
  }

  const discovered = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const directory = join(resultsRoot, entry.name);
    const manifestPath = join(directory, "manifest.json");
    try {
      discovered.push({ directory, manifest: await readJson(manifestPath) });
    } catch (error) {
      discovered.push({ directory, manifest: null, readError: error.message });
    }
  }
  return discovered;
}

async function readTimeSeries(runRecord, warnings) {
  const exportPath = join(runRecord.directory, "session-export.json");
  let session;
  try {
    session = await readJson(exportPath);
  } catch (error) {
    warnings.push({ runId: runRecord.manifest.runId, artifact: "session-export.json", reason: error.message });
    return [];
  }
  if (!Array.isArray(session.samples)) {
    warnings.push({ runId: runRecord.manifest.runId, artifact: "session-export.json", reason: "Nedostaje samples niz." });
    return [];
  }
  const startedAt = Number(session.startedAt ?? new Date(runRecord.manifest.startedAt).getTime());
  return session.samples.map((sample) => {
    const row = {
      runId: runRecord.manifest.runId,
      deploymentPolicy: runRecord.manifest.deploymentPolicy,
      scenario: runRecord.manifest.scenario,
      repetition: runRecord.manifest.repetition,
      elapsedSeconds: Number.isFinite(startedAt) && Number.isFinite(sample.timestamp)
        ? (sample.timestamp - startedAt) / 1000
        : null,
    };
    for (const field of TIME_SERIES_FIELDS) row[field] = sample[field] ?? null;
    return row;
  });
}

async function main() {
  const discovered = await discoverRuns();
  if (!discovered.length) throw new Error(`Nema izvođenja u ${resultsRoot}.`);

  const validRecords = [];
  const excludedRuns = [];
  for (const record of discovered) {
    const problems = record.readError ? [`Manifest se ne može pročitati: ${record.readError}`] : manifestProblems(record.manifest);
    if (problems.length) {
      excludedRuns.push({ directory: record.directory, runId: record.manifest?.runId ?? null, problems });
    } else {
      validRecords.push(record);
    }
  }

  const runs = validRecords.map((record) => flattenManifest(record.manifest));
  const summaries = summarizeRuns(runs);
  const comparisons = compareWithStatic(summaries);
  const coverage = coverageReport(runs, expectedRepetitions);
  const artifactWarnings = [];
  const timeSeries = (await Promise.all(validRecords.map((record) => readTimeSeries(record, artifactWarnings)))).flat();
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceDirectory: resultsRoot,
    validRunCount: runs.length,
    excludedRunCount: excludedRuns.length,
    coverage,
    excludedRuns,
    artifactWarnings,
    runs,
    summaries,
    comparisons,
  };

  await mkdir(analysisDirectory, { recursive: true });
  await Promise.all([
    writeJson(join(analysisDirectory, "report.json"), report),
    writeFile(join(analysisDirectory, "runs.csv"), toCsv(runs, RUN_COLUMNS), "utf8"),
    writeFile(join(analysisDirectory, "summary.csv"), toCsv(summaries, SUMMARY_COLUMNS), "utf8"),
    writeFile(join(analysisDirectory, "comparisons.csv"), toCsv(comparisons, COMPARISON_COLUMNS), "utf8"),
    writeFile(join(analysisDirectory, "coverage.csv"), toCsv(coverage.cells, COVERAGE_COLUMNS), "utf8"),
    writeFile(join(analysisDirectory, "timeseries.csv"), toCsv(timeSeries, TIME_SERIES_COLUMNS), "utf8"),
  ]);

  process.stdout.write(`Analiza: ${analysisDirectory}\n`);
  process.stdout.write(`Uključeno: ${runs.length}; isključeno: ${excludedRuns.length}; vremenskih uzoraka: ${timeSeries.length}\n`);
  if (coverage.gitRevisions.length > 1) process.stderr.write(`Upozorenje: rezultati koriste ${coverage.gitRevisions.length} Git revizije.\n`);
  if (!coverage.complete) process.stderr.write(`Upozorenje: matrica nije potpuna za ${expectedRepetitions} ponavljanja po kombinaciji.\n`);
  if (artifactWarnings.length) process.stderr.write(`Upozorenje: nedostaju artefakti za ${artifactWarnings.length} izvođenja.\n`);
  if (!runs.length) throw new Error("Nema validnih završenih izvođenja za analizu.");
  if (process.env.STRICT_ANALYSIS === "1" && (!coverage.complete || excludedRuns.length || artifactWarnings.length || coverage.gitRevisions.length > 1)) {
    throw new Error("STRICT_ANALYSIS=1: kontrola kvaliteta nije prošla.");
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
