function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function deploymentPolicy(value) {
  if (value === "CPU_HPA") return "CPU_HPA";
  if (value === "QUEUE_KEDA" || value === "DYNAMIC") return "QUEUE_KEDA";
  return "STATIC";
}

export const config = {
  queueName: process.env.QUEUE_NAME ?? "image-processing",
  pendingList: process.env.PENDING_LIST ?? "media-processing:pending",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  deploymentPolicy: deploymentPolicy(process.env.DEPLOYMENT_POLICY),
  batchesIndex: process.env.BATCHES_INDEX ?? "media:batches",
  batchRetentionSeconds: Number(process.env.BATCH_RETENTION_SECONDS ?? 604800),
  workersKey: process.env.WORKER_HEARTBEATS_KEY ?? "media:workers:heartbeats",
  workerDetailsKey: process.env.WORKER_DETAILS_KEY ?? "media:workers:details",
  heartbeatIntervalMs: Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? 5000),
  heartbeatTtlMs: Number(process.env.WORKER_HEARTBEAT_TTL_MS ?? 15000),
  workerCpuRequestMillicores: Number(process.env.WORKER_CPU_REQUEST_MILLICORES ?? 500),
  workerMemoryRequestMiB: Number(process.env.WORKER_MEMORY_REQUEST_MIB ?? 256),
  jobMetricsKey: process.env.JOB_METRICS_KEY ?? "media:metrics:jobs",
  metricRetentionMs: Number(process.env.METRIC_RETENTION_MS ?? 604800000),
  sessionsIndex: process.env.EXPERIMENT_SESSIONS_INDEX ?? "media:experiments:sessions",
  activeSessionsKey: process.env.EXPERIMENT_ACTIVE_SESSIONS_KEY ?? "media:experiments:active",
  experimentSampleIntervalMs: Number(process.env.EXPERIMENT_SAMPLE_INTERVAL_MS ?? 5000),
  capacityCostPerWorkerMinute: optionalNumber(process.env.WORKER_CAPACITY_COST_PER_MINUTE),
  minio: {
    endPoint: process.env.MINIO_ENDPOINT ?? "localhost",
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY ?? "mediaadmin",
    secretKey: process.env.MINIO_SECRET_KEY ?? "mediaadmin123",
    inputBucket: process.env.MINIO_INPUT_BUCKET ?? "media-input",
    outputBucket: process.env.MINIO_OUTPUT_BUCKET ?? "media-output",
  },
};
