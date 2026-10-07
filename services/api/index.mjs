import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import archiver from "archiver";
import cors from "cors";
import express from "express";
import multer from "multer";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { config, sessionJobMetricsKey } from "../shared/config.mjs";
import { ensureBuckets, queue, redis, storage } from "../shared/connections.mjs";
import { freshWorkerDetails, summarizeJobEvents, summarizeSession } from "../shared/metrics.mjs";
import { validatedOptions } from "../shared/options.mjs";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const uploadDirectory = join(tmpdir(), "cloud-media-uploads");
await mkdir(uploadDirectory, { recursive: true });

const upload = multer({
  dest: uploadDirectory,
  limits: { fileSize: 15 * 1024 * 1024, files: 30 },
  fileFilter: (_request, file, done) => {
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    done(allowed.has(file.mimetype) ? null : new Error("Podržani su samo JPEG, PNG i WebP formati."), allowed.has(file.mimetype));
  },
});

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "media_api_" });
const submittedJobs = new Counter({ name: "media_jobs_submitted_total", help: "Ukupan broj poslanih poslova", registers: [registry] });
new Gauge({
  name: "media_jobs_pending",
  help: "Broj poslova koji čekaju obradu",
  registers: [registry],
  async collect() {
    this.set(await redis.llen(config.pendingList));
  },
});

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") ?? true }));
app.use(express.json({ limit: "1mb" }));

function batchKey(batchId) {
  return `batch:${batchId}`;
}

function batchJobsKey(batchId) {
  return `${batchKey(batchId)}:jobs`;
}

function sessionKey(sessionId) {
  return `experiment:${sessionId}`;
}

function sessionSamplesKey(sessionId) {
  return `${sessionKey(sessionId)}:samples`;
}

