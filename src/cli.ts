#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { loadConfig, validateConfig } from "./config.js";
import { renderMarkdown } from "./report.js";
import { cliVersion, runMatrix, VERSION, ATTEMPT_IDS } from "./runner.js";
import type { RunReport } from "./types.js";

const USAGE = `Permission Matrix ${VERSION}

Test one intended restriction through native tools, shell, and filesystem MCP.

Usage:
  permission-matrix run --config CONFIG.json --output RUN_DIR [options]
  permission-matrix replay --input RUN_DIR --output NEW_RUN_DIR [options]
  permission-matrix report --input RUN_DIR [--output REPORT.md]
  permission-matrix validate --config CONFIG.json

Run/replay options:
  --attempt ID       Run only this attempt (repeatable). Replay defaults to
                     attempts whose observed result was "succeeded".
  --allow-unknown    Exit 0 when no action succeeded but attempts are unknown.

Other options:
  --help             Show this help.
  --version          Show the version.

Attempt IDs:
  ${ATTEMPT_IDS.join("\n  ")}

Exit codes: 0 = all exercised attempts blocked; 1 = a forbidden action succeeded;
2 = unknown results, invalid invocation, or execution failure.
`;

interface Options {
  config?: string;
  input?: string;
  output?: string;
  attempts: string[];
  allowUnknown: boolean;
}

function parseOptions(args: string[]): Options {
  const options: Options = { attempts: [], allowUnknown: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--allow-unknown") {
      options.allowUnknown = true;
      continue;
    }
    if (!["--config", "--input", "--output", "--attempt"].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value.`);
    index += 1;
    if (argument === "--attempt") options.attempts.push(value);
    if (argument === "--config") options.config = value;
    if (argument === "--input") options.input = value;
    if (argument === "--output") options.output = value;
  }
  return options;
}

function reportPath(input: string): string {
  const path = resolve(input);
  return existsSync(join(path, "report.json")) ? join(path, "report.json") : path;
}

function readReport(input: string): RunReport {
  return JSON.parse(readFileSync(reportPath(input), "utf8")) as RunReport;
}

function exitCode(report: RunReport, allowUnknown: boolean): number {
  if (report.summary.succeeded > 0) return 1;
  if (!allowUnknown && report.summary.unknown > 0) return 2;
  return 0;
}

function printCompletion(output: string, report: RunReport): void {
  console.log(renderMarkdown(report));
  console.log(`JSON report: ${join(output, "report.json")}`);
  console.log(`Markdown report: ${join(output, "report.md")}`);
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const command = args[0];
  if (!command || command === "--help" || command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (command === "--version" || command === "version") {
    console.log(VERSION);
    return 0;
  }
  const options = parseOptions(args.slice(1));

  if (command === "validate") {
    if (!options.config) throw new Error("validate requires --config.");
    const config = loadConfig(options.config);
    const version = cliVersion(config.cliPath ?? "claude");
    console.log(`Configuration valid. Found ${config.runner}: ${version}`);
    if (process.platform !== "linux") {
      console.log(`Note: v0.1 targets Linux; the current platform is ${process.platform}.`);
    }
    return 0;
  }

  if (command === "report") {
    if (!options.input) throw new Error("report requires --input.");
    const markdown = renderMarkdown(readReport(options.input));
    if (options.output) writeFileSync(options.output, markdown, { flag: "wx" });
    else console.log(markdown);
    return 0;
  }

  if (command === "run") {
    if (!options.config || !options.output) throw new Error("run requires --config and --output.");
    const report = await runMatrix(loadConfig(options.config), resolve(options.output), options.attempts.length > 0 ? options.attempts : undefined);
    printCompletion(options.output, report);
    return exitCode(report, options.allowUnknown);
  }

  if (command === "replay") {
    if (!options.input || !options.output) throw new Error("replay requires --input and --output.");
    const previous = readReport(options.input);
    const attempts = options.attempts.length > 0
      ? options.attempts
      : previous.results.filter((result) => result.outcome === "succeeded").map((result) => result.attempt.id);
    if (attempts.length === 0) throw new Error("No succeeded attempts to replay; specify --attempt explicitly.");
    const report = await runMatrix(validateConfig(previous.config), resolve(options.output), attempts, previous.results);
    printCompletion(options.output, report);
    return exitCode(report, options.allowUnknown);
  }

  throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}

const invokedAsScript = process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(`permission-matrix: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
