import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { arch, platform } from "node:process";
import { runClaudeCodeAttempt } from "./claude-code.js";
import type { SuiteConfig } from "./config.js";
import { renderMarkdown } from "./report.js";
import { buildAttempts, seedWorkspace } from "./scenario.js";
import type { AttemptResult, Outcome, RunReport } from "./types.js";

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
  const result = spawnSync(cliPath, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.error) throw new Error(`Cannot execute ${cliPath}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${cliPath} --version exited with ${result.status}.`);
  return result.stdout.trim();
}

function safeId(id: string): string {
  return id.replaceAll("/", "__");
}

export async function runMatrix(
  config: SuiteConfig,
  outputDirectory: string,
  selectedIds?: string[],
): Promise<RunReport> {
  const unknownIds = (selectedIds ?? []).filter((id) => !ATTEMPT_IDS.includes(id as typeof ATTEMPT_IDS[number]));
  if (unknownIds.length > 0) throw new Error(`Unknown attempt IDs: ${unknownIds.join(", ")}`);
  const version = cliVersion(config.cliPath ?? "claude");
  if (existsSync(outputDirectory)) {
    throw new Error(`Output path already exists; refusing to overwrite it: ${outputDirectory}`);
  }
  mkdirSync(dirname(outputDirectory), { recursive: true });
  mkdirSync(outputDirectory);

  const results: AttemptResult[] = [];
  for (const id of selectedIds ?? ATTEMPT_IDS) {
    const workspace = join(outputDirectory, "workspaces", safeId(id));
    const paths = seedWorkspace(workspace);
    const spec = buildAttempts(paths).find((attempt) => attempt.id === id)!;
    const relativeArtifacts = join("attempts", safeId(id));
    const result = await runClaudeCodeAttempt(spec, paths, config, join(outputDirectory, relativeArtifacts));
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
