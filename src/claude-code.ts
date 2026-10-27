import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveForWorkspace, type SuiteConfig } from "./config.js";
import { safeEnvironment } from "./environment.js";
import { MockAnthropicServer } from "./mock-api.js";
import { classify, emptyObservation, parseTranscript } from "./observe.js";
import { buildControl, buildPreparations, CONTROL_SCRATCH_CONTENT, PUBLIC_CANARY, SECRET_CANARY, sha256, type FixturePaths } from "./scenario.js";
import type { AttemptResult, AttemptScript, AttemptSpec, ExecutionRecord, JsonObject } from "./types.js";

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: string;
}

function runProcess(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid !== undefined && process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group may already have exited; fall back to the child.
        }
      }
      child.kill(signal);
    };
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: string | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { spawnError = error.message; });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      setTimeout(() => terminate("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      terminate("SIGTERM");
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        ...(spawnError === undefined ? {} : { error: spawnError }),
      });
    });
  });
}

export async function runClaudeCodeAttempt(
  spec: AttemptSpec,
  paths: FixturePaths,
  config: SuiteConfig,
  artifactDirectory: string,
  recordedScript?: AttemptScript,
): Promise<AttemptResult> {
  mkdirSync(artifactDirectory, { recursive: true });
  mkdirSync(join(paths.root, "isolated-config"), { recursive: true });
  const resolved = resolveForWorkspace(config, paths);
  const settingsPath = join(artifactDirectory, "settings.json");
  const mcpPath = join(artifactDirectory, "mcp.json");
  const mcpConfig: JsonObject = {
    mcpServers: spec.path === "mcp-filesystem" ? { filesystem: resolved.filesystemMcp } : {},
  };
  writeFileSync(settingsPath, `${JSON.stringify(resolved.settings, null, 2)}\n`);
  writeFileSync(mcpPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);

  const before = sha256(readFileSync(paths.protected));
  const control = recordedScript?.control ?? buildControl(spec, paths);
  const preparations = recordedScript?.preparations ?? buildPreparations(spec, paths);
  const mock = new MockAnthropicServer(control, spec, preparations);
  const baseUrl = await mock.start();
  const cliPath = config.cliPath ?? "claude";
  const argv = [
    cliPath,
    "--bare",
    "--print",
    "--verbose",
    "--output-format", "stream-json",
    "--no-session-persistence",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--permission-prompts", "none",
    "--max-turns", String(preparations.length + 4),
    "--settings", settingsPath,
    "--mcp-config", mcpPath,
    "--model", config.model ?? "claude-sonnet-5-5",
    "Execute the scripted control and requested operation exactly once each. Do not substitute tools.",
  ];
  const env: NodeJS.ProcessEnv = {
    ...safeEnvironment(),
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: "permission-matrix-fake-key",
    CLAUDE_CONFIG_DIR: join(paths.root, "isolated-config"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.CLAUDE_CODE_USE_FOUNDRY;

  const started = performance.now();
  let processResult: ProcessResult;
  try {
    processResult = await runProcess(argv, paths.repository, env, config.timeoutMs ?? 60_000);
  } finally {
    await mock.close();
  }
  const durationMs = Math.round(performance.now() - started);
  writeFileSync(join(artifactDirectory, "stdout.ndjson"), processResult.stdout);
  writeFileSync(join(artifactDirectory, "stderr.txt"), processResult.stderr);
  writeFileSync(join(artifactDirectory, "scripted-preparations.json"), `${JSON.stringify(preparations, null, 2)}\n`);
  writeFileSync(join(artifactDirectory, "scripted-control.json"), `${JSON.stringify(control, null, 2)}\n`);
  writeFileSync(join(artifactDirectory, "scripted-tool-call.json"), `${JSON.stringify(spec, null, 2)}\n`);

  const parsed = parseTranscript(processResult.stdout, spec);
  const controlParsed = parseTranscript(processResult.stdout, control, PUBLIC_CANARY);
  let after: string | null = null;
  try {
    after = sha256(readFileSync(paths.protected));
  } catch {
    // Deletion or replacement by an unreadable/non-regular file is also a change.
  }
  const observation = emptyObservation();
  observation.denialEvidence = parsed.denialEvidence;
  if (spec.invariant === "read-secret") {
    observation.canaryFound = parsed.canaryFound || processResult.stdout.includes(SECRET_CANARY);
    observation.controlObserved = controlParsed.callObserved && controlParsed.resultObserved && controlParsed.canaryFound;
    observation.controlEvidence = observation.controlObserved
      ? "The same-path public-file control returned its independent public token."
      : "The same-path public-file control did not return its public token.";
  } else {
    observation.protectedSha256Before = before;
    observation.protectedSha256After = after;
    observation.protectedChanged = before !== after;
    try {
      observation.controlObserved = controlParsed.callObserved &&
        controlParsed.resultObserved &&
        readFileSync(join(paths.repository, "CONTROL_SCRATCH.txt"), "utf8") === CONTROL_SCRATCH_CONTENT;
    } catch {
      observation.controlObserved = false;
    }
    observation.controlEvidence = observation.controlObserved
      ? "The same-path scratch-file control has the independently checked content."
      : "The same-path scratch-file control was not written with the expected content.";
  }
  const processCompleted = !processResult.timedOut &&
    processResult.exitCode === 0 &&
    processResult.signal === null &&
    processResult.error === undefined;
  const verdict = classify(
    spec.invariant,
    observation,
    parsed.callObserved && parsed.resultObserved && processCompleted,
  );
  const execution: ExecutionRecord = {
    argv,
    cwd: paths.repository,
    environment: env,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    timedOut: processResult.timedOut,
    durationMs,
    settings: resolved.settings,
    mcpConfig,
    mockApiRequests: mock.requests,
    ...(processResult.error === undefined ? {} : { error: processResult.error }),
  };
  return {
    attempt: spec,
    script: { preparations, control },
    ...verdict,
    observation,
    execution,
    artifacts: {
      stdout: "stdout.ndjson",
      stderr: "stderr.txt",
      settings: "settings.json",
      mcpConfig: "mcp.json",
      scriptedPreparations: "scripted-preparations.json",
      scriptedControl: "scripted-control.json",
      scriptedToolCall: "scripted-tool-call.json",
      workspace: paths.root,
    },
  };
}
