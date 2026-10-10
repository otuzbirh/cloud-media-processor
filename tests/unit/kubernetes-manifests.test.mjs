import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("KEDA Redis trigger koristi namespace-kvalifikovan servis", () => {
  const manifest = readFileSync(
    new URL("../../infra/k8s/dynamic/scaled-object.yaml", import.meta.url),
    "utf8",
  );

  assert.match(
    manifest,
    /address:\s+redis\.media-dynamic\.svc\.cluster\.local:6379/,
  );
  assert.doesNotMatch(manifest, /address:\s+redis:6379/);
});
