# Changelog

All notable changes are documented here. This project follows semantic versioning.

## 0.1.0 - 2026-10-27

### Added

- TypeScript CLI with `run`, `replay`, `report`, and `validate` commands.
- Six-cell Claude Code matrix covering native file, shell, and official filesystem MCP paths for fake-secret reads and protected-file modification.
- Loopback Anthropic Messages/SSE mock with preparation, positive-control, forbidden-call, and final-response sequencing.
- Independent exact-canary and protected-file final-state observations.
- Same-path positive controls and fail-dominant `blocked`/`succeeded`/`unknown` semantics.
- JSON/Markdown reports, exact resolved configuration and calls, raw transcripts, and fresh-workspace replay.
- Unit, fake-CLI end-to-end, and pinned real Linux integration CI coverage.

### Compatibility

- Tested locally with Claude Code 2.1.312 and `@modelcontextprotocol/server-filesystem` 2.0.1 on macOS arm64.
- [GitHub Actions Ubuntu integration](https://github.com/mikolalysenko/permission-matrix/actions/runs/40602318321) passed with four blocked, two succeeded, and zero unknown cells.
