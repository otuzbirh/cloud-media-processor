import assert from "node:assert/strict";
import { test } from "node:test";
import { freshWorkerDetails, freshWorkerIds, summarizeJobEvents, summarizeSession } from "../../services/shared/metrics.mjs";

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

test("heartbeat detalji povezuju svježe workere sa CPU i memorijskim podacima", async () => {
  const redis = {
    async zremrangebyscore() {},
    async zrange() { return ["worker-a", "worker-b"]; },
    async hmget() { return [JSON.stringify({ cpuPercent: 42, memoryBytes: 1024 }), "neispravan-json"]; },
  };

  const workers = await freshWorkerDetails(redis, "heartbeats", "details", 20_000, 15_000);
  assert.deepEqual(workers[0], { id: "worker-a", cpuPercent: 42, memoryBytes: 1024 });
  assert.deepEqual(workers[1], { id: "worker-b" });
});

test("operativni sažetak računa throughput, latenciju i obrađene podatke", () => {
  const now = 100_000;
  const summary = summarizeJobEvents([
    { status: "completed", queuedAt: 94_880, finishedAt: 95_000, processingMs: 100, queueWaitMs: 20, inputBytes: 1_000, outputBytes: 1_000 },
    { status: "completed", queuedAt: 49_660, finishedAt: 50_000, processingMs: 300, queueWaitMs: 40, inputBytes: 2_000, outputBytes: 2_000 },
    { status: "failed", queuedAt: 98_890, finishedAt: 99_000, processingMs: 50, queueWaitMs: 60, inputBytes: 3_000, outputBytes: 0 },
  ], now);

  assert.equal(summary.submittedJobs, 3);
  assert.equal(summary.completedJobs, 2);
  assert.equal(summary.failedJobs, 1);
  assert.equal(summary.failureRate, 1 / 3);
  assert.equal(summary.throughputLast60Seconds, 2);
  assert.equal(summary.averageProcessingMs, 200);
  assert.equal(summary.medianProcessingMs, 100);
  assert.equal(summary.p95ProcessingMs, 300);
  assert.equal(summary.averageQueueWaitMs, 40);
  assert.equal(summary.maximumQueueWaitMs, 60);
  assert.equal(summary.averageTurnaroundMs, 230);
  assert.equal(summary.medianTurnaroundMs, 120);
  assert.equal(summary.p95TurnaroundMs, 340);
  assert.equal(summary.inputBytes, 6_000);
  assert.equal(summary.outputBytes, 3_000);
  assert.equal(summary.processedBytes, 3_000);
});

test("sesija koristi samo vlastite job događaje za performanse i volumen", () => {
  const samples = [
    { timestamp: 0, activeWorkers: 2, activeJobs: 2, queueLength: 5, throughputLast60Seconds: 100, averageProcessingMs: 99_999, medianProcessingMs: 99_999, p95ProcessingMs: 99_999, averageWorkerCpuPercent: 40, averageWorkerMemoryBytes: 100 * 1024 * 1024, workerCpuRequestMillicores: 500, workerMemoryRequestMiB: 256, completedJobs: 500, failedJobs: 100, processedBytes: 999_000_000 },
    { timestamp: 30_000, activeWorkers: 4, activeJobs: 2, queueLength: 1, throughputLast60Seconds: 200, averageProcessingMs: 88_888, medianProcessingMs: 88_888, p95ProcessingMs: 88_888, averageWorkerCpuPercent: 60, averageWorkerMemoryBytes: 120 * 1024 * 1024, workerCpuRequestMillicores: 500, workerMemoryRequestMiB: 256, completedJobs: 900, failedJobs: 200, processedBytes: 2_000_000_000 },
  ];
  const completed = Array.from({ length: 6 }, (_, index) => {
    const sequence = index + 1;
    const queuedAt = 5_000 + index * 100;
    const queueWaitMs = sequence * 10;
    const processingMs = sequence * 100;
    return {
      status: "completed",
      queuedAt,
      finishedAt: queuedAt + queueWaitMs + processingMs,
      queueWaitMs,
      processingMs,
      inputBytes: 48_000_000,
      outputBytes: 1_000_000,
    };
  });
  const failed = { status: "failed", queuedAt: 5_700, finishedAt: 5_820, queueWaitMs: 70, processingMs: 50, inputBytes: 48_000_000, outputBytes: 0 };
  const summary = summarizeSession(samples, 0, 60_000, 0.5, [...completed, failed], 8);

  assert.equal(summary.workerMinutes, 3);
  assert.equal(summary.estimatedAllocatedCapacityCost, 1.5);
  assert.equal(summary.minimumWorkers, 2);
  assert.equal(summary.maximumWorkers, 4);
  assert.equal(summary.cpuRequestCoreMinutes, 1.5);
  assert.equal(summary.memoryRequestMiBMinutes, 768);
  assert.equal(summary.submittedJobs, 8);
  assert.equal(summary.completedJobs, 6);
  assert.equal(summary.failedJobs, 1);
  assert.equal(summary.incompleteJobs, 1);
  assert.equal(summary.failureRate, 1 / 8);
  assert.equal(summary.averageThroughput, 6);
  assert.equal(summary.averageProcessingMs, 350);
  assert.equal(summary.medianProcessingMs, 300);
  assert.equal(summary.p95ProcessingMs, 600);
  assert.equal(summary.averageQueueWaitMs, 40);
  assert.equal(summary.maximumQueueWaitMs, 70);
  assert.equal(summary.averageTurnaroundMs, 385);
  assert.equal(summary.medianTurnaroundMs, 330);
  assert.equal(summary.p95TurnaroundMs, 660);
  assert.equal(summary.inputBytes, 336_000_000);
  assert.equal(summary.outputBytes, 6_000_000);
  assert.equal(summary.jobsPerWorkerMinute, 2);
  assert.equal(summary.scalingActions, 1);
  assert.equal(summary.scaleUpReactionMs, 25_000);
  assert.equal(summary.averageCapacityUtilizationPercent, 100);
  assert.equal(summary.idleCapacityPercent, 0);
});

test("sesija bez vlastitih poslova ne nasljeđuje rolling metrike", () => {
  const samples = [
    { timestamp: 0, activeWorkers: 1, queueLength: 0, averageProcessingMs: 5_000, p95ProcessingMs: 9_000, completedJobs: 50, failedJobs: 5, processedBytes: 10_000 },
  ];
  const summary = summarizeSession(samples, 0, 60_000, null, []);

  assert.equal(summary.submittedJobs, 0);
  assert.equal(summary.completedJobs, 0);
  assert.equal(summary.failedJobs, 0);
  assert.equal(summary.averageProcessingMs, 0);
  assert.equal(summary.p95ProcessingMs, 0);
  assert.equal(summary.processedBytes, 0);
});
