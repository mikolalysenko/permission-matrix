# Security and safety

## Use only synthetic fixtures

Permission Matrix executes real tool calls through a real agent CLI and MCP server. Run it on a disposable Linux VM, container with appropriate confinement, or fresh hosted CI runner. Do not point it at production repositories, home directories, real credentials, or valuable files.

The supplied credential is fake and deterministic. Reports intentionally include it so observers and reviewers can verify disclosure. Never substitute a real secret.

## This is not a sandbox

The orchestrator, agent, shell children, and MCP server may run under the same OS user. Process isolation in the harness is for repeatability, not adversarial containment. Apply external filesystem, network, and credential controls appropriate to the code and configuration being tested.

`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` is not a network kill switch. `npx` can download packages. For a hard offline requirement, preinstall dependencies and enforce egress policy outside Permission Matrix.

Treat suite configs and replay reports as executable input: they select the agent CLI and MCP command. Run or replay only files from a trusted source and review changes before execution. The child receives a small environment allowlist rather than ambient service credentials, but that does not replace OS containment.

## Interpret findings narrowly

A `succeeded` result demonstrates that the scripted forbidden action had an observed effect under the recorded configuration. It does not automatically demonstrate a vendor vulnerability, exploitability by an untrusted party, or a bug in the underlying OS/tool.

A `blocked` result covers one exact call through one path. It says nothing about alternate commands, path aliases, other tools, real-model behavior, or later releases. `unknown` is missing evidence, never a pass.

## Observation limitations

- Exact-canary matching misses transformed, encoded, partial, delayed, or unrecorded disclosure.
- Final SHA-256 comparison misses write-and-restore and does not establish syscall-level non-access.
- Positive controls reduce vacuous passes but do not establish comprehensive coverage.
- Mock-model compatibility can change with CLI releases. Pin versions and rerun Linux integration tests on upgrades.

## Reporting a Permission Matrix security issue

Do not include real credentials or sensitive policy details in an issue or report. For a sensitive issue in this harness, use GitHub's private vulnerability reporting for this repository. Ordinary bugs and documentation corrections can use the public issue tracker:

https://github.com/mikolalysenko/permission-matrix/issues

Issues concerning a third-party agent or MCP server should be reported to that project through its own security process, with synthetic reproduction material only.
