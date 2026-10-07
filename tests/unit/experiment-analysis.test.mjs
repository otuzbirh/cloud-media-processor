import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareWithStatic,
  coverageReport,
  descriptiveStatistics,
  flattenManifest,
  manifestProblems,
  summarizeRuns,
  toCsv,
} from "../../lib/experiment-analysis.mjs";

function manifest(overrides = {}) {
  return {
    runId: "run-1",
    status: "completed",
    startedAt: "2026-10-07T10:00:00.000Z",
    finishedAt: "2026-10-07T10:05:00.000Z",
    deploymentPolicy: "STATIC",
    scenario: "low",
    repetition: 1,
    source: { gitSha: "abc123" },
    summary: {
      submittedJobs: 10,
      completedJobs: 10,
      failedJobs: 0,
      incompleteJobs: 0,
      failureRate: 0,
      averageThroughput: 2,
      p95TurnaroundMs: 100,
      averageQueueWaitMs: 10,
      workerMinutes: 5,
      jobsPerWorkerMinute: 2,
    },
    ...overrides,
  };
}

test("računa deskriptivnu statistiku između ponavljanja", () => {
  assert.deepEqual(descriptiveStatistics([1, 2, 3, 4]), {
    count: 4,
    mean: 2.5,
    median: 2.5,
    sampleStdDev: Math.sqrt(5 / 3),
    p95: 4,
    minimum: 1,
    maximum: 4,
  });
  assert.equal(descriptiveStatistics([5]).sampleStdDev, null);
});

test("validira i poravnava manifest izvođenja", () => {
  const valid = manifest();
  assert.deepEqual(manifestProblems(valid), []);
  assert.equal(flattenManifest(valid).averageThroughput, 2);
  assert.match(manifestProblems(manifest({ status: "failed" }))[0], /Status/);
  assert.ok(manifestProblems(manifest({ summary: { ...valid.summary, incompleteJobs: 1 } })).some((problem) => /nedovršeni/.test(problem)));
});

test("agregira politike i računa promjenu prema STATIC osnovi", () => {
  const runs = [
    flattenManifest(manifest({ runId: "s1", repetition: 1, summary: { ...manifest().summary, averageThroughput: 10 } })),
    flattenManifest(manifest({ runId: "s2", repetition: 2, summary: { ...manifest().summary, averageThroughput: 14 } })),
    flattenManifest(manifest({ runId: "k1", deploymentPolicy: "QUEUE_KEDA", summary: { ...manifest().summary, averageThroughput: 15 } })),
  ];
  const summaries = summarizeRuns(runs);
  const staticThroughput = summaries.find((row) => row.deploymentPolicy === "STATIC" && row.metric === "averageThroughput");
  assert.equal(staticThroughput.mean, 12);
  const comparison = compareWithStatic(summaries).find((row) => row.metric === "averageThroughput");
  assert.equal(comparison.absoluteDifference, 3);
  assert.equal(comparison.relativeChangePercent, 25);
});

test("izvještava pokrivenost, duplikate i Git revizije", () => {
  const runs = [
    flattenManifest(manifest()),
    flattenManifest(manifest({ runId: "run-2" })),
  ];
  const report = coverageReport(runs, 2);
  assert.equal(report.complete, false);
  assert.deepEqual(report.gitRevisions, ["abc123"]);
  assert.deepEqual(report.duplicates[0], { deploymentPolicy: "STATIC", scenario: "low", repetition: 1, count: 2 });
});

test("višak ponavljanja ne skriva nedostajući redni broj", () => {
  const runs = [
    flattenManifest(manifest()),
    flattenManifest(manifest({ runId: "run-3", repetition: 3 })),
  ];
  const cell = coverageReport(runs, 2).cells.find((item) => item.deploymentPolicy === "STATIC" && item.scenario === "low");
  assert.deepEqual(cell.missingRepetitions, [2]);
  assert.deepEqual(cell.unexpectedRepetitions, [3]);
});

test("CSV escapira zarez i navodnike", () => {
  assert.equal(toCsv([{ name: 'test, "jedan"', value: 2 }], ["name", "value"]), 'name,value\n"test, ""jedan""",2\n');
});
