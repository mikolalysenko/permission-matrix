export type Invariant = "read-secret" | "modify-protected";
export type ExecutionPath = "native-file" | "shell" | "mcp-filesystem";
export type Outcome = "blocked" | "succeeded" | "unknown";
export type JsonObject = Record<string, unknown>;

export interface AttemptSpec {
  id: string;
  invariant: Invariant;
  path: ExecutionPath;
  toolName: string;
  toolInput: JsonObject;
}

export interface AttemptScript {
  preparations: AttemptSpec[];
  control: AttemptSpec;
}

export interface Observation {
  canaryFound: boolean | null;
  protectedSha256Before: string | null;
  protectedSha256After: string | null;
  protectedChanged: boolean | null;
  denialEvidence: string[];
  controlObserved: boolean;
  controlEvidence: string;
}

export interface ExecutionRecord {
  argv: string[];
  cwd: string;
  environment: Record<string, string | undefined>;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  settings: JsonObject;
  mcpConfig: JsonObject;
  mockApiRequests: Array<{ sequence: number; toolResultCount: number; served: string }>;
  error?: string;
}

export interface AttemptResult {
  attempt: AttemptSpec;
  script: AttemptScript;
  outcome: Outcome;
  reason: string;
  observation: Observation;
  execution: ExecutionRecord;
  artifacts: Record<string, string>;
}

export interface RunReport {
  schemaVersion: 1;
  tool: { name: "permission-matrix"; version: string };
  createdAt: string;
  config: JsonObject;
  environment: {
    platform: NodeJS.Platform;
    arch: string;
    node: string;
    runner: string;
    cliVersion: string;
  };
  summary: Record<Outcome, number>;
  results: AttemptResult[];
}
