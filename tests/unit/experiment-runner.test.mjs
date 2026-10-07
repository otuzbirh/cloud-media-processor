import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRunId,
  drainState,
  k6MetricValue,
  nonNegativeInteger,
  optionalPolicy,
  positiveInteger,
  requiredScenario,
  safeSegment,
} from "../../lib/experiment-runner.mjs";

test("validira scenario, politiku i numeričke ulaze", () => {
  assert.equal(requiredScenario("RAMP"), "ramp");
  assert.equal(optionalPolicy("queue_keda"), "QUEUE_KEDA");
  assert.equal(positiveInteger("5", 1, "REPETITION"), 5);
  assert.equal(nonNegativeInteger("0", 60, "COOLDOWN_SECONDS"), 0);
  assert.throws(() => requiredScenario("random"), /SCENARIO/);
  assert.throws(() => optionalPolicy("DYNAMIC"), /EXPECTED_POLICY/);
  assert.throws(() => positiveInteger("0", 1, "REPETITION"), /REPETITION/);
});

test("gradi stabilan i siguran identifikator izvođenja", () => {
  const timestamp = new Date("2026-10-07T10:11:12.345Z");
  assert.equal(safeSegment("S1 CPU / test #1"), "s1-cpu-test-1");
  assert.equal(
    createRunId({ policy: "CPU_HPA", scenario: "ramp", repetition: 3, timestamp }),
    "2026-10-07T10-11-12-345Z_cpu_hpa_ramp_r03",
  );
});

test("drain zahtijeva prazan red, bez aktivnih i nedovršenih poslova", () => {
  assert.deepEqual(
    drainState(
      { queueLength: 0, activeJobs: 0 },
      { summary: { submittedJobs: 10, incompleteJobs: 0 } },
    ),
    { activeJobs: 0, drained: true, incompleteJobs: 0, queueLength: 0, submittedJobs: 10 },
  );
  assert.equal(drainState(
    { queueLength: 0, activeJobs: 0 },
    { summary: { submittedJobs: 10, incompleteJobs: 1 } },
  ).drained, false);
  assert.equal(drainState(
    { queueLength: 0, activeJobs: 0 },
    { summary: { submittedJobs: 0, incompleteJobs: 0 } },
  ).drained, false);
});

test("čita k6 metrike iz starog i novog summary formata", () => {
  assert.equal(k6MetricValue({ metrics: { dropped_iterations: { values: { count: 3 } } } }, "dropped_iterations", "count"), 3);
  assert.equal(k6MetricValue({ metrics: { dropped_iterations: { count: 4 } } }, "dropped_iterations", "count"), 4);
  assert.equal(k6MetricValue({}, "dropped_iterations", "count"), 0);
});
