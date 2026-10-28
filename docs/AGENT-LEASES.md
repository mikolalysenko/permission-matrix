# Agent Leases tests

This adapter tests [Agent Leases](https://github.com/mikolalysenko/agent-leases) through its public CLI, Unix socket, and MCP interface. It repeats the same cases inside the real Linux sandbox. No model or GitHub credentials are needed.

```sh
npm ci
npm run build
node dist/src/cli.js leases --repo ../agent-leases --output artifacts/leases
```

Linux with Python 3.9+ and bubblewrap is required for the complete run. On macOS the host interface tests run, while sandbox cells are **unknown** and the command exits 2. To explicitly run only host interfaces:

```sh
node dist/src/cli.js leases --repo ../agent-leases --output artifacts/leases-host \
  --path cli --path socket --path mcp
```

Open `report.md` for the matrix. `report.json` records every cell's result and evidence path. Each cell's JSON preserves the reviewed policy, worker argv/output, actual provider calls/effects, final counters, and audit events. Existing output directories are never overwritten.

## Coverage

The adapter targets Agent Leases v0.3, including its operator inbox. Requests are
submitted and polled through each worker interface, both on the host and inside
the Linux sandbox. The observer verifies that asking grants nothing, approval
can grant fewer units, denials/questions do not widen access, and a fourth new
request in an hour is refused. It inspects provider calls after these decisions,
not just the returned messages.

| Area | Interactions |
| --- | --- |
| Useful workflow | Pinned read → fresh branch → draft PR → comment on that PR |
| Budgets | Each operation, total operations, writes, payload bytes, concurrent attempts |
| Retries | Same ID, changed payload under an ID, replay across interfaces, uncertain outcomes, interrupted reservations |
| Lifecycle | Expiration, revocation, revocation between publish steps, narrow grant, stale approval, stopped-lease grant |
| Approval | Human accepts/declines the rendered policy; unsupported fields are refused |
| Scope | Repo/ref/URL/foreign-token overrides, other branches/PRs, unavailable admin/merge/review/HTTP/GraphQL actions |
| Input | Relative paths, workflow edits, conflicting/empty file sets, invalid types, duplicate JSON keys, invalid/oversized wire messages |
| MCP | Initialization, discoverable worker tools, closed schemas, notifications cannot execute actions |
| Credentials/evidence | Token absent from output; audit omits body contents |
| Linux files/processes | Hidden token/state, protected-file writes, environment, inherited descriptors, worker administration |
| Linux network | Controlled TCP, DNS-shaped UDP, IPv6, and abstract Unix-socket receivers with working delivery controls |
| Linux mounts | Symlink, hard-link, and socket workspaces rejected before launching |

A **passed** cell has a working allowed control and the expected independently observed effects and decisions. A **gap** is a violated contract or a forbidden provider/host effect, even if the worker reports a denial. **Unknown** means a control, response, platform, or observation is missing. Unknown never means protected.

The GitHub provider is synthetic: it records requests without enforcing the lease itself. The real gateway performs the policy checks. Thus this suite tests gateway/worker integration without uploading anything; it is not a live GitHub API compatibility test. Native HTTPS constraints are covered by Agent Leases' own transport tests. The harness and observer are trusted host processes, and this deterministic test does not evaluate an adaptive model or certify arbitrary sandbox configurations.

## Reproduce a cell

Use the case and path names in `report.json`:

```sh
node dist/src/cli.js leases --repo ../agent-leases --output artifacts/repeat \
  --case repeat/across-interfaces --path mcp
```

Each rerun gets fresh isolated state and synthetic canaries. `--case` and `--path` can be repeated. `--allow-unknown` changes only the exit policy; unknown cells stay visible. Exit codes: 0 for passed checks, 1 for a gap, 2 for incomplete evidence or an invalid run.

The adapter's own observer tests inject a provider effect followed by either a claimed denial or a worker crash. Both must produce a gap. This prevents a broken or misleading interface from falsely passing a security check.
