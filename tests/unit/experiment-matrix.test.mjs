import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MATRIX_POLICIES,
  MATRIX_SCENARIOS,
  completedScheduleKeys,
  createExperimentSchedule,
  selectPendingSchedule,
} from "../../lib/experiment-matrix.mjs";

test("gradi potpun i jedinstven plan eksperimenta", () => {
  const schedule = createExperimentSchedule(5);
  assert.equal(schedule.length, 60);
  assert.equal(new Set(schedule.map((item) => item.key)).size, 60);
  for (const policy of MATRIX_POLICIES) {
    for (const scenario of MATRIX_SCENARIOS) {
      assert.equal(schedule.filter((item) => item.deploymentPolicy === policy && item.scenario === scenario).length, 5);
    }
  }
});

test("rotira prvu politiku između ponavljanja", () => {
  const schedule = createExperimentSchedule(5);
  const firstPolicies = Array.from({ length: 5 }, (_, index) => (
    schedule.find((item) => item.repetition === index + 1)?.deploymentPolicy
  ));
  assert.deepEqual(firstPolicies, ["STATIC", "CPU_HPA", "QUEUE_KEDA", "STATIC", "CPU_HPA"]);
});

test("prva četiri ponavljanja balansiraju poziciju svakog profila po politici", () => {
  const schedule = createExperimentSchedule(4);
  for (const policy of MATRIX_POLICIES) {
    const blocks = Array.from({ length: 4 }, (_, index) => schedule
      .filter((item) => item.repetition === index + 1 && item.deploymentPolicy === policy)
      .map((item) => item.scenario));
    for (let position = 0; position < 4; position += 1) {
      assert.deepEqual(new Set(blocks.map((block) => block[position])), new Set(MATRIX_SCENARIOS));
    }
  }
});

test("nastavak priznaje samo čist i potpun run iste Git revizije", () => {
  const base = {
    status: "completed",
    deploymentPolicy: "STATIC",
    scenario: "low",
    repetition: 1,
    source: { gitSha: "abc", gitDirty: false },
    summary: { failedJobs: 0, incompleteJobs: 0 },
    loadGenerator: { droppedIterations: 0 },
  };
  const keys = completedScheduleKeys([
    base,
    { ...base, scenario: "high", source: { gitSha: "abc", gitDirty: true } },
    { ...base, scenario: "ramp", source: { gitSha: "old", gitDirty: false } },
    { ...base, scenario: "spike", loadGenerator: { droppedIterations: 1 } },
  ], "abc");
  assert.deepEqual([...keys], ["STATIC:low:r1"]);
  const pending = selectPendingSchedule(createExperimentSchedule(1), keys, 1, 2);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sequence, 2);
});
