import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const baseUrl = __ENV.BASE_URL ?? "http://localhost:4000";
const token = __ENV.BENCHMARK_TOKEN ?? "local-benchmark-token";
const scenario = __ENV.SCENARIO ?? "low";
const jobsPerRequest = Number(__ENV.JOBS_PER_REQUEST ?? 1);
const experimentSessionId = __ENV.EXPERIMENT_SESSION_ID ?? "";

const profiles = {
  low: {
    executor: "constant-arrival-rate",
    rate: 1,
    timeUnit: "1s",
    duration: "5m",
    preAllocatedVUs: 10,
    maxVUs: 50,
  },
  high: {
    executor: "constant-arrival-rate",
    rate: 6,
    timeUnit: "1s",
    duration: "5m",
    preAllocatedVUs: 40,
    maxVUs: 150,
  },
  ramp: {
    executor: "ramping-arrival-rate",
    startRate: 1,
    timeUnit: "1s",
    preAllocatedVUs: 30,
    maxVUs: 150,
    stages: [
      { target: 1, duration: "1m" },
      { target: 8, duration: "3m" },
      { target: 2, duration: "1m" },
    ],
  },
  spike: {
    executor: "ramping-arrival-rate",
    startRate: 1,
    timeUnit: "1s",
    preAllocatedVUs: 50,
    maxVUs: 200,
    stages: [
      { target: 1, duration: "1m" },
      { target: 15, duration: "15s" },
      { target: 15, duration: "1m" },
      { target: 1, duration: "15s" },
      { target: 1, duration: "1m" },
    ],
  },
};

export const options = {
  scenarios: { selected: profiles[scenario] ?? profiles.low },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    job_completion_failed: ["rate<0.02"],
  },
};

const jobTurnaround = new Trend("job_turnaround_ms", true);
const jobCompletionFailed = new Rate("job_completion_failed");

export default function submitAndWaitForJob() {
  const startedAt = Date.now();
  const payload = { count: jobsPerRequest, format: "webp", quality: 78, width: 1600 };
  if (experimentSessionId) payload.experimentSessionId = experimentSessionId;
  const submit = http.post(
    `${baseUrl}/benchmark/jobs`,
    JSON.stringify(payload),
    { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } },
  );
  const accepted = check(submit, { "posao prihvaćen": (response) => response.status === 202 });
  if (!accepted) {
    jobCompletionFailed.add(true);
    return;
  }

  const batchId = submit.json("batchId");
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = http.get(`${baseUrl}/batches/${batchId}`);
    if (status.status === 200) {
      const jobs = status.json("jobs");
      const finished = jobs.every((job) => job.status === "completed" || job.status === "failed");
      if (finished) {
        const success = jobs.every((job) => job.status === "completed");
        jobCompletionFailed.add(!success);
        jobTurnaround.add(Date.now() - startedAt);
        return;
      }
    }
    sleep(0.2);
  }
  jobCompletionFailed.add(true);
}
