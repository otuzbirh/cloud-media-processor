import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRunId,
  drainState,
  nonNegativeInteger,
  optionalPolicy,
  positiveInteger,
  requiredScenario,
} from "../lib/experiment-runner.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function commandSnapshot(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: "utf8" });
  return {
    command: [command, ...args],
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function requireCommand(command, args, label) {
  const result = commandSnapshot(command, args);
  if (result.exitCode !== 0) throw new Error(`${label} nije dostupan: ${result.stderr.trim() || "nepoznata greška"}`);
  return result.stdout.trim();
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function request(baseUrl, path, options = {}, timeoutMs = 10_000) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} vratio je ${response.status}: ${body.slice(0, 500)}`);
  return { body, headers: response.headers, status: response.status };
}

async function requestJson(baseUrl, path, options, timeoutMs) {
  const response = await request(baseUrl, path, options, timeoutMs);
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error(`${options?.method ?? "GET"} ${path} nije vratio ispravan JSON.`);
  }
}

async function saveEndpoint(baseUrl, path, outputPath, timeoutMs) {
  const response = await request(baseUrl, path, {}, timeoutMs);
  await writeFile(outputPath, response.body, "utf8");
}

async function runStreaming(command, args, { env, logPath }) {
  const log = createWriteStream(logPath, { flags: "w" });
  return new Promise((done, reject) => {
    let settled = false;
    const child = spawn(command, args, { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    const forward = (stream, target) => stream.on("data", (chunk) => {
      log.write(chunk);
      target.write(chunk);
    });
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      log.end();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      log.end(() => done({ exitCode, signal }));
    });
  });
}

async function captureClusterState(namespace, phase, runDirectory) {
  if (!namespace) return null;
  const captures = {
    namespace,
    phase,
    resources: [
      commandSnapshot("kubectl", ["-n", namespace, "get", "deployment", "worker", "-o", "yaml"]),
      commandSnapshot("kubectl", ["-n", namespace, "get", "pods", "-l", "app=media-worker", "-o", "wide"]),
      commandSnapshot("kubectl", ["-n", namespace, "get", "hpa", "-o", "yaml"]),
      commandSnapshot("kubectl", ["-n", namespace, "get", "scaledobject", "-o", "yaml"]),
    ],
  };
  await writeJson(join(runDirectory, `cluster-${phase}.json`), captures);
  return captures;
}

async function captureClusterLogs(namespace, startedAt, runDirectory) {
  if (!namespace) return;
  const sinceTime = startedAt.toISOString();
  const captures = {
    api: commandSnapshot("kubectl", ["-n", namespace, "logs", "-l", "app=media-api", "--all-containers=true", `--since-time=${sinceTime}`, "--prefix"]),
    workers: commandSnapshot("kubectl", ["-n", namespace, "logs", "-l", "app=media-worker", "--all-containers=true", `--since-time=${sinceTime}`, "--prefix"]),
  };
  await writeJson(join(runDirectory, "cluster-logs.json"), captures);
}

async function captureOptionalUrl(url, outputPath, timeoutMs) {
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await writeFile(outputPath, body, "utf8");
    return { ok: true, url };
  } catch (error) {
    const result = { error: error.message, ok: false, url };
    await writeJson(`${outputPath}.error.json`, result);
    return result;
  }
}

async function main() {
  const scenario = requiredScenario(process.env.SCENARIO);
  const expectedPolicy = optionalPolicy(process.env.EXPECTED_POLICY);
  const repetition = positiveInteger(process.env.REPETITION, 1, "REPETITION");
  const jobsPerRequest = positiveInteger(process.env.JOBS_PER_REQUEST, 1, "JOBS_PER_REQUEST");
  const pollIntervalMs = positiveInteger(process.env.POLL_INTERVAL_MS, 2_000, "POLL_INTERVAL_MS");
  const drainTimeoutMs = positiveInteger(process.env.DRAIN_TIMEOUT_MS, 1_800_000, "DRAIN_TIMEOUT_MS");
  const httpTimeoutMs = positiveInteger(process.env.HTTP_TIMEOUT_MS, 10_000, "HTTP_TIMEOUT_MS");
  const cooldownSeconds = nonNegativeInteger(process.env.COOLDOWN_SECONDS, 60, "COOLDOWN_SECONDS");
  const baseUrl = String(process.env.BASE_URL ?? "http://localhost:4000").replace(/\/+$/, "");
  const benchmarkToken = String(process.env.BENCHMARK_TOKEN ?? "").trim();
  const k6Binary = process.env.K6_BIN ?? "k6";
  const namespace = String(process.env.KUBECTL_NAMESPACE ?? "").trim();
  const expectedInitialWorkers = process.env.EXPECTED_INITIAL_WORKERS === undefined
    ? null
    : positiveInteger(process.env.EXPECTED_INITIAL_WORKERS, 1, "EXPECTED_INITIAL_WORKERS");
  if (!benchmarkToken) throw new Error("BENCHMARK_TOKEN je obavezan.");

  const k6Version = requireCommand(k6Binary, ["version"], "k6");
  if (namespace) {
    requireCommand("kubectl", ["version", "--client"], "kubectl");
    requireCommand("kubectl", ["get", "namespace", namespace, "-o", "name"], `Kubernetes namespace ${namespace}`);
  }
  const gitSha = requireCommand("git", ["rev-parse", "HEAD"], "git");
  const gitStatus = commandSnapshot("git", ["status", "--porcelain"]).stdout;
  if (gitStatus.trim() && process.env.ALLOW_DIRTY !== "1") {
    throw new Error("Git radno stablo nije čisto. Commitajte promjene ili postavite ALLOW_DIRTY=1 za pilot-test.");
  }

  await requestJson(baseUrl, "/health", undefined, httpTimeoutMs);
  const initialMetrics = await requestJson(baseUrl, "/experiment/metrics", undefined, httpTimeoutMs);
  const sessions = await requestJson(baseUrl, "/experiment/sessions?limit=100", undefined, httpTimeoutMs);
  if (initialMetrics.queueLength !== 0 || initialMetrics.activeJobs !== 0) {
    throw new Error(`Sistem nije prazan: queueLength=${initialMetrics.queueLength}, activeJobs=${initialMetrics.activeJobs}.`);
  }
  if (sessions.sessions?.some((item) => item.status === "active")) {
    throw new Error("Eksperimentalna sesija je već aktivna.");
  }
  if (expectedPolicy && initialMetrics.deploymentPolicy !== expectedPolicy) {
    throw new Error(`Aktivna politika je ${initialMetrics.deploymentPolicy}, očekivana je ${expectedPolicy}.`);
  }
  if (expectedInitialWorkers !== null && initialMetrics.activeWorkers !== expectedInitialWorkers) {
    throw new Error(`Aktivnih workera je ${initialMetrics.activeWorkers}, očekivano je ${expectedInitialWorkers}.`);
  }

  const startedAt = new Date();
  const policy = initialMetrics.deploymentPolicy;
  const runId = createRunId({ policy, scenario, repetition, timestamp: startedAt });
  const resultsRoot = resolve(projectRoot, process.env.RESULTS_DIR ?? "results");
  const runDirectory = join(resultsRoot, runId);
  await mkdir(runDirectory, { recursive: false }).catch(async (error) => {
    if (error.code === "ENOENT") {
      await mkdir(resultsRoot, { recursive: true });
      await mkdir(runDirectory);
      return;
    }
    throw error;
  });

  const manifest = {
    schemaVersion: 1,
    runId,
    status: "running",
    startedAt: startedAt.toISOString(),
    scenario,
    repetition,
    deploymentPolicy: policy,
    expectedPolicy,
    expectedInitialWorkers,
    workload: { jobsPerRequest },
    runner: { cooldownSeconds, drainTimeoutMs, httpTimeoutMs, pollIntervalMs },
    source: { gitSha, gitDirty: Boolean(gitStatus.trim()) },
    runtime: { node: process.version, k6: k6Version },
    endpoints: { baseUrl, workerMetricsUrl: process.env.WORKER_METRICS_URL ?? null },
    kubernetes: { namespace: namespace || null },
    artifacts: {},
  };
  await writeJson(join(runDirectory, "manifest.json"), manifest);
  await writeJson(join(runDirectory, "metrics-before.json"), initialMetrics);

  let session;
  let k6Result;
  let drainError;
  let stoppedSession;
  const observations = [];
  const captureErrors = [];
  const capture = async (label, action) => {
    try {
      return await action();
    } catch (error) {
      captureErrors.push(`${label}: ${error.message}`);
      return null;
    }
  };

  await capture("Početne API metrike", () => saveEndpoint(baseUrl, "/metrics", join(runDirectory, "api-metrics-before.prom"), httpTimeoutMs));
  const workerMetricsBefore = await captureOptionalUrl(process.env.WORKER_METRICS_URL, join(runDirectory, "worker-metrics-before.prom"), httpTimeoutMs);
  if (workerMetricsBefore?.ok === false) captureErrors.push(`Početne worker metrike: ${workerMetricsBefore.error}`);
  await capture("Početno stanje klastera", () => captureClusterState(namespace, "before", runDirectory));

  try {
    const name = String(process.env.RUN_NAME ?? `${policy} ${scenario} r${repetition}`).trim();
    session = await requestJson(baseUrl, "/experiment/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, workloadProfile: scenario }),
    }, httpTimeoutMs);
    manifest.sessionId = session.id;
    await writeJson(join(runDirectory, "session-start.json"), session);
    await writeJson(join(runDirectory, "manifest.json"), manifest);

    const k6SummaryPath = join(runDirectory, "k6-summary.json");
    const k6Args = ["run", `--summary-export=${k6SummaryPath}`, "tests/load/experiment.js"];
    k6Result = await runStreaming(k6Binary, k6Args, {
      env: {
        ...process.env,
        BASE_URL: baseUrl,
        BENCHMARK_TOKEN: benchmarkToken,
        EXPERIMENT_SESSION_ID: session.id,
        JOBS_PER_REQUEST: String(jobsPerRequest),
        K6_NO_USAGE_REPORT: "true",
        SCENARIO: scenario,
      },
      logPath: join(runDirectory, "k6.log"),
    });

    const drainStartedAt = Date.now();
    while (true) {
      const [metrics, currentSession] = await Promise.all([
        requestJson(baseUrl, "/experiment/metrics", undefined, httpTimeoutMs),
        requestJson(baseUrl, `/experiment/sessions/${session.id}`, undefined, httpTimeoutMs),
      ]);
      const state = drainState(metrics, currentSession, k6Result.exitCode === 0);
      observations.push({ timestamp: Date.now(), ...state });
      process.stdout.write(`Drain: queue=${state.queueLength}, active=${state.activeJobs}, incomplete=${state.incompleteJobs}\n`);
      if (state.drained) break;
      if (Date.now() - drainStartedAt >= drainTimeoutMs) {
        throw new Error(`Drain timeout nakon ${drainTimeoutMs} ms.`);
      }
      await sleep(pollIntervalMs);
    }
  } catch (error) {
    drainError = error;
  } finally {
    await writeJson(join(runDirectory, "drain-observations.json"), observations);
    if (session) {
      try {
        stoppedSession = await requestJson(baseUrl, `/experiment/sessions/${session.id}/stop`, { method: "POST" }, httpTimeoutMs);
        await writeJson(join(runDirectory, "session-final.json"), stoppedSession);
      } catch (error) {
        drainError ??= error;
      }
      await capture("JSON export sesije", () => saveEndpoint(baseUrl, `/experiment/sessions/${session.id}/export?format=json`, join(runDirectory, "session-export.json"), httpTimeoutMs));
      await capture("CSV export sesije", () => saveEndpoint(baseUrl, `/experiment/sessions/${session.id}/export?format=csv`, join(runDirectory, "session-samples.csv"), httpTimeoutMs));
    }
  }

  const finalMetrics = await capture("Završne operativne metrike", async () => {
    const metrics = await requestJson(baseUrl, "/experiment/metrics", undefined, httpTimeoutMs);
    await writeJson(join(runDirectory, "metrics-after.json"), metrics);
    return metrics;
  });
  await capture("Završne API metrike", () => saveEndpoint(baseUrl, "/metrics", join(runDirectory, "api-metrics-after.prom"), httpTimeoutMs));
  const workerMetricsAfter = await captureOptionalUrl(process.env.WORKER_METRICS_URL, join(runDirectory, "worker-metrics-after.prom"), httpTimeoutMs);
  if (workerMetricsAfter?.ok === false) captureErrors.push(`Završne worker metrike: ${workerMetricsAfter.error}`);
  await capture("Završno stanje klastera", () => captureClusterState(namespace, "after", runDirectory));
  await capture("Logovi klastera", () => captureClusterLogs(namespace, startedAt, runDirectory));

  const summary = stoppedSession?.summary;
  const failureReasons = [];
  if (drainError) failureReasons.push(drainError.message);
  failureReasons.push(...captureErrors);
  if (!k6Result) failureReasons.push("k6 nije pokrenut.");
  else if (k6Result.exitCode !== 0) failureReasons.push(`k6 je završio kodom ${k6Result.exitCode}${k6Result.signal ? ` (${k6Result.signal})` : ""}.`);
  if (!summary?.submittedJobs) failureReasons.push("Sesija nema poslanih poslova.");
  if (summary?.incompleteJobs) failureReasons.push(`Sesija ima ${summary.incompleteJobs} nedovršenih poslova.`);

  manifest.status = failureReasons.length ? "failed" : "completed";
  manifest.finishedAt = new Date().toISOString();
  manifest.k6 = k6Result ?? null;
  manifest.summary = summary ?? null;
  manifest.finalMetrics = finalMetrics;
  manifest.failureReasons = failureReasons;
  manifest.artifacts = {
    apiMetrics: ["api-metrics-before.prom", "api-metrics-after.prom"],
    drainObservations: "drain-observations.json",
    k6Log: "k6.log",
    k6Summary: "k6-summary.json",
    sessionCsv: "session-samples.csv",
    sessionJson: "session-export.json",
  };
  await writeJson(join(runDirectory, "manifest.json"), manifest);

  process.stdout.write(`Rezultat: ${runDirectory}\n`);
  if (cooldownSeconds > 0) {
    process.stdout.write(`Cooldown: ${cooldownSeconds} s\n`);
    await sleep(cooldownSeconds * 1000);
  }
  if (failureReasons.length) throw new Error(failureReasons.join(" "));
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
