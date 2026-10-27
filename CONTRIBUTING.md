# Contributing

Thank you for improving Permission Matrix. Keep the first release small: one CLI, two invariants, and three execution paths. New execution paths should be explicit new cells with positive controls and independent observers, not broad claims attached to existing cells.

## Setup

Requirements: Node.js 24+, npm, and (for real integration) Claude Code 2.1.312.

```bash
npm ci
npm test
npm run check
```

Tests use Node's built-in `node:test` runner. Unit and fake-CLI tests do not need Anthropic credentials or paid inference.

## Real integration run

Use a fresh Linux VM/runner and only the synthetic example:

```bash
npm install -g @anthropic-ai/claude-code@2.1.312
npm run build
node dist/src/cli.js validate --config examples/claude-code.json
node dist/src/cli.js run --config examples/claude-code.json --output artifacts/integration
```

The example is expected to find two MCP gaps and exit 1. The Linux CI job checks the full expected matrix: four blocked, two succeeded, zero unknown. A change is a prompt to investigate the CLI/policy/protocol difference, not something to silence by editing expected counts without evidence.

macOS unit and compatibility runs are useful but do not establish Linux conformance.

## Change checklist

- Add regression tests for behavior changes, especially `unknown` and fail-dominant cases.
- Preserve exact-call matching by tool name and input.
- Never turn a missing control, missing tool result, timeout, or unsupported path into `blocked`.
- Keep a measured forbidden effect dominant over contradictory evidence.
- Record new configuration and evidence in both JSON and Markdown reports.
- Refuse to overwrite existing output directories.
- Do not add real credentials, ambient MCP configuration, or live-model fallback.
- Update docs when compatibility, scope, configuration, or result semantics change.

## Adding a path or CLI

A new adapter must provide deterministic scripted calls, a fresh fixture per cell, an allowed same-path control, independent effect observations, raw evidence, and replay support. Start with a design note listing the new invariant/path matrix and what remains unobserved.

## Style

Use strict TypeScript and Node built-ins for the runtime. Match the existing small-module structure and avoid runtime dependencies unless a new requirement cannot reasonably be met with the standard library. Run `npm run check` and `npm test` before submitting.
