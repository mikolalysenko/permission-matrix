import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const adapter = fileURLToPath(new URL("../../adapters/agent_leases", import.meta.url));

test("lease observer detects effects despite denial claims and worker failures", () => {
  const result = spawnSync("python3", ["-m", "unittest", "discover", "-s", adapter, "-p", "test_adapter.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("lease adapter rejects an invalid checkout without claiming protection", () => {
  const result = spawnSync("python3", [adapter + "/main.py", "--repo", adapter, "--output", "/not-used"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Agent Leases checkout/);
});
