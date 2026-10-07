export const EXPERIMENT_SCENARIOS = new Set(["low", "high", "ramp", "spike"]);
export const DEPLOYMENT_POLICIES = new Set(["STATIC", "CPU_HPA", "QUEUE_KEDA"]);

export function requiredScenario(value) {
  const scenario = String(value ?? "").trim().toLowerCase();
  if (!EXPERIMENT_SCENARIOS.has(scenario)) {
    throw new Error("SCENARIO mora biti low, high, ramp ili spike.");
  }
  return scenario;
}

export function optionalPolicy(value) {
  const policy = String(value ?? "").trim().toUpperCase();
  if (!policy) return null;
  if (!DEPLOYMENT_POLICIES.has(policy)) {
    throw new Error("EXPECTED_POLICY mora biti STATIC, CPU_HPA ili QUEUE_KEDA.");
  }
  return policy;
}

export function positiveInteger(value, fallback, name) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} mora biti pozitivan cijeli broj.`);
  return parsed;
}

export function nonNegativeInteger(value, fallback, name) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} mora biti cijeli broj koji nije negativan.`);
  return parsed;
}

export function safeSegment(value) {
  const segment = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return segment || "run";
}

export function createRunId({ policy, scenario, repetition, timestamp = new Date() }) {
  const iso = timestamp.toISOString().replace(/[:.]/g, "-");
  return `${iso}_${safeSegment(policy)}_${safeSegment(scenario)}_r${String(repetition).padStart(2, "0")}`;
}

export function drainState(metrics, session, requireSubmittedJobs = true) {
  const summary = session?.summary ?? {};
  const submittedJobs = Number(summary.submittedJobs ?? 0);
  const incompleteJobs = Number(summary.incompleteJobs ?? 0);
  const queueLength = Number(metrics?.queueLength ?? Number.POSITIVE_INFINITY);
  const activeJobs = Number(metrics?.activeJobs ?? Number.POSITIVE_INFINITY);
  const drained = queueLength === 0
    && activeJobs === 0
    && incompleteJobs === 0
    && (!requireSubmittedJobs || submittedJobs > 0);
  return { activeJobs, drained, incompleteJobs, queueLength, submittedJobs };
}

export function k6MetricValue(summary, metricName, fieldName, fallback = 0) {
  const metric = summary?.metrics?.[metricName];
  const value = metric?.values?.[fieldName] ?? metric?.[fieldName];
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}
