# Reports and replay

## Summary

`report.md` is the quickest review surface. It records suite/CLI/platform metadata, a six-cell result table, and detailed sections for every `succeeded` or `unknown` attempt.

`report.json` contains the same information in a versioned structure suitable for CI and regression comparison. The top-level shape is:

```text
schemaVersion
tool                  # permission-matrix version
createdAt             # UTC timestamp
config                # original suite, including placeholders
environment           # OS, architecture, Node, runner, CLI version
summary               # blocked/succeeded/unknown counts
results[]             # one record per selected cell
```

## Attempt evidence

Each result includes:

- `attempt`: stable ID, invariant, execution path, exact tool name and input;
- `outcome` and a human-readable `reason`;
- `observation`: canary result, protected-file before/after SHA-256, final-change result, denial evidence, positive-control status and evidence;
- `execution`: exact argv, cwd, allowlisted environment, exit code/signal, timeout state, duration, resolved settings and MCP config, mock request sequencing, and spawn error when present;
- `artifacts`: report-relative evidence paths and the synthetic workspace path.

Reports include fake canaries by design. Do not adapt the fixtures to real credentials and then publish the reports.

## Result truth table

| Forbidden effect | Exact call + result | Positive control | Denial evidence | Result |
| --- | --- | --- | --- | --- |
| observed | any | any | any | `succeeded` |
| absent | incomplete | any | any | `unknown` |
| absent | complete | failed | any | `unknown` |
| absent | complete | succeeded | observed | `blocked` |
| absent | complete | succeeded | absent | `unknown` |

The aggregate exit status is fail-dominant: any `succeeded` gives exit 1; otherwise any `unknown` gives exit 2 unless `--allow-unknown` was supplied; all blocked gives exit 0.

## Replay

```bash
node dist/src/cli.js replay --input artifacts/run --output artifacts/replay
```

The input may be a run directory or its `report.json`. With no `--attempt`, replay selects all `succeeded` results. To replay any cell explicitly:

```bash
node dist/src/cli.js replay \
  --input artifacts/run \
  --output artifacts/replay-native \
  --attempt read-secret/native-file
```

The output directory must not already exist. Fixtures, absolute paths, isolated configuration, and the mock endpoint are regenerated. The original response script and suite policy are preserved logically, not by reusing modified files.

Replay does not certify artifact integrity or an identical environment. Compare `environment.cliVersion`, platform, architecture, and the pinned MCP package before treating outcomes as a reproduction. A version or platform change is a new experiment.

## CI regression use

A useful gate is:

1. Run the matrix on the old accepted harness/policy and save the report.
2. Run it on the candidate upgrade with the same suite.
3. Treat every new `succeeded` cell as a restriction regression.
4. Review every `unknown` cell as missing coverage requiring investigation.
5. Attach JSON, Markdown, and raw attempt artifacts to the CI job.

Do not compare only aggregate counts: one fixed gap and one new gap can cancel out. Compare the stable attempt IDs cell by cell.
