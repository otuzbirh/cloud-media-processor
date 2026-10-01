import assert from "node:assert/strict";
import { test } from "node:test";
import { freshWorkerIds, summarizeJobEvents, summarizeSession } from "../../services/shared/metrics.mjs";

test("Redis heartbeat broji samo svježe workere", async () => {
  const calls = [];
  const redis = {
    async zremrangebyscore(key, minimum, maximum) { calls.push([key, minimum, maximum]); },
    async zrange() { return ["worker-a", "worker-b"]; },
  };

  const workers = await freshWorkerIds(redis, "workers", 20_000, 15_000);
  assert.deepEqual(workers, ["worker-a", "worker-b"]);
  assert.deepEqual(calls[0], ["workers", 0, 5_000]);
});

test("operativni sažetak računa throughput, latenciju i obrađene podatke", () => {
  const now = 100_000;
  const summary = summarizeJobEvents([
    { status: "completed", finishedAt: 95_000, processingMs: 100, queueWaitMs: 20, outputBytes: 1_000 },
    { status: "completed", finishedAt: 50_000, processingMs: 300, queueWaitMs: 40, outputBytes: 2_000 },
    { status: "failed", finishedAt: 99_000, processingMs: 50, queueWaitMs: 60, outputBytes: 0 },
  ], now);

  assert.equal(summary.completedJobs, 2);
  assert.equal(summary.failedJobs, 1);
  assert.equal(summary.throughputLast60Seconds, 2);
  assert.equal(summary.averageProcessingMs, 200);
  assert.equal(summary.p95ProcessingMs, 300);
  assert.equal(summary.averageQueueWaitMs, 40);
  assert.equal(summary.processedBytes, 3_000);
});

test("sesija računa worker-minute i procijenjeni trošak alociranog kapaciteta", () => {
  const samples = [
    { timestamp: 0, activeWorkers: 2, queueLength: 5, throughputLast60Seconds: 1, averageProcessingMs: 100, p95ProcessingMs: 120 },
    { timestamp: 30_000, activeWorkers: 4, queueLength: 1, throughputLast60Seconds: 3, averageProcessingMs: 80, p95ProcessingMs: 100 },
  ];
  const summary = summarizeSession(samples, 0, 60_000, 0.5);

  assert.equal(summary.workerMinutes, 3);
  assert.equal(summary.estimatedAllocatedCapacityCost, 1.5);
  assert.equal(summary.maximumWorkers, 4);
});
