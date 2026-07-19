# Setup guide

## Requirements

Install Grok, Node.js 20+, Git, and at least one authenticated supported reviewer CLI. Detection uses a bounded `--version` probe; a version result alone is not authentication, quota, or capability proof.

## Install

```text
grok plugin validate <plugin-root>
grok plugin install <absolute-plugin-root> --trust
grok plugin enable cross-harness-review
grok plugin list --json
grok inspect --json
```

The installed plugin should report two skills (`cross-harness-review`, `cross-harness-auto`) and no agents, hooks, or MCP servers.

## Overrides

Create a user configuration with direct test execution disabled:

```text
cross-harness-review detect --json
cross-harness-review setup --plan claude --code claude --tests claude --json
cross-harness-review roles --json
```

Only add `--enable-tests` when the selected adapter reports verified structured events, approved-command restriction, and direct execution. The setup command fails closed otherwise.

```text
CROSS_HARNESS_CONFIG
CROSS_HARNESS_CLAUDE_BIN
CROSS_HARNESS_CODEX_BIN
CROSS_HARNESS_OPENCODE_BIN
CROSS_HARNESS_CURSOR_BIN
```

A broken explicit executable override fails closed and does not silently fall back. Review subprocesses use a 300-second default timeout and capped output.

## Skills after install

- `cross-harness-review` — explicit slash workflow (`disable-model-invocation: true`)
- `cross-harness-auto` — model-invocable guidance for when Grok may auto-run a review

## Shell behavior

- PowerShell uses `skills/cross-harness-review/scripts/invoke.ps1`.
- Linux, WSL, and Git Bash use `invoke.sh` when a native executable is available.
- On Windows, shell wrappers (`.cmd`, `.bat`, `.ps1`) are rejected; configure a native `.exe` override rather than enabling shell parsing.

## Troubleshooting

- `authentication_failed`: sign in with the selected CLI.
- `quota_exhausted`: wait or restore provider quota; the other reviewer result remains usable.
- `permission_failed`: confirm the repository is readable and session cleanup is permitted.
- `invalid_output`: provider output did not match the strict envelope; it is never interpreted as zero findings.
- Findings marked `out_of_scope`: host gate rejected `evidence.file` outside the allowlist; do not treat them as in-scope defects.
- Codex scope failures on disposable repositories may be caused by Git dubious-ownership protection. Fix ownership or create the repository as the invoking user; do not add a global wildcard safe-directory exception.

Run both fake matrices before provider testing. Phase B MCP remains optional and no active `.mcp.json` is shipped.
