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
    { status: "completed", finishedAt: 95_000, processingMs: 100, queueWaitMs: 20, outputBytes: 1_000 },
    { status: "completed", finishedAt: 50_000, processingMs: 300, queueWaitMs: 40, outputBytes: 2_000 },
    { status: "failed", finishedAt: 99_000, processingMs: 50, queueWaitMs: 60, outputBytes: 0 },
  ], now);

  assert.equal(summary.completedJobs, 2);
  assert.equal(summary.failedJobs, 1);
  assert.equal(summary.throughputLast60Seconds, 2);
  assert.equal(summary.averageProcessingMs, 200);
  assert.equal(summary.medianProcessingMs, 100);
  assert.equal(summary.p95ProcessingMs, 300);
  assert.equal(summary.averageQueueWaitMs, 40);
  assert.equal(summary.processedBytes, 3_000);
});

test("sesija računa worker-minute i procijenjeni trošak alociranog kapaciteta", () => {
  const samples = [
    { timestamp: 0, activeWorkers: 2, activeJobs: 2, queueLength: 5, throughputLast60Seconds: 1, averageProcessingMs: 100, medianProcessingMs: 90, p95ProcessingMs: 120, averageWorkerCpuPercent: 40, averageWorkerMemoryBytes: 100 * 1024 * 1024, workerCpuRequestMillicores: 500, workerMemoryRequestMiB: 256, completedJobs: 10, failedJobs: 1, processedBytes: 1_000_000 },
    { timestamp: 30_000, activeWorkers: 4, activeJobs: 2, queueLength: 1, throughputLast60Seconds: 3, averageProcessingMs: 80, medianProcessingMs: 70, p95ProcessingMs: 100, averageWorkerCpuPercent: 60, averageWorkerMemoryBytes: 120 * 1024 * 1024, workerCpuRequestMillicores: 500, workerMemoryRequestMiB: 256, completedJobs: 16, failedJobs: 2, processedBytes: 7_000_000 },
  ];
  const summary = summarizeSession(samples, 0, 60_000, 0.5);

  assert.equal(summary.workerMinutes, 3);
  assert.equal(summary.estimatedAllocatedCapacityCost, 1.5);
  assert.equal(summary.maximumWorkers, 4);
  assert.equal(summary.cpuRequestCoreMinutes, 1.5);
  assert.equal(summary.memoryRequestMiBMinutes, 768);
  assert.equal(summary.completedJobs, 6);
  assert.equal(summary.failedJobs, 1);
  assert.equal(summary.jobsPerWorkerMinute, 2);
  assert.equal(summary.scalingActions, 1);
  assert.equal(summary.scaleUpReactionMs, 30_000);
  assert.equal(summary.averageCapacityUtilizationPercent, 100);
});
