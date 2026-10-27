# Configuration

A suite is a JSON object. Start with `examples/claude-code.json`, copy it, and keep the original in version control.

## Top-level fields

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | Must be `1`. |
| `name` | yes | Human-readable suite name copied into reports. |
| `runner` | yes | Must be `claude-code` in v0.1. |
| `cliPath` | no | Executable name or absolute path; defaults to `claude`. |
| `model` | no | Model identifier sent through the mock protocol; defaults to `claude-sonnet-5-5`. No live model is called. |
| `timeoutMs` | no | Per-attempt CLI timeout; defaults to 60000. |
| `settings` | yes | Claude Code settings object, normally including `permissions.allow` and `permissions.deny`. |
| `filesystemMcp` | yes | MCP stdio server definition with `command` and `args`. It is enabled only for MCP cells. |

Unknown settings are preserved in the resolved configuration and artifacts. Claude Code may reject settings it does not support; that produces an execution problem or `unknown`, not a blocked result.

## Placeholders

Strings are recursively rendered in `settings` and `filesystemMcp`:

| Placeholder | Value |
| --- | --- |
| `{root}` | Disposable attempt workspace |
| `{secret}` | Absolute fake-credential path |
| `{protected}` | Absolute protected-file path |
| `{repository}` | Disposable repository directory |
| `{quotedSecret}` | POSIX-shell-quoted secret path |
| `{quotedProtected}` | POSIX-shell-quoted protected path |
| `{quotedTampered}` | POSIX-shell-quoted replacement content used by the shell write |

Use the quoted placeholders only inside Bash rule strings. Native Read/Edit/Write rules need the unquoted absolute path.

Claude Code absolute path patterns begin with `//`. Therefore `Read(//{secret})` is intentional: with a Linux path such as `/tmp/run/secret`, it resolves to `Read(///tmp/run/secret)`.

## Policy example

```json
"settings": {
  "permissions": {
    "allow": ["Read", "Edit", "Bash", "mcp__filesystem"],
    "deny": [
      "Read(//{secret})",
      "Write(//{protected})",
      "Edit(//{protected})",
      "Bash(cat {quotedSecret})",
      "Bash(printf {quotedTampered} > {quotedProtected})"
    ]
  }
}
```

Deny rules take precedence over allows. Keep rules scoped: a bare deny such as `Read` can remove the tool from the model and make the control impossible to exercise. Permission Matrix will report that cell as `unknown` rather than claiming successful path coverage.

The Bash rules match the exact scripted operations in v0.1. They are not general shell confinement. Alternate commands, interpreters, and wrappers require their own tests or an OS sandbox. See Claude Code's [permission rules](https://code.claude.com/docs/en/permissions).

## MCP server

The tested server definition is:

```json
"filesystemMcp": {
  "command": "npx",
  "args": [
    "-y",
    "@modelcontextprotocol/server-filesystem@2.0.1",
    "{root}"
  ]
}
```

Version 2.0.1 requires Node.js 24 or newer. Its positional directory is an application-level allowed root, not a read-only mount or OS sandbox. Giving it `{root}` deliberately makes both synthetic targets accessible so a policy gap has an observable effect. Give production MCP servers the smallest practical root set.

MCP configuration is empty for native and shell cells. All cells use `--strict-mcp-config`, preventing ambient user/project MCP servers from entering the experiment. See the [filesystem server documentation](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md) and Claude Code's [MCP documentation](https://code.claude.com/docs/en/mcp).

## Preflight

```bash
node dist/src/cli.js validate --config examples/claude-code.json
```

Validation checks the suite shape and executes `<cliPath> --version`. It does not contact a live model or start the MCP server. Those paths are checked by each attempt's positive control.
