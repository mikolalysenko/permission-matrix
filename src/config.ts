import { readFileSync } from "node:fs";
import type { JsonObject } from "./types.js";
import { PROTECTED_TAMPERED, type FixturePaths } from "./scenario.js";

export interface SuiteConfig extends JsonObject {
  schemaVersion: 1;
  name: string;
  runner: "claude-code";
  cliPath?: string;
  model?: string;
  timeoutMs?: number;
  settings: JsonObject;
  filesystemMcp: JsonObject;
}

export function loadConfig(path: string): SuiteConfig {
  return validateConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function validateConfig(input: unknown): SuiteConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Config must be a JSON object.");
  }
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error("Config schemaVersion must be 1.");
  if (value.runner !== "claude-code") throw new Error("The v0.1 runner must be 'claude-code'.");
  if (typeof value.name !== "string" || !value.name) throw new Error("Config name is required.");
  if (typeof value.settings !== "object" || value.settings === null || Array.isArray(value.settings)) {
    throw new Error("Config settings must be a Claude Code settings object.");
  }
  if (
    typeof value.filesystemMcp !== "object" ||
    value.filesystemMcp === null ||
    Array.isArray(value.filesystemMcp) ||
    typeof (value.filesystemMcp as JsonObject).command !== "string" ||
    !Array.isArray((value.filesystemMcp as JsonObject).args)
  ) {
    throw new Error("filesystemMcp must contain a command string and args array.");
  }
  if (value.timeoutMs !== undefined && (typeof value.timeoutMs !== "number" || value.timeoutMs <= 0)) {
    throw new Error("timeoutMs must be a positive number.");
  }
  return value as SuiteConfig;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function renderString(value: string, replacements: Record<string, string>): string {
  return Object.entries(replacements).reduce(
    (result, [key, replacement]) => result.replaceAll(`{${key}}`, replacement),
    value,
  );
}

function render(value: unknown, replacements: Record<string, string>): unknown {
  if (typeof value === "string") return renderString(value, replacements);
  if (Array.isArray(value)) return value.map((item) => render(item, replacements));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, render(item, replacements)]),
    );
  }
  return value;
}

export function resolveForWorkspace(config: SuiteConfig, paths: FixturePaths): {
  settings: JsonObject;
  filesystemMcp: JsonObject;
} {
  const replacements = {
    root: paths.root,
    secret: paths.secret,
    protected: paths.protected,
    repository: paths.repository,
    quotedSecret: shellQuote(paths.secret),
    quotedProtected: shellQuote(paths.protected),
    quotedTampered: shellQuote(PROTECTED_TAMPERED),
  };
  return {
    settings: render(config.settings, replacements) as JsonObject,
    filesystemMcp: render(config.filesystemMcp, replacements) as JsonObject,
  };
}
