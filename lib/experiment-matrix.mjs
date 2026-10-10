export const MATRIX_POLICIES = ["STATIC", "CPU_HPA", "QUEUE_KEDA"];
export const MATRIX_SCENARIOS = ["low", "high", "ramp", "spike"];

export const POLICY_CONFIG = {
  STATIC: {
    namespace: "media-static",
    overlay: "infra/k8s/static",
    expectedInitialWorkers: 6,
  },
  CPU_HPA: {
    namespace: "media-cpu",
    overlay: "infra/k8s/cpu",
    expectedInitialWorkers: 1,
  },
  QUEUE_KEDA: {
    namespace: "media-dynamic",
    overlay: "infra/k8s/dynamic",
    expectedInitialWorkers: 1,
  },
};

function rotate(values, offset) {
  const normalized = ((offset % values.length) + values.length) % values.length;
  return [...values.slice(normalized), ...values.slice(0, normalized)];
}

export function scheduleKey({ deploymentPolicy, scenario, repetition }) {
  return `${deploymentPolicy}:${scenario}:r${repetition}`;
}

export function createExperimentSchedule(repetitions = 5) {
  if (!Number.isInteger(repetitions) || repetitions <= 0) {
    throw new Error("Broj ponavljanja mora biti pozitivan cijeli broj.");
  }
  const schedule = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const policies = rotate(MATRIX_POLICIES, repetition - 1);
    for (const deploymentPolicy of policies) {
      const policyIndex = MATRIX_POLICIES.indexOf(deploymentPolicy);
      const scenarios = rotate(MATRIX_SCENARIOS, repetition - 1 + policyIndex);
      for (const scenario of scenarios) {
        const config = POLICY_CONFIG[deploymentPolicy];
        schedule.push({
          sequence: schedule.length + 1,
          repetition,
          deploymentPolicy,
          scenario,
          namespace: config.namespace,
          overlay: config.overlay,
          expectedInitialWorkers: config.expectedInitialWorkers,
          key: scheduleKey({ deploymentPolicy, scenario, repetition }),
        });
      }
    }
  }
  return schedule;
}

export function completedScheduleKeys(manifests, gitSha) {
  return new Set(manifests
    .filter((manifest) => (
      manifest?.status === "completed"
      && manifest.source?.gitSha === gitSha
      && manifest.source?.gitDirty === false
      && manifest.summary?.failedJobs === 0
      && manifest.summary?.incompleteJobs === 0
      && manifest.loadGenerator?.droppedIterations === 0
    ))
    .map(scheduleKey));
}

export function selectPendingSchedule(schedule, completedKeys, startSequence = 1, endSequence = Number.POSITIVE_INFINITY) {
  return schedule.filter((item) => (
    item.sequence >= startSequence
    && item.sequence <= endSequence
    && !completedKeys.has(item.key)
  ));
}
