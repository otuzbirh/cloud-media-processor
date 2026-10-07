import { DEPLOYMENT_POLICIES, EXPERIMENT_SCENARIOS } from "./experiment-runner.mjs";

export const ANALYSIS_METRICS = [
  "durationMs",
  "submittedJobs",
  "completedJobs",
  "failedJobs",
  "incompleteJobs",
  "failureRate",
  "averageThroughput",
  "averageProcessingMs",
  "medianProcessingMs",
  "p95ProcessingMs",
  "averageQueueWaitMs",
  "maximumQueueWaitMs",
  "averageTurnaroundMs",
  "medianTurnaroundMs",
  "p95TurnaroundMs",
  "minimumWorkers",
  "averageWorkers",
  "maximumWorkers",
  "workerMinutes",
  "cpuRequestCoreMinutes",
  "memoryRequestMiBMinutes",
  "estimatedAllocatedCapacityCost",
  "averageWorkerCpuPercent",
  "maximumWorkerCpuPercent",
  "averageWorkerMemoryMiB",
  "maximumWorkerMemoryMiB",
  "averageCapacityUtilizationPercent",
  "idleCapacityPercent",
  "jobsPerWorkerMinute",
  "processedMiBPerWorkerMinute",
  "scalingActions",
  "scalingOscillations",
  "scaleUpReactionMs",
  "inputBytes",
  "outputBytes",
];

export const RUN_COLUMNS = [
  "runId",
  "startedAt",
  "finishedAt",
  "deploymentPolicy",
  "scenario",
  "repetition",
  "gitSha",
  "sessionId",
  ...ANALYSIS_METRICS,
];

const REQUIRED_SUMMARY_METRICS = [
  "submittedJobs",
  "completedJobs",
  "failedJobs",
  "incompleteJobs",
  "failureRate",
  "averageThroughput",
  "p95TurnaroundMs",
  "averageQueueWaitMs",
  "workerMinutes",
  "jobsPerWorkerMinute",
];

const finiteNumbers = (values) => values.filter((value) => typeof value === "number" && Number.isFinite(value));

export function mean(values) {
  const numbers = finiteNumbers(values);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

export function median(values) {
  const numbers = finiteNumbers(values).sort((left, right) => left - right);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

export function percentile(values, percentileValue) {
  const numbers = finiteNumbers(values).sort((left, right) => left - right);
  if (!numbers.length) return null;
  const index = Math.max(0, Math.ceil((percentileValue / 100) * numbers.length) - 1);
  return numbers[Math.min(numbers.length - 1, index)];
}

export function sampleStandardDeviation(values) {
  const numbers = finiteNumbers(values);
  if (numbers.length < 2) return null;
  const average = mean(numbers);
  const squaredDifferenceSum = numbers.reduce((sum, value) => sum + ((value - average) ** 2), 0);
  return Math.sqrt(squaredDifferenceSum / (numbers.length - 1));
}

export function descriptiveStatistics(values) {
  const numbers = finiteNumbers(values);
  return {
    count: numbers.length,
    mean: mean(numbers),
    median: median(numbers),
    sampleStdDev: sampleStandardDeviation(numbers),
    p95: percentile(numbers, 95),
    minimum: numbers.length ? Math.min(...numbers) : null,
    maximum: numbers.length ? Math.max(...numbers) : null,
  };
}

export function manifestProblems(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== "object") return ["Manifest nije JSON objekt."];
  if (manifest.status !== "completed") problems.push(`Status je ${manifest.status ?? "nepoznat"}, ne completed.`);
  if (!manifest.runId) problems.push("Nedostaje runId.");
  if (!DEPLOYMENT_POLICIES.has(manifest.deploymentPolicy)) problems.push("Deployment politika nije podržana.");
  if (!EXPERIMENT_SCENARIOS.has(manifest.scenario)) problems.push("Scenario nije podržan.");
  if (!Number.isInteger(manifest.repetition) || manifest.repetition <= 0) problems.push("Repetition nije pozitivan cijeli broj.");
  if (!manifest.source?.gitSha) problems.push("Nedostaje Git revizija.");
  if (!manifest.summary || typeof manifest.summary !== "object") problems.push("Nedostaje summary.");
  const missingMetrics = REQUIRED_SUMMARY_METRICS.filter((metric) => !Number.isFinite(manifest.summary?.[metric]));
  if (missingMetrics.length) problems.push(`Nedostaju ključne metrike: ${missingMetrics.join(", ")}.`);
  if (!Number.isFinite(manifest.summary?.submittedJobs) || manifest.summary.submittedJobs <= 0) problems.push("Nema poslanih poslova.");
  if (manifest.summary?.incompleteJobs !== 0) problems.push("Postoje nedovršeni poslovi.");
  return problems;
}

export function flattenManifest(manifest) {
  const row = {
    runId: manifest.runId,
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    deploymentPolicy: manifest.deploymentPolicy,
    scenario: manifest.scenario,
    repetition: manifest.repetition,
    gitSha: manifest.source?.gitSha ?? null,
    sessionId: manifest.sessionId ?? null,
  };
  for (const metric of ANALYSIS_METRICS) row[metric] = manifest.summary?.[metric] ?? null;
  return row;
}

export function summarizeRuns(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.deploymentPolicy}\u0000${run.scenario}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }

  const rows = [];
  for (const groupRuns of groups.values()) {
    for (const metric of ANALYSIS_METRICS) {
      rows.push({
        deploymentPolicy: groupRuns[0].deploymentPolicy,
        scenario: groupRuns[0].scenario,
        metric,
        ...descriptiveStatistics(groupRuns.map((run) => run[metric])),
      });
    }
  }
  return rows.sort((left, right) => (
    left.scenario.localeCompare(right.scenario)
    || left.deploymentPolicy.localeCompare(right.deploymentPolicy)
    || left.metric.localeCompare(right.metric)
  ));
}