function hashArguments(object) {
  return Object.entries(object).flatMap(([key, value]) => [key, String(value)]);
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function conflictError(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function safeName(value, fallback) {
  const name = String(value ?? "").trim();
  if (name.length > 80) throw inputError("Naziv može sadržavati najviše 80 znakova.");
  return name || fallback;
}

async function activeExperimentSessionIds() {
  const ids = await redis.smembers(config.activeSessionsKey);
  if (!ids.length) return [];
  const states = await Promise.all(ids.map(async (id) => ({ id, metadata: await redis.hgetall(sessionKey(id)) })));
  const active = states.filter(({ metadata }) => Object.keys(metadata).length && metadata.status === "active").map(({ id }) => id);
  const stale = states.filter(({ id }) => !active.includes(id)).map(({ id }) => id);
  if (stale.length) await redis.srem(config.activeSessionsKey, ...stale);
  return active;
}

async function resolveExperimentSessionId(value) {
  const requestedId = String(value ?? "").trim();
  if (requestedId) {
    const metadata = await redis.hgetall(sessionKey(requestedId));
    if (!Object.keys(metadata).length) throw inputError("Eksperimentalna sesija nije pronađena.");
    if (metadata.status !== "active") throw conflictError("Eksperimentalna sesija nije aktivna.");
    return requestedId;
  }
  const activeIds = await activeExperimentSessionIds();
  if (activeIds.length > 1) throw conflictError("Više eksperimentalnih sesija je aktivno. Navedite experimentSessionId.");
  return activeIds[0] ?? null;
}

app.get("/health", async (_request, response) => {
  try {
    await redis.ping();
    response.json({ status: "ok", service: "media-api", timestamp: new Date().toISOString() });
  } catch {
    response.status(503).json({ status: "unavailable" });
  }
});

app.get("/metrics", async (_request, response) => {
  response.type(registry.contentType).send(await registry.metrics());
});

async function rememberBatch(batchId, jobs, metadata) {
  const jobIds = jobs.map((job) => job.id);
  const transaction = redis.multi();
  if (jobIds.length) transaction.sadd(batchJobsKey(batchId), ...jobIds);
  transaction.hset(batchKey(batchId), ...hashArguments(metadata));
  transaction.zadd(config.batchesIndex, metadata.createdAt, batchId);
  transaction.expire(batchJobsKey(batchId), config.batchRetentionSeconds);
  transaction.expire(batchKey(batchId), config.batchRetentionSeconds);
  await transaction.exec();
}

async function enqueueJob(data, options) {
  const jobId = randomUUID();
  await redis.rpush(config.pendingList, jobId);
  try {
    return await queue.add("process-image", data, { ...options, jobId });
  } catch (error) {
    await redis.lrem(config.pendingList, 1, jobId);
    throw error;
  }
}

async function publicJob(job) {
  const rawStatus = await job.getState();
  const status = ["active", "completed", "failed"].includes(rawStatus) ? rawStatus : "waiting";
  const result = job.returnvalue ?? {};
  return {
    id: job.id,
    fileName: job.data.fileName,
    status,
    progress: typeof job.progress === "number" ? job.progress : 0,
    originalBytes: job.data.originalBytes,
    outputBytes: result.outputBytes,
    thumbnailBytes: result.thumbnailBytes,
    totalOutputBytes: result.totalOutputBytes ?? result.outputBytes,
    queuedAt: job.timestamp,
    startedAt: job.processedOn,
    finishedAt: job.finishedOn,
    downloadUrl: result.outputKey ? `/files/${encodeURIComponent(result.outputKey)}` : undefined,
    thumbnailUrl: result.thumbnailKey ? `/files/${encodeURIComponent(result.thumbnailKey)}` : undefined,
    error: job.failedReason || undefined,
  };
}

function batchStatistics(jobs, now = Date.now()) {
  const completed = jobs.filter((job) => job.status === "completed");
  const failed = jobs.filter((job) => job.status === "failed");
  const terminal = jobs.length > 0 && completed.length + failed.length === jobs.length;
  const inputBytes = jobs.reduce((sum, job) => sum + (job.originalBytes ?? 0), 0);
  const outputBytes = completed.reduce((sum, job) => sum + (job.totalOutputBytes ?? job.outputBytes ?? 0), 0);
  const firstQueuedAt = jobs.length ? Math.min(...jobs.map((job) => job.queuedAt)) : now;
  const lastFinishedAt = terminal ? Math.max(...jobs.map((job) => job.finishedAt ?? firstQueuedAt)) : now;
  const processingTimes = completed.map((job) => (job.finishedAt ?? 0) - (job.startedAt ?? 0)).filter((value) => value >= 0);
  const status = terminal ? (failed.length ? "failed" : "completed") : jobs.some((job) => job.status === "active") ? "processing" : "waiting";

  return {
    status,
    terminal,
    fileCount: jobs.length,
    completed: completed.length,
    failed: failed.length,
    inputBytes,
    outputBytes,
    savingsPercent: inputBytes > 0 ? Math.round((1 - outputBytes / inputBytes) * 1000) / 10 : 0,
    durationMs: Math.max(0, lastFinishedAt - firstQueuedAt),
    averageProcessingMs: processingTimes.length ? processingTimes.reduce((sum, value) => sum + value, 0) / processingTimes.length : 0,
  };
}

async function loadBatch(batchId, includeJobs = true) {
  const [metadata, ids] = await Promise.all([redis.hgetall(batchKey(batchId)), redis.smembers(batchJobsKey(batchId))]);
  if (!Object.keys(metadata).length || !ids.length) return null;
  const queueJobs = (await Promise.all(ids.map((id) => queue.getJob(id)))).filter(Boolean);
  const jobs = await Promise.all(queueJobs.map(publicJob));
  jobs.sort((a, b) => a.queuedAt - b.queuedAt);
  const stats = batchStatistics(jobs);
  await redis.hset(batchKey(batchId), "status", stats.status, "updatedAt", String(Date.now()));
  return {
    batchId,
    name: metadata.name,
    createdAt: Number(metadata.createdAt),
    updatedAt: Number(metadata.updatedAt),
    profile: metadata.profile,
    options: parseJson(metadata.options, {}),
    status: stats.status,
    fileCount: stats.fileCount,
    stats,
    downloadUrl: stats.completed > 0 ? `/batches/${batchId}/download` : undefined,
    ...(includeJobs ? { jobs } : {}),
  };
}

app.post("/batches", upload.array("images", 30), async (request, response, next) => {
  const files = request.files ?? [];
  if (!Array.isArray(files) || files.length === 0) {
    response.status(400).json({ error: "Potrebno je poslati najmanje jednu fotografiju." });
    return;
  }

  const batchId = randomUUID();
  const createdAt = Date.now();
  const createdJobs = [];
  try {
    const options = validatedOptions(request.body);
    const name = safeName(request.body.name, `Batch ${new Date(createdAt).toLocaleString("bs-BA")}`);
    await ensureBuckets();
    for (const [index, file] of files.entries()) {
      const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const inputKey = `${batchId}/${String(index).padStart(3, "0")}-${sanitizedName}`;
      await storage.putObject(config.minio.inputBucket, inputKey, createReadStream(file.path), file.size, { "Content-Type": file.mimetype });
      const job = await enqueueJob(
        { batchId, fileName: file.originalname, originalBytes: file.size, inputKey, options },
        { attempts: 2, backoff: { type: "exponential", delay: 500 }, removeOnComplete: { age: config.batchRetentionSeconds }, removeOnFail: { age: config.batchRetentionSeconds } },
      );
      createdJobs.push(job);
      await rm(file.path, { force: true });
    }
    await rememberBatch(batchId, createdJobs, {
      id: batchId,
      name,
      createdAt,
      updatedAt: createdAt,
      status: "waiting",
      profile: options.profile,
      options: JSON.stringify(options),
      fileCount: createdJobs.length,
      inputBytes: files.reduce((sum, file) => sum + file.size, 0),
      outputBytes: 0,
      completedCount: 0,
      failedCount: 0,
    });
    submittedJobs.inc(createdJobs.length);
    response.status(202).json(await loadBatch(batchId));
  } catch (error) {
    await Promise.all(files.map((file) => rm(file.path, { force: true })));
    next(error);
  }
});

app.post("/benchmark/jobs", async (request, response, next) => {
  if (process.env.BENCHMARK_TOKEN && request.headers.authorization !== `Bearer ${process.env.BENCHMARK_TOKEN}`) {
    response.status(401).json({ error: "Neispravan benchmark token." });
    return;
  }
  const count = Math.min(100, Math.max(1, Number(request.body.count) || 1));
  const batchId = randomUUID();
  const createdAt = Date.now();
  try {
    const experimentSessionId = await resolveExperimentSessionId(request.body.experimentSessionId);
    const options = validatedOptions({ ...request.body, profile: "custom", thumbnailEnabled: false, watermarkEnabled: false });
    const jobs = await Promise.all(Array.from({ length: count }, (_, index) => enqueueJob(
      { batchId, experimentSessionId, fileName: `benchmark-${index + 1}.png`, originalBytes: 48_000_000, synthetic: true, options },
      { attempts: 1, removeOnComplete: { age: config.batchRetentionSeconds }, removeOnFail: { age: config.batchRetentionSeconds } },
    )));
    await rememberBatch(batchId, jobs, {
      id: batchId,
      name: safeName(request.body.name, `Benchmark ${new Date(createdAt).toISOString()}`),
      createdAt,
      updatedAt: createdAt,
      status: "waiting",
      profile: "benchmark",
      options: JSON.stringify(options),
      fileCount: jobs.length,
      inputBytes: jobs.length * 48_000_000,
      outputBytes: 0,
      completedCount: 0,
      failedCount: 0,
    });
    submittedJobs.inc(jobs.length);
    if (experimentSessionId) await redis.hincrby(sessionKey(experimentSessionId), "submittedJobs", jobs.length);
    response.status(202).json({ batchId, experimentSessionId, submitted: jobs.length });
  } catch (error) {
    next(error);
  }
});

app.get("/batches", async (request, response, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 30));
    const ids = await redis.zrevrange(config.batchesIndex, 0, limit - 1);
    const loaded = await Promise.all(ids.map((id) => loadBatch(id, false)));
    const staleIds = ids.filter((_id, index) => loaded[index] === null);
    if (staleIds.length) await redis.zrem(config.batchesIndex, ...staleIds);
    response.json({ batches: loaded.filter(Boolean) });
  } catch (error) {
    next(error);
  }
});

