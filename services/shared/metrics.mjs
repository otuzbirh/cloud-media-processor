export function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export async function freshWorkerIds(redis, key, now, heartbeatTtlMs) {
  await redis.zremrangebyscore(key, 0, now - heartbeatTtlMs);
  return redis.zrange(key, 0, -1);
}

export function summarizeJobEvents(events, now = Date.now()) {
  const completed = events.filter((event) => event.status === "completed");
  const failed = events.filter((event) => event.status === "failed");
  const recentCompleted = completed.filter((event) => event.finishedAt >= now - 60_000);
  const processingTimes = completed.map((event) => event.processingMs).filter(Number.isFinite);
  const queueWaitTimes = events.map((event) => event.queueWaitMs).filter(Number.isFinite);
  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

  return {
    completedJobs: completed.length,
    failedJobs: failed.length,
    throughputLast60Seconds: recentCompleted.length,
    averageProcessingMs: average(processingTimes),
    p95ProcessingMs: percentile(processingTimes, 95),
    averageQueueWaitMs: average(queueWaitTimes),
    processedBytes: completed.reduce((sum, event) => sum + (event.outputBytes ?? 0), 0),
  };
}

export function summarizeSession(samples, startedAt, endedAt, costPerWorkerMinute = null) {
  const end = endedAt ?? Date.now();
  let workerMilliseconds = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const current = samples[index];
    const nextAt = samples[index + 1]?.timestamp ?? end;
    workerMilliseconds += current.activeWorkers * Math.max(0, nextAt - current.timestamp);
  }
  const workerMinutes = workerMilliseconds / 60_000;
  const values = (field) => samples.map((sample) => sample[field]).filter(Number.isFinite);
  const average = (items) => items.length ? items.reduce((sum, item) => sum + item, 0) / items.length : 0;

  return {
    durationMs: Math.max(0, end - startedAt),
    sampleCount: samples.length,
    workerMinutes,
    estimatedAllocatedCapacityCost: costPerWorkerMinute === null ? null : workerMinutes * costPerWorkerMinute,
    averageQueueLength: average(values("queueLength")),
    maximumQueueLength: Math.max(0, ...values("queueLength")),
    averageWorkers: average(values("activeWorkers")),
    maximumWorkers: Math.max(0, ...values("activeWorkers")),
    averageThroughput: average(values("throughputLast60Seconds")),
    averageProcessingMs: average(values("averageProcessingMs")),
    p95ProcessingMs: percentile(values("p95ProcessingMs"), 95),
  };
}
