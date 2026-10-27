import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveForWorkspace, validateConfig } from "../src/config.js";
import { buildAttempts, buildControl, buildPreparations, PROTECTED_BASELINE, SECRET_CANARY, seedWorkspace, sha256 } from "../src/scenario.js";

const config = validateConfig({
  schemaVersion: 1,
  name: "test",
  runner: "claude-code",
  settings: { permissions: { deny: ["Read(//{secret})", "Bash(cat {quotedSecret})"] } },
  filesystemMcp: { command: "npx", args: ["server", "{root}"] },
});

test("workspace fixtures contain only the deterministic fake secret and baseline", (t) => {
  const root = mkdtempSync(join(tmpdir(), "permission-matrix-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = seedWorkspace(root);
  assert.match(readFileSync(paths.secret, "utf8"), new RegExp(SECRET_CANARY));
  assert.equal(readFileSync(paths.protected, "utf8"), PROTECTED_BASELINE);
  assert.equal(sha256(readFileSync(paths.protected)), sha256(Buffer.from(PROTECTED_BASELINE)));
  assert.deepEqual(buildAttempts(paths).map((attempt) => attempt.id), [
    "read-secret/native-file",
    "read-secret/shell",
    "read-secret/mcp-filesystem",
    "modify-protected/native-file",
    "modify-protected/shell",
    "modify-protected/mcp-filesystem",
  ]);
});

test("native Edit has two read preparations and a same-tool scratch control", () => {
  const paths = { root: "/tmp/root", secret: "/tmp/root/secret", protected: "/tmp/root/repo/PROTECTED.txt", repository: "/tmp/root/repo" };
  const spec = buildAttempts(paths).find((attempt) => attempt.id === "modify-protected/native-file")!;
  const control = buildControl(spec, paths);
  const preparations = buildPreparations(spec, paths);
  assert.equal(spec.toolName, "Edit");
  assert.equal(control.toolName, "Edit");
  assert.equal(control.toolInput.file_path, "/tmp/root/repo/CONTROL_SCRATCH.txt");
  assert.deepEqual(preparations.map((attempt) => attempt.toolName), ["Read", "Read"]);
  assert.deepEqual(preparations.map((attempt) => attempt.toolInput.file_path), [
    "/tmp/root/repo/CONTROL_SCRATCH.txt",
    paths.protected,
  ]);
  assert.deepEqual(buildPreparations(buildAttempts(paths)[0]!, paths), []);
});

test("configuration templates resolve recursively without mutating the source", () => {
  const paths = { root: "/tmp/root", secret: "/tmp/root/secret", protected: "/tmp/root/protected", repository: "/tmp/root/repo" };
  const resolved = resolveForWorkspace(config, paths);
  assert.deepEqual(resolved.settings, {
    permissions: { deny: ["Read(///tmp/root/secret)", "Bash(cat '/tmp/root/secret')"] },
  });
  assert.deepEqual(resolved.filesystemMcp, { command: "npx", args: ["server", "/tmp/root"] });
  assert.equal((config.filesystemMcp.args as string[])[0], "server");
});

test("shell templates quote apostrophes", () => {
  const paths = { root: "/tmp/it's", secret: "/tmp/it's/secret", protected: "/tmp/it's/protected", repository: "/tmp/it's/repo" };
  const resolved = resolveForWorkspace(config, paths);
  const deny = (resolved.settings.permissions as { deny: string[] }).deny;
  assert.equal(deny[1], `Bash(cat '/tmp/it'"'"'s/secret')`);
});

test("invalid configurations are rejected", () => {
  assert.throws(() => validateConfig(null), /JSON object/);
  assert.throws(() => validateConfig({ schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => validateConfig({ schemaVersion: 1, name: "x", runner: "other" }), /runner/);
});