app.get("/batches/:batchId/download", async (request, response, next) => {
  try {
    const batch = await loadBatch(request.params.batchId);
    if (!batch) throw Object.assign(new Error("Batch nije pronađen ili je istekao."), { status: 404 });
    const completedJobs = batch.jobs.filter((job) => job.status === "completed");
    if (!completedJobs.length) throw inputError("Batch još nema izlazne datoteke za preuzimanje.");

    const fileName = `${batch.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "batch"}.zip`;
    response.attachment(fileName);
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (error) => response.destroy(error));
    archive.pipe(response);
    for (const job of completedJobs) {
      const queueJob = await queue.getJob(job.id);
      const result = queueJob?.returnvalue ?? {};
      for (const [key, suffix] of [[result.outputKey, ""], [result.thumbnailKey, "-thumbnail"]]) {
        if (!key) continue;
        const extension = key.split(".").at(-1);
        const base = job.fileName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
        archive.append(await storage.getObject(config.minio.outputBucket, key), { name: `${base}-${job.id.slice(0, 8)}${suffix}.${extension}` });
      }
    }
    await archive.finalize();
  } catch (error) {
    if (response.headersSent) response.destroy(error);
    else next(error);
  }
});

app.get("/batches/:batchId", async (request, response, next) => {
  try {
    const batch = await loadBatch(request.params.batchId);
    if (!batch) {
      response.status(404).json({ error: "Batch nije pronađen ili je istekao." });
      return;
    }
    response.json(batch);
  } catch (error) {
    next(error);
  }
});

