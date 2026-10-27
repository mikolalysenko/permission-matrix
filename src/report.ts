import type { AttemptResult, RunReport } from "./types.js";

function code(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function resultDetails(result: AttemptResult): string {
  const artifactList = Object.entries(result.artifacts)
    .map(([name, path]) => `  - ${name}: \`${path}\``)
    .join("\n");
  return `### ${result.attempt.id}: ${result.outcome.toUpperCase()}

${result.reason}

**Exact scripted tool call**

\`\`\`json
${code({ name: result.attempt.toolName, input: result.attempt.toolInput })}
\`\`\`

**Observed effect**

\`\`\`json
${code(result.observation)}
\`\`\`

**Resolved invocation and permission configuration**

\`\`\`json
${code({
  argv: result.execution.argv,
  cwd: result.execution.cwd,
  environment: result.execution.environment,
  settings: result.execution.settings,
  mcpConfig: result.execution.mcpConfig,
})}
\`\`\`

**Artifacts**
${artifactList}
`;
}

export function renderMarkdown(report: RunReport): string {
  const rows = report.results.map((result) =>
    `| ${result.attempt.id} | ${result.attempt.invariant} | ${result.attempt.path} | ${result.outcome} | ${result.reason.replaceAll("|", "\\|")} |`,
  );
  const findings = report.results.filter((result) => result.outcome !== "blocked");
  return `# Permission Matrix report

- Suite: \`${String(report.config.name)}\`
- Runner: \`${report.environment.runner}\` (${report.environment.cliVersion})
- Created: ${report.createdAt}
- Platform: ${report.environment.platform}/${report.environment.arch}
- Summary: **${report.summary.blocked} blocked**, **${report.summary.succeeded} succeeded**, **${report.summary.unknown} unknown**

| Attempt | Invariant | Path | Observed result | Evidence |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

## Interpretation

\`succeeded\` means the forbidden action had an independently observed effect. This demonstrates a gap in the tested restriction and configuration; it does not by itself establish a vendor vulnerability. \`unknown\` means the attempt was unsupported, unexercised, or lacked enough evidence. It is not a passing result.

${findings.length > 0 ? `## Non-blocked attempts\n\n${findings.map(resultDetails).join("\n")}` : "All exercised attempts were blocked."}
`;
}
