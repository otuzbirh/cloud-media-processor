import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MATRIX_POLICIES,
  POLICY_CONFIG,
  completedScheduleKeys,
  createExperimentSchedule,
  selectPendingSchedule,
} from "../lib/experiment-matrix.mjs";
import { nonNegativeInteger, positiveInteger } from "../lib/experiment-runner.mjs";
import { toCsv } from "../lib/experiment-analysis.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Konačna matrica mora biti izolovana od lokalnih pilot-runova i njihovih Git revizija.
const resultsRoot = resolve(projectRoot, process.env.RESULTS_DIR ?? "results/final");
const planDirectory = resolve(projectRoot, process.env.MATRIX_PLAN_DIR ?? "experiment-plan");
const repetitions = positiveInteger(process.env.EXPECTED_REPETITIONS, 5, "EXPECTED_REPETITIONS");
const startSequence = positiveInteger(process.env.START_SEQUENCE, 1, "START_SEQUENCE");
const endSequence = positiveInteger(process.env.END_SEQUENCE, repetitions * 12, "END_SEQUENCE");
const cooldownSeconds = nonNegativeInteger(process.env.COOLDOWN_SECONDS, 60, "COOLDOWN_SECONDS");
const execute = process.env.EXECUTE_MATRIX === "1";
const knownNamespaces = MATRIX_POLICIES.map((policy) => POLICY_CONFIG[policy].namespace);
const PLAN_COLUMNS = [
  "sequence",
  "state",
  "repetition",
  "deploymentPolicy",
  "scenario",
  "namespace",
  "overlay",
  "expectedInitialWorkers",
  "key",
];

function command(commandName, args, options = {}) {
  return spawnSync(commandName, args, {
    cwd: projectRoot,
    encoding: "utf8",
    ...options,
  });
}

function commandError(label, result) {
  return new Error(`${label}: ${(result.stderr || result.stdout || result.error?.message || "nepoznata greška").trim()}`);
}

function mustRun(commandName, args, label, options = {}) {
  const result = command(commandName, args, options);
  if (result.status !== 0) throw commandError(label, result);
  return result.stdout.trim();
}

function kubectlArgs(context, args) {
  return ["--context", context, ...args];
}

function mustKubectl(context, args, label, options = {}) {
  return mustRun("kubectl", kubectlArgs(context, args), label, options);
}

async function manifestsFromResults() {
  let entries;
  try {
    entries = await readdir(resultsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const manifests = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    try {
      manifests.push(JSON.parse(await readFile(join(resultsRoot, entry.name, "manifest.json"), "utf8")));
    } catch {
      // Neispravni artefakti ne smiju automatski označiti planiranu stavku završenom.
    }
  }
  return manifests;
}

async function writePlan(schedule, completedKeys, gitSha) {
  const rows = schedule.map((item) => ({
    ...item,
    state: completedKeys.has(item.key) ? "completed" : "pending",
  }));
  await mkdir(planDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(planDirectory, "matrix.json"), `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      gitSha,
      repetitions,
      runs: rows,
    }, null, 2)}\n`, "utf8"),
    writeFile(join(planDirectory, "matrix.csv"), toCsv(rows, PLAN_COLUMNS), "utf8"),
  ]);
  return rows;
}