app.get("/files/:key", async (request, response, next) => {
  try {
    const key = decodeURIComponent(request.params.key);
    const stream = await storage.getObject(config.minio.outputBucket, key);
    response.setHeader("Content-Disposition", `attachment; filename="${key.split("/").at(-1)}"`);
    stream.pipe(response);
  } catch (error) {
    next(error);
  }
});

async function operationalMetrics(now = Date.now()) {
  const [queueLength, activeJobs, workers, rawEvents] = await Promise.all([
    redis.llen(config.pendingList),
    queue.getActiveCount(),
    freshWorkerDetails(redis, config.workersKey, config.workerDetailsKey, now, config.heartbeatTtlMs),
    redis.zrangebyscore(config.jobMetricsKey, now - config.metricRetentionMs, now),
  ]);
  const events = rawEvents.map((value) => parseJson(value, null)).filter(Boolean);
  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const workerCpu = workers.map((worker) => worker.cpuPercent).filter(Number.isFinite);
  const workerMemory = workers.map((worker) => worker.memoryBytes).filter(Number.isFinite);
  return {
    timestamp: now,
    deploymentPolicy: config.deploymentPolicy,
    queueLength,
    activeJobs,
    activeWorkers: workers.length,
    averageWorkerCpuPercent: average(workerCpu),
    averageWorkerMemoryBytes: average(workerMemory),
    totalWorkerMemoryBytes: workerMemory.reduce((sum, value) => sum + value, 0),
    workerCpuRequestMillicores: config.workerCpuRequestMillicores,
    workerMemoryRequestMiB: config.workerMemoryRequestMiB,
    allocatedCpuCores: workers.length * config.workerCpuRequestMillicores / 1000,
    allocatedMemoryMiB: workers.length * config.workerMemoryRequestMiB,
    ...summarizeJobEvents(events, now),
  };
}

app.get("/experiment/metrics", async (_request, response, next) => {
  try {
    response.json(await operationalMetrics());
  } catch (error) {
    next(error);
  }
});

async function readSession(sessionId, includeSamples = true) {
  const metadata = await redis.hgetall(sessionKey(sessionId));
  if (!Object.keys(metadata).length) return null;
  const [rawSamples, rawJobEvents] = includeSamples
    ? await Promise.all([
      redis.lrange(sessionSamplesKey(sessionId), 0, -1),
      redis.zrange(sessionJobMetricsKey(sessionId), 0, -1),
    ])
    : [[], []];
  const samples = rawSamples.map((value) => parseJson(value, null)).filter(Boolean);
  const jobEvents = rawJobEvents.map((value) => parseJson(value, null)).filter(Boolean);
  const startedAt = Number(metadata.startedAt);
  const endedAt = metadata.endedAt ? Number(metadata.endedAt) : null;
  const submittedJobs = Number(metadata.submittedJobs ?? jobEvents.length);
  return {
    id: sessionId,
    name: metadata.name,
    workloadProfile: metadata.workloadProfile,
    deploymentPolicy: metadata.deploymentPolicy,
    status: metadata.status,
    startedAt,
    endedAt,
    ...(includeSamples ? {
      samples,
      jobEvents,
      summary: summarizeSession(samples, startedAt, endedAt, config.capacityCostPerWorkerMinute, jobEvents, submittedJobs),
    } : {}),
  };
}

async function appendSessionSample(sessionId, metrics) {
  const key = sessionSamplesKey(sessionId);
  await redis.multi().rpush(key, JSON.stringify(metrics)).expire(key, config.batchRetentionSeconds).exec();
}

app.get("/experiment/sessions", async (request, response, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 30));
    const ids = await redis.zrevrange(config.sessionsIndex, 0, limit - 1);
    const sessions = await Promise.all(ids.map((id) => readSession(id, false)));
    response.json({ sessions: sessions.filter(Boolean) });
  } catch (error) {
    next(error);
  }
});

