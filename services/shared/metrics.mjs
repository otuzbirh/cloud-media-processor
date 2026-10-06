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

export async function freshWorkerDetails(redis, heartbeatsKey, detailsKey, now, heartbeatTtlMs) {
  const ids = await freshWorkerIds(redis, heartbeatsKey, now, heartbeatTtlMs);
  if (!ids.length) return [];
  const rawDetails = await redis.hmget(detailsKey, ...ids);
  return ids.map((id, index) => {
    try {
      return { id, ...JSON.parse(rawDetails[index] ?? "{}") };
    } catch {
      return { id };
    }
  });
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
    medianProcessingMs: percentile(processingTimes, 50),
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
  const first = samples[0] ?? {};
  const last = samples.at(-1) ?? {};
  const completedJobs = Math.max(0, (last.completedJobs ?? 0) - (first.completedJobs ?? 0));
  const failedJobs = Math.max(0, (last.failedJobs ?? 0) - (first.failedJobs ?? 0));
  const processedBytes = Math.max(0, (last.processedBytes ?? 0) - (first.processedBytes ?? 0));
  const cpuRequestUtilization = samples
    .filter((sample) => sample.activeWorkers > 0 && sample.workerCpuRequestMillicores > 0)
    .map((sample) => sample.averageWorkerCpuPercent / (sample.workerCpuRequestMillicores / 10));
  let scalingActions = 0;
  let scalingOscillations = 0;
  let lastDirection = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const difference = samples[index].activeWorkers - samples[index - 1].activeWorkers;
    if (!difference) continue;
    scalingActions += 1;
    const direction = Math.sign(difference);
    if (lastDirection && direction !== lastDirection) scalingOscillations += 1;
    lastDirection = direction;
  }
  const loadStartedAt = samples.find((sample) => sample.queueLength > 0)?.timestamp;
  const workersAtLoad = loadStartedAt === undefined
    ? null
    : samples.find((sample) => sample.timestamp === loadStartedAt)?.activeWorkers ?? 0;
  const scaledSample = loadStartedAt === undefined
    ? null
    : samples.find((sample) => sample.timestamp > loadStartedAt && sample.activeWorkers > workersAtLoad);
  const scaleUpReactionMs = scaledSample ? scaledSample.timestamp - loadStartedAt : null;
  const cpuRequestCoreMinutes = workerMinutes * ((first.workerCpuRequestMillicores ?? 0) / 1000);
  const memoryRequestMiBMinutes = workerMinutes * (first.workerMemoryRequestMiB ?? 0);

  return {
    durationMs: Math.max(0, end - startedAt),
    sampleCount: samples.length,
    workerMinutes,
    cpuRequestCoreMinutes,
    memoryRequestMiBMinutes,
    estimatedAllocatedCapacityCost: costPerWorkerMinute === null ? null : workerMinutes * costPerWorkerMinute,
    averageQueueLength: average(values("queueLength")),
    maximumQueueLength: Math.max(0, ...values("queueLength")),
    averageWorkers: average(values("activeWorkers")),
    maximumWorkers: Math.max(0, ...values("activeWorkers")),
    averageThroughput: average(values("throughputLast60Seconds")),
    averageProcessingMs: average(values("averageProcessingMs")),
    medianProcessingMs: average(values("medianProcessingMs")),
    p95ProcessingMs: percentile(values("p95ProcessingMs"), 95),
    averageWorkerCpuPercent: average(values("averageWorkerCpuPercent")),
    maximumWorkerCpuPercent: Math.max(0, ...values("averageWorkerCpuPercent")),
    averageWorkerMemoryMiB: average(values("averageWorkerMemoryBytes")) / 1024 / 1024,
    maximumWorkerMemoryMiB: Math.max(0, ...values("averageWorkerMemoryBytes")) / 1024 / 1024,
    averageCapacityUtilizationPercent: average(cpuRequestUtilization) * 100,
    completedJobs,
    failedJobs,
    processedBytes,
    jobsPerWorkerMinute: workerMinutes > 0 ? completedJobs / workerMinutes : 0,
    processedMiBPerWorkerMinute: workerMinutes > 0 ? processedBytes / 1024 / 1024 / workerMinutes : 0,
    scalingActions,
    scalingOscillations,
    scaleUpReactionMs,
  };
}
