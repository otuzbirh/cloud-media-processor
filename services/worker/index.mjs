import http from "node:http";
import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import sharp from "sharp";
import { config } from "../shared/config.mjs";
import { ensureBuckets, redis, storage, streamToBuffer } from "../shared/connections.mjs";
import { processImageOutputs } from "../shared/image.mjs";

await ensureBuckets();

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "media_worker_" });
const processedJobs = new Counter({ name: "media_worker_jobs_total", help: "Broj završenih poslova", labelNames: ["status"], registers: [registry] });
const activeJobs = new Gauge({ name: "media_worker_active_jobs", help: "Broj aktivnih poslova", registers: [registry] });
const processingDuration = new Histogram({ name: "media_worker_processing_seconds", help: "Trajanje obrade fotografije", buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20], registers: [registry] });
const workerId = process.env.WORKER_INSTANCE_ID ?? process.env.HOSTNAME ?? randomUUID();

async function heartbeat() {
  await redis.zadd(config.workersKey, Date.now(), workerId);
}

await heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat().catch((error) => console.error("Heartbeat nije upisan", error)), config.heartbeatIntervalMs);
heartbeatTimer.unref();

async function recordFinishedJob(job, status, result = {}) {
  const finishedAt = Date.now();
  const event = {
    id: job.id,
    batchId: job.data.batchId,
    workerId,
    status,
    queuedAt: job.timestamp,
    startedAt: job.processedOn ?? finishedAt,
    finishedAt,
    queueWaitMs: Math.max(0, (job.processedOn ?? finishedAt) - job.timestamp),
    processingMs: Math.max(0, result.processingMs ?? finishedAt - (job.processedOn ?? finishedAt)),
    inputBytes: job.data.originalBytes ?? 0,
    outputBytes: result.totalOutputBytes ?? result.outputBytes ?? 0,
  };
  await redis.zadd(config.jobMetricsKey, finishedAt, JSON.stringify(event));
  await redis.zremrangebyscore(config.jobMetricsKey, 0, finishedAt - config.metricRetentionMs);
  const batchKey = `batch:${job.data.batchId}`;
  const updates = redis.multi().hset(batchKey, "updatedAt", String(finishedAt));
  if (status === "completed") {
    updates.hincrby(batchKey, "completedCount", 1).hincrby(batchKey, "outputBytes", event.outputBytes);
  } else {
    updates.hincrby(batchKey, "failedCount", 1);
  }
  await updates.exec();
}

const worker = new Worker(
  config.queueName,
  async (job) => {
    const processingStartedAt = Date.now();
    const stopTimer = processingDuration.startTimer();
    activeJobs.inc();
    await redis.lrem(config.pendingList, 1, job.id);
    await job.updateProgress(8);
    try {
      let source;
      if (job.data.synthetic) {
        source = await sharp({ create: { width: 4000, height: 3000, channels: 4, background: { r: 38, g: 126, b: 96, alpha: 1 } } }).png().toBuffer();
      } else {
        source = await streamToBuffer(await storage.getObject(config.minio.inputBucket, job.data.inputKey));
      }
      await job.updateProgress(35);
      const { output, thumbnail } = await processImageOutputs(source, job.data.options);
      await job.updateProgress(85);
      const extension = job.data.options.format === "jpeg" ? "jpg" : job.data.options.format;
      const baseName = job.data.fileName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
      const outputKey = `${job.data.batchId}/${job.id}-${baseName}.${extension}`;
      await storage.putObject(config.minio.outputBucket, outputKey, output, output.length, { "Content-Type": `image/${job.data.options.format}` });
      let thumbnailKey;
      if (thumbnail) {
        thumbnailKey = `${job.data.batchId}/${job.id}-${baseName}-thumbnail.${extension}`;
        await storage.putObject(config.minio.outputBucket, thumbnailKey, thumbnail, thumbnail.length, { "Content-Type": `image/${job.data.options.format}` });
      }
      await job.updateProgress(100);
      processedJobs.inc({ status: "completed" });
      return {
        outputKey,
        outputBytes: output.length,
        thumbnailKey,
        thumbnailBytes: thumbnail?.length ?? 0,
        totalOutputBytes: output.length + (thumbnail?.length ?? 0),
        processingMs: Date.now() - processingStartedAt,
      };
    } catch (error) {
      processedJobs.inc({ status: "failed" });
      throw error;
    } finally {
      activeJobs.dec();
      stopTimer();
    }
  },
  { connection: redis, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 1) },
);

worker.on("completed", async (job, result) => {
  try {
    await recordFinishedJob(job, "completed", result);
  } catch (error) {
    console.error(`Metrike posla ${job.id} nisu upisane`, error);
  }
});

worker.on("failed", async (job, error) => {
  console.error(`Posao ${job?.id ?? "unknown"} nije uspio`, error);
  if (job && job.attemptsMade < (job.opts.attempts ?? 1)) {
    await redis.rpush(config.pendingList, job.id);
  } else if (job) {
    try {
      await recordFinishedJob(job, "failed");
    } catch (metricsError) {
      console.error(`Metrike neuspjelog posla ${job.id} nisu upisane`, metricsError);
    }
  }
});

const metricsPort = Number(process.env.METRICS_PORT ?? 9091);
const metricsServer = http.createServer(async (request, response) => {
  if (request.url === "/health") {
    response.writeHead(worker.isRunning() ? 200 : 503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: worker.isRunning() ? "ok" : "unavailable" }));
    return;
  }
  if (request.url === "/metrics") {
    response.writeHead(200, { "Content-Type": registry.contentType });
    response.end(await registry.metrics());
    return;
  }
  response.writeHead(404).end();
});
metricsServer.listen(metricsPort, "0.0.0.0");

async function shutdown() {
  clearInterval(heartbeatTimer);
  metricsServer.close();
  await worker.close();
  await redis.zrem(config.workersKey, workerId);
  await redis.quit();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
