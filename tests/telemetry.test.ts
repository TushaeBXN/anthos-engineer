import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Telemetry } from "../agent/telemetry.js";

const fresh = () => new Telemetry(fs.mkdtempSync(path.join(os.tmpdir(), "forge-telemetry-")));

test("three failures in a row trip the breaker; a success resets it", () => {
  const t = fresh();
  t.record("bash", false, 1, "exit 1");
  t.record("bash", false, 1, "exit 1");
  t.record("bash", true, 1);
  t.record("bash", false, 1, "exit 1");
  t.record("bash", false, 1, "exit 1");
  assert.equal(t.isTripped("bash"), false);
  t.record("bash", false, 1, "exit 1");
  assert.equal(t.isTripped("bash"), true);
});

test("refused calls never ran, so they don't trip the breaker", () => {
  const t = fresh();
  for (let i = 0; i < 5; i++) t.record("bash", false, 0, "unattended", true);
  assert.equal(t.isTripped("bash"), false, "an allowed command can still run after refusals");
  assert.match(t.summary(), /bash/);
});
