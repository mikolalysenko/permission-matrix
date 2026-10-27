import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { arch, platform } from "node:process";
import { runClaudeCodeAttempt } from "./claude-code.js";
import { safeEnvironment } from "./environment.js";
import { emptyObservation } from "./observe.js";
import type { SuiteConfig } from "./config.js";
import { renderMarkdown } from "./report.js";
import { buildAttempts, buildControl, buildPreparations, seedWorkspace } from "./scenario.js";
import type { AttemptResult, AttemptScript, AttemptSpec, Outcome, RunReport } from "./types.js";

export const VERSION = "0.1.0";
export const ATTEMPT_IDS = [
  "read-secret/native-file",
  "read-secret/shell",
  "read-secret/mcp-filesystem",
  "modify-protected/native-file",
  "modify-protected/shell",
  "modify-protected/mcp-filesystem",
] as const;

export function cliVersion(cliPath: string): string {
  const result = spawnSync(cliPath, ["--version"], { encoding: "utf8", timeout: 10_000, env: safeEnvironment() });
  if (result.error) throw new Error(`Cannot execute ${cliPath}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${cliPath} --version exited with ${result.status}.`);
  return result.stdout.trim();
}

function safeId(id: string): string {
  return id.replaceAll("/", "__");
}

function relocateValue(value: unknown, oldRoot: string, newRoot: string): unknown {
  if (typeof value === "string") return value.replaceAll(oldRoot, () => newRoot);
  if (Array.isArray(value)) return value.map((item) => relocateValue(item, oldRoot, newRoot));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, relocateValue(item, oldRoot, newRoot)]),
    );
  }
  return value;
}

function shellSingleQuoteEscape(value: string): string {
  return value.replaceAll("'", `'"'"'`);
}

export function relocateSpecForReplay(spec: AttemptSpec, oldRoot: string, newRoot: string): AttemptSpec {
  if (spec.toolName === "Bash" && typeof spec.toolInput.command === "string") {
    return {
      ...spec,
      toolInput: {
        ...spec.toolInput,
        command: spec.toolInput.command.replaceAll(
          shellSingleQuoteEscape(oldRoot),
          () => shellSingleQuoteEscape(newRoot),
        ),
      },
    };
  }
  return { ...spec, toolInput: relocateValue(spec.toolInput, oldRoot, newRoot) as AttemptSpec["toolInput"] };
}

export async function runMatrix(
  config: SuiteConfig,
  outputDirectory: string,
  selectedIds?: string[],
  recordedResults?: AttemptResult[],
): Promise<RunReport> {
  const requestedIds = selectedIds ?? ATTEMPT_IDS;
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw new Error("Duplicate attempt IDs would overwrite per-attempt evidence.");
  }
  const unknownIds = requestedIds.filter((id) => !ATTEMPT_IDS.includes(id as typeof ATTEMPT_IDS[number]));
  if (unknownIds.length > 0) throw new Error(`Unknown attempt IDs: ${unknownIds.join(", ")}`);
  if (recordedResults) {
    for (const id of requestedIds) {
      const recorded = recordedResults.find((result) => result.attempt.id === id);
      if (!recorded?.script || !recorded.artifacts.workspace) {
        throw new Error(`Report does not contain a complete embedded script for ${id}.`);
      }
    }
  }
  const version = cliVersion(config.cliPath ?? "claude");
  if (existsSync(outputDirectory)) {
    throw new Error(`Output path already exists; refusing to overwrite it: ${outputDirectory}`);
  }
  mkdirSync(dirname(outputDirectory), { recursive: true });
  mkdirSync(outputDirectory);

  const results: AttemptResult[] = [];
  for (const id of requestedIds) {
    const workspace = join(outputDirectory, "workspaces", safeId(id));
    const paths = seedWorkspace(workspace);
    const recorded = recordedResults?.find((candidate) => candidate.attempt.id === id);
    const oldRoot = recorded?.artifacts.workspace;
    const spec = recorded && oldRoot
      ? relocateSpecForReplay(recorded.attempt, oldRoot, workspace)
      : buildAttempts(paths).find((attempt) => attempt.id === id)!;
    const script: AttemptScript = recorded && oldRoot
      ? {
          control: relocateSpecForReplay(recorded.script.control, oldRoot, workspace),
          preparations: recorded.script.preparations.map((item) => relocateSpecForReplay(item, oldRoot, workspace)),
        }
      : { control: buildControl(spec, paths), preparations: buildPreparations(spec, paths) };
    const relativeArtifacts = join("attempts", safeId(id));
    let result: AttemptResult;
    try {
      result = await runClaudeCodeAttempt(spec, paths, config, join(outputDirectory, relativeArtifacts), script);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        attempt: spec,
        script,
        outcome: "unknown",
        reason: `Attempt execution failed before a complete observation: ${message}`,
        observation: emptyObservation(),
        execution: {
          argv: [],
          cwd: paths.repository,
          environment: {},
          exitCode: null,
          signal: null,
          timedOut: false,
          durationMs: 0,
          settings: {},
          mcpConfig: {},
          mockApiRequests: [],
          error: message,
        },
        artifacts: { workspace: paths.root },
      };
    }
    for (const [name, artifact] of Object.entries(result.artifacts)) {
      if (name !== "workspace") result.artifacts[name] = join(relativeArtifacts, artifact);
    }
    results.push(result);
  }

  const summary: Record<Outcome, number> = { blocked: 0, succeeded: 0, unknown: 0 };
  for (const result of results) summary[result.outcome] += 1;
  const report: RunReport = {
    schemaVersion: 1,
    tool: { name: "permission-matrix", version: VERSION },
    createdAt: new Date().toISOString(),
    config,
    environment: {
      platform,
      arch,
      node: process.version,
      runner: config.runner,
      cliVersion: version,
    },
    summary,
    results,
  };
  writeFileSync(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outputDirectory, "report.md"), renderMarkdown(report));
  return report;
}
