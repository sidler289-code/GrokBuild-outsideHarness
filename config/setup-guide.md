# Setup guide

## Requirements

Install Grok and at least one authenticated Claude or Codex CLI. The bridge probes every candidate with a five-second `--version` call and selects the highest executable semantic version; a version probe alone is not treated as authentication or quota proof. `git` is required for repository scope snapshots and the host scope gate.

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

```text
CROSS_HARNESS_CLAUDE
CROSS_HARNESS_CODEX
CROSS_HARNESS_WSL_DISTRO
CROSS_HARNESS_TIMEOUT_SECS
CROSS_HARNESS_MAX_INPUT_BYTES
CROSS_HARNESS_MAX_DIFF_BYTES
```

A broken explicit executable override fails closed and does not silently fall back. Set `CROSS_HARNESS_WSL_DISTRO` when the default distribution is not the intended reviewer runtime.

Default timeout is 300 seconds. Diff snapshots default to 200 KiB.

## Skills after install

- `cross-harness-review` — explicit slash workflow (`disable-model-invocation: true`)
- `cross-harness-auto` — model-invocable guidance for when Grok may auto-run a review

## Shell behavior

- PowerShell uses `skills/cross-harness-review/scripts/invoke.ps1`.
- Linux and WSL use `invoke.sh`.
- Git Bash keeps the POSIX probe/test implementation, but delegates a real Windows-native Claude invocation to the PowerShell bridge to avoid Windows console/Python pipe corruption.

## Troubleshooting

- `authentication_failed`: sign in with the selected CLI.
- `quota_exhausted`: wait or restore provider quota; the other reviewer result remains usable.
- `permission_failed`: confirm the repository is readable and session cleanup is permitted.
- `invalid_output`: provider output did not match the strict envelope; it is never interpreted as zero findings.
- Findings marked `out_of_scope`: host gate rejected `evidence.file` outside the allowlist; do not treat them as in-scope defects.
- Codex scope failures on disposable repositories may be caused by Git dubious-ownership protection. Fix ownership or create the repository as the invoking user; do not add a global wildcard safe-directory exception.

Run both fake matrices before provider testing. Phase B MCP remains optional and no active `.mcp.json` is shipped.
