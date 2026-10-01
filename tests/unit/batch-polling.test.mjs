import assert from "node:assert/strict";
import { test } from "node:test";
import { areJobsTerminal, startBatchPolling } from "../../lib/batch-polling.mjs";

test("batch je terminalan samo kada su svi poslovi completed ili failed", () => {
  assert.equal(areJobsTerminal([{ status: "completed" }, { status: "failed" }]), true);
  assert.equal(areJobsTerminal([{ status: "completed" }, { status: "active" }]), false);
  assert.equal(areJobsTerminal([]), false);
});

test("polling ne zakazuje novi interval nakon terminalnog odgovora", async () => {
  let scheduled = 0;
  let updates = 0;
  startBatchPolling({
    fetchBatch: async () => ({ jobs: [{ status: "completed" }, { status: "failed" }] }),
    onUpdate: () => { updates += 1; },
    onError: assert.fail,
    schedule: () => { scheduled += 1; return 1; },
    cancel: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(updates, 1);
  assert.equal(scheduled, 0);
});

test("ručno zaustavljanje čisti zakazani polling", async () => {
  let scheduledCallback;
  let cancelled = null;
  const stop = startBatchPolling({
    fetchBatch: async () => ({ jobs: [{ status: "waiting" }] }),
    onUpdate: () => {},
    onError: assert.fail,
    schedule: (callback) => { scheduledCallback = callback; return 42; },
    cancel: (timer) => { cancelled = timer; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof scheduledCallback, "function");
  stop();
  assert.equal(cancelled, 42);
});
