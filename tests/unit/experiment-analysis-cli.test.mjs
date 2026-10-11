import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("CLI generiše skupove podataka iz validnog izvođenja", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cloud-media-analysis-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const resultsDirectory = join(temporaryRoot, "results");
  const runDirectory = join(resultsDirectory, "run-1");
  const analysisDirectory = join(temporaryRoot, "analysis");
  await mkdir(runDirectory, { recursive: true });

  const manifest = {
    runId: "run-1",
    status: "completed",
    startedAt: "2026-10-07T10:00:00.000Z",
    finishedAt: "2026-10-07T10:01:00.000Z",
    deploymentPolicy: "STATIC",
    scenario: "low",
    repetition: 1,
    sessionId: "session-1",
    source: { gitSha: "abc123" },
    summary: {
      submittedJobs: 10,
      completedJobs: 10,
      failedJobs: 0,
      incompleteJobs: 0,
      failureRate: 0,
      averageThroughput: 10,
      p95TurnaroundMs: 500,
      averageQueueWaitMs: 20,
      workerMinutes: 2,
      jobsPerWorkerMinute: 5,
    },
  };
  const session = {
    startedAt: Date.parse(manifest.startedAt),
    jobEvents: [{
      status: "completed",
      finishedAt: Date.parse(manifest.startedAt) + 4_000,
      processingMs: 400,
      queueWaitMs: 50,
      turnaroundMs: 450,
      outputBytes: 1024,
    }],
    samples: [{
      timestamp: Date.parse(manifest.startedAt) + 5_000,
      activeWorkers: 6,
      queueLength: 2,
      completedJobs: 99,
      maximumQueueWaitMs: 750,
      averageTurnaroundMs: 800,
      medianTurnaroundMs: 790,
      p95TurnaroundMs: 900,
    }],
  };
  await Promise.all([
    writeFile(join(runDirectory, "manifest.json"), JSON.stringify(manifest), "utf8"),
    writeFile(join(runDirectory, "session-export.json"), JSON.stringify(session), "utf8"),
  ]);

  const result = spawnSync(process.execPath, ["scripts/analyze-experiments.mjs"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      RESULTS_DIR: resultsDirectory,
      ANALYSIS_DIR: analysisDirectory,
      EXPECTED_REPETITIONS: "1",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(join(analysisDirectory, "report.json"), "utf8"));
  assert.equal(report.validRunCount, 1);
  assert.equal(report.runs[0].averageThroughput, 10);
  assert.match(await readFile(join(analysisDirectory, "runs.csv"), "utf8"), /run-1/);
  const timeSeries = await readFile(join(analysisDirectory, "timeseries.csv"), "utf8");
  assert.match(timeSeries, /run-1,STATIC,low,1,5/);
  assert.match(timeSeries, /maximumQueueWaitMs,averageTurnaroundMs,medianTurnaroundMs,p95TurnaroundMs/);
  const [header, firstRow] = timeSeries.trim().split("\n").map((line) => line.split(","));
  const value = (column) => firstRow[header.indexOf(column)];
  assert.equal(value("completedJobs"), "1");
  assert.equal(value("maximumQueueWaitMs"), "50");
  assert.equal(value("averageTurnaroundMs"), "450");
  assert.equal(value("medianTurnaroundMs"), "450");
  assert.equal(value("p95TurnaroundMs"), "450");
  assert.equal(value("processedBytes"), "1024");
});