export function compareWithStatic(summaryRows) {
  const lookup = new Map(summaryRows.map((row) => [`${row.scenario}\u0000${row.deploymentPolicy}\u0000${row.metric}`, row]));
  return summaryRows
    .filter((row) => row.deploymentPolicy !== "STATIC")
    .map((row) => {
      const baseline = lookup.get(`${row.scenario}\u0000STATIC\u0000${row.metric}`);
      if (!baseline || baseline.mean === null || row.mean === null) return null;
      const absoluteDifference = row.mean - baseline.mean;
      return {
        scenario: row.scenario,
        deploymentPolicy: row.deploymentPolicy,
        baselinePolicy: "STATIC",
        metric: row.metric,
        sampleCount: row.count,
        baselineSampleCount: baseline.count,
        mean: row.mean,
        baselineMean: baseline.mean,
        absoluteDifference,
        relativeChangePercent: baseline.mean === 0 ? null : (absoluteDifference / baseline.mean) * 100,
      };
    })
    .filter(Boolean);
}

export function coverageReport(runs, expectedRepetitions) {
  const policies = [...DEPLOYMENT_POLICIES];
  const scenarios = [...EXPERIMENT_SCENARIOS];
  const cells = [];
  const duplicates = [];

  for (const deploymentPolicy of policies) {
    for (const scenario of scenarios) {
      const matching = runs.filter((run) => run.deploymentPolicy === deploymentPolicy && run.scenario === scenario);
      const repetitions = new Map();
      const expectedNumbers = Array.from({ length: expectedRepetitions }, (_, index) => index + 1);
      for (const run of matching) repetitions.set(run.repetition, (repetitions.get(run.repetition) ?? 0) + 1);
      for (const [repetition, count] of repetitions) {
        if (count > 1) duplicates.push({ deploymentPolicy, scenario, repetition, count });
      }
      const actualNumbers = [...repetitions.keys()].sort((left, right) => left - right);
      const missingRepetitions = expectedNumbers.filter((repetition) => !repetitions.has(repetition));
      const unexpectedRepetitions = actualNumbers.filter((repetition) => repetition > expectedRepetitions);
      cells.push({
        deploymentPolicy,
        scenario,
        runCount: matching.length,
        expectedRunCount: expectedRepetitions,
        missingRunCount: missingRepetitions.length,
        repetitions: actualNumbers,
        missingRepetitions,
        unexpectedRepetitions,
      });
    }
  }

  return {
    complete: cells.every((cell) => cell.missingRepetitions.length === 0 && cell.unexpectedRepetitions.length === 0) && duplicates.length === 0,
    expectedRepetitions,
    cells,
    duplicates,
    gitRevisions: [...new Set(runs.map((run) => run.gitSha).filter(Boolean))].sort(),
  };
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("|") : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvValue(row[column])).join(","));
  return `${lines.join("\n")}\n`;
}