app.post("/experiment/sessions", async (request, response, next) => {
  try {
    const activeIds = await activeExperimentSessionIds();
    if (activeIds.length) throw conflictError("Eksperimentalna sesija je već aktivna.");
    const id = randomUUID();
    const startedAt = Date.now();
    const metadata = {
      id,
      name: safeName(request.body.name, `Eksperiment ${new Date(startedAt).toLocaleString("bs-BA")}`),
      workloadProfile: safeName(request.body.workloadProfile, "Nije naveden"),
      deploymentPolicy: config.deploymentPolicy,
      status: "active",
      startedAt,
      submittedJobs: 0,
    };
    await redis.multi()
      .hset(sessionKey(id), ...hashArguments(metadata))
      .expire(sessionKey(id), config.batchRetentionSeconds)
      .zadd(config.sessionsIndex, startedAt, id)
      .sadd(config.activeSessionsKey, id)
      .exec();
    await appendSessionSample(id, await operationalMetrics(startedAt));
    response.status(201).json(await readSession(id));
  } catch (error) {
    next(error);
  }
});

app.post("/experiment/sessions/:sessionId/stop", async (request, response, next) => {
  try {
    const session = await readSession(request.params.sessionId, false);
    if (!session) throw Object.assign(new Error("Eksperimentalna sesija nije pronađena."), { status: 404 });
    if (session.status === "active") {
      const endedAt = Date.now();
      await appendSessionSample(session.id, await operationalMetrics(endedAt));
      await redis.multi()
        .hset(sessionKey(session.id), "status", "completed", "endedAt", String(endedAt))
        .srem(config.activeSessionsKey, session.id)
        .exec();
    }
    response.json(await readSession(session.id));
  } catch (error) {
    next(error);
  }
});

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

app.get("/experiment/sessions/:sessionId/export", async (request, response, next) => {
  try {
    const session = await readSession(request.params.sessionId);
    if (!session) throw Object.assign(new Error("Eksperimentalna sesija nije pronađena."), { status: 404 });
    const format = request.query.format === "csv" ? "csv" : "json";
    if (format === "json") {
      response.attachment(`${session.id}.json`).json(session);
      return;
    }
    const columns = ["timestamp", "deploymentPolicy", "queueLength", "activeJobs", "activeWorkers", "averageWorkerCpuPercent", "averageWorkerMemoryBytes", "allocatedCpuCores", "allocatedMemoryMiB", "completedJobs", "failedJobs", "throughputLast60Seconds", "averageProcessingMs", "medianProcessingMs", "p95ProcessingMs", "averageQueueWaitMs", "processedBytes"];
    const rows = [columns.join(","), ...session.samples.map((sample) => columns.map((column) => csvValue(sample[column])).join(","))];
    response.attachment(`${session.id}.csv`).type("text/csv").send(`${rows.join("\n")}\n`);
  } catch (error) {
    next(error);
  }
});

app.get("/experiment/sessions/:sessionId", async (request, response, next) => {
  try {
    const session = await readSession(request.params.sessionId);
    if (!session) {
      response.status(404).json({ error: "Eksperimentalna sesija nije pronađena." });
      return;
    }
    response.json(session);
  } catch (error) {
    next(error);
  }
});

let sampling = false;
async function sampleActiveSessions() {
  if (sampling) return;
  sampling = true;
  try {
    const ids = await redis.smembers(config.activeSessionsKey);
    if (!ids.length) return;
    const metrics = await operationalMetrics();
    await Promise.all(ids.map(async (id) => {
      if (await redis.exists(sessionKey(id))) await appendSessionSample(id, metrics);
      else await redis.srem(config.activeSessionsKey, id);
    }));
  } catch (error) {
    console.error("Uzorak eksperimentalne sesije nije sačuvan", error);
  } finally {
    sampling = false;
  }
}

const samplingTimer = setInterval(() => void sampleActiveSessions(), config.experimentSampleIntervalMs);
samplingTimer.unref();

app.use(async (error, request, response, _next) => {
  void _next;
  console.error(error);
  if (Array.isArray(request.files)) await Promise.all(request.files.map((file) => rm(file.path, { force: true })));
  const status = error.status ?? (error instanceof multer.MulterError ? 400 : 500);
  const fallback = status >= 500 ? "Neočekivana greška na serveru." : "Zahtjev nije ispravan.";
  response.status(status).json({ error: error.message ?? fallback });
});

await ensureBuckets();
const server = app.listen(port, "0.0.0.0", () => console.log(`Media API sluša na portu ${port}`));

async function shutdown() {
  clearInterval(samplingTimer);
  await new Promise((resolve) => server.close(resolve));
  await queue.close();
  await redis.quit();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