function requireEnvironment(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} je obavezan za EXECUTE_MATRIX=1.`);
  return value;
}

function assertImmutableImage(name, image) {
  if (!image.includes("@sha256:") && process.env.ALLOW_MUTABLE_IMAGES !== "1") {
    throw new Error(`${name} mora koristiti digest oblika registry/image@sha256:... Postavite ALLOW_MUTABLE_IMAGES=1 samo za pilot.`);
  }
}

function waitForHttp(baseUrl, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = command("curl", ["-fsS", "--max-time", "5", `${baseUrl}/health`]);
    if (result.status === 0) return;
    command("sleep", ["2"]);
  }
  throw new Error(`API nije postao dostupan na ${baseUrl}/health unutar ${timeoutMs} ms.`);
}

function applySecrets(context, namespace, secrets) {
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "media-secrets", namespace },
    type: "Opaque",
    data: {
      MINIO_ACCESS_KEY: Buffer.from(secrets.minioAccessKey).toString("base64"),
      MINIO_SECRET_KEY: Buffer.from(secrets.minioSecretKey).toString("base64"),
      BENCHMARK_TOKEN: Buffer.from(secrets.benchmarkToken).toString("base64"),
    },
  };
  mustKubectl(context, ["apply", "-f", "-"], "Primjena Kubernetes secreta nije uspjela", { input: JSON.stringify(secret) });
}

function deployPolicy(context, item, runtime) {
  process.stdout.write(`\nDeploy ${item.deploymentPolicy} (${item.namespace})\n`);
  for (const namespace of knownNamespaces) {
    mustKubectl(context, [
      "delete", "namespace", namespace,
      "--ignore-not-found=true",
      "--wait=true",
      "--timeout=5m",
    ], `Brisanje namespacea ${namespace} nije uspjelo`);
  }

  mustKubectl(context, ["apply", "-k", item.overlay], `Primjena overlaya ${item.overlay} nije uspjela`);
  applySecrets(context, item.namespace, runtime);
  mustKubectl(context, ["-n", item.namespace, "set", "image", "deployment/api", `api=${runtime.serviceImage}`], "Postavljanje API imagea nije uspjelo");
  mustKubectl(context, ["-n", item.namespace, "set", "image", "deployment/worker", `worker=${runtime.serviceImage}`], "Postavljanje worker imagea nije uspjelo");
  mustKubectl(context, ["-n", item.namespace, "set", "image", "deployment/web", `web=${runtime.webImage}`], "Postavljanje web imagea nije uspjelo");
  mustKubectl(context, ["-n", item.namespace, "rollout", "restart", "deployment/minio", "deployment/api", "deployment/worker"], "Restart nakon promjene secreta nije uspio");

  for (const deployment of ["redis", "minio", "api", "worker", "web"]) {
    mustKubectl(context, [
      "-n", item.namespace,
      "rollout", "status", `deployment/${deployment}`,
      "--timeout=5m",
    ], `Deployment ${deployment} nije postao spreman`);
  }
  const readyWorkers = Number(mustKubectl(context, [
    "-n", item.namespace,
    "get", "deployment", "worker",
    "-o", "jsonpath={.status.readyReplicas}",
  ], "Broj spremnih workera nije dostupan") || 0);
  if (readyWorkers !== item.expectedInitialWorkers) {
    throw new Error(`Spremnih workera je ${readyWorkers}, očekivano je ${item.expectedInitialWorkers}.`);
  }
  waitForHttp(runtime.baseUrl);
}

function runExperiment(item, runtime) {
  process.stdout.write(`\nRun ${item.sequence}: ${item.key}\n`);
  const result = command(process.execPath, ["scripts/run-experiment.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ALLOW_DIRTY: "0",
      BASE_URL: runtime.baseUrl,
      BENCHMARK_TOKEN: runtime.benchmarkToken,
      COOLDOWN_SECONDS: String(cooldownSeconds),
      EXPECTED_INITIAL_WORKERS: String(item.expectedInitialWorkers),
      EXPECTED_POLICY: item.deploymentPolicy,
      KUBECTL_NAMESPACE: item.namespace,
      REPETITION: String(item.repetition),
      RESULTS_DIR: resultsRoot,
      RUN_NAME: `${item.deploymentPolicy} ${item.scenario} r${item.repetition}`,
      SCENARIO: item.scenario,
    },
  });
  if (result.status !== 0) {
    throw new Error(`Run ${item.key} nije uspio${result.signal ? ` (${result.signal})` : ""}.`);
  }
}

async function main() {
  const gitSha = mustRun("git", ["rev-parse", "HEAD"], "Git revizija nije dostupna");
  const schedule = createExperimentSchedule(repetitions);
  const completedKeys = completedScheduleKeys(await manifestsFromResults(), gitSha);
  const rows = await writePlan(schedule, completedKeys, gitSha);
  const pending = selectPendingSchedule(schedule, completedKeys, startSequence, endSequence);
  const completedCount = rows.filter((item) => item.state === "completed").length;
  process.stdout.write(`Plan: ${planDirectory}\nZavršeno: ${completedCount}/${rows.length}; odabrano za rad: ${pending.length}\n`);

  for (const config of Object.values(POLICY_CONFIG)) {
    mustRun("kubectl", ["kustomize", config.overlay], `Kustomize provjera nije prošla za ${config.overlay}`);
  }
  if (!execute) {
    process.stdout.write("Plan-only način. Za stvarno izvođenje postavite EXECUTE_MATRIX=1 i obavezne sigurnosne varijable.\n");
    return;
  }
  if (!pending.length) {
    process.stdout.write("Nema preostalih runova u odabranom rasponu.\n");
    return;
  }

  const expectedConfirmation = knownNamespaces.join(",");
  if (process.env.CONFIRM_NAMESPACE_RESET !== expectedConfirmation) {
    throw new Error(`CONFIRM_NAMESPACE_RESET mora biti tačno: ${expectedConfirmation}`);
  }
  const gitStatus = mustRun("git", ["status", "--porcelain"], "Git status nije dostupan");
  if (gitStatus) throw new Error("Git radno stablo mora biti čisto prije konačne matrice.");

  const context = requireEnvironment("KUBE_CONTEXT");
  const currentContext = mustRun("kubectl", ["config", "current-context"], "Kubernetes context nije dostupan");
  if (currentContext !== context) throw new Error(`Aktivni context je ${currentContext}, očekivan je ${context}.`);
  mustKubectl(context, ["get", "apiservice", "v1beta1.metrics.k8s.io"], "Metrics Server nije dostupan");
  mustKubectl(context, ["get", "crd", "scaledobjects.keda.sh"], "KEDA CRD nije dostupan");

  const runtime = {
    baseUrl: requireEnvironment("BASE_URL").replace(/\/+$/, ""),
    benchmarkToken: requireEnvironment("BENCHMARK_TOKEN"),
    minioAccessKey: requireEnvironment("MINIO_ACCESS_KEY"),
    minioSecretKey: requireEnvironment("MINIO_SECRET_KEY"),
    serviceImage: requireEnvironment("SERVICE_IMAGE"),
    webImage: requireEnvironment("WEB_IMAGE"),
  };
  assertImmutableImage("SERVICE_IMAGE", runtime.serviceImage);
  assertImmutableImage("WEB_IMAGE", runtime.webImage);

  let activePolicy = null;
  for (const item of pending) {
    if (item.deploymentPolicy !== activePolicy) {
      deployPolicy(context, item, runtime);
      activePolicy = item.deploymentPolicy;
    }
    runExperiment(item, runtime);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
