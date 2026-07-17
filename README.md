# Cross-Harness Review

Explicit, read-only second opinions from **locally configured Claude Code and
OpenAI Codex CLIs**, orchestrated as a Grok plugin.

External output is **untrusted candidate evidence**. Grok must verify findings
before any fix. The bridge enforces scope allowlists, binary metadata rules, and
bounded process I/O.

## Status

| Area | State |
|---|---|
| Plugin install / skills / probe | Ready |
| PowerShell + POSIX fake CLI matrices | Ready |
| Scope snapshot + host scope gate | Ready (v4.1) |
| Default timeout | 300s (was 120s) |
| Real Claude / Codex providers | Supported when CLIs are installed and authenticated |
| Phase B MCP | Not required for Phase A |

## Install

```bash
grok plugin install <path-or-git-url> --trust
grok plugin enable cross-harness-review
grok plugin list
grok inspect
```

Local example (Windows):

```powershell
grok plugin install "D:\path\to\cross-harness-review" --trust
```

Ensure `~/.grok/config.toml` contains:

```toml
[plugins]
enabled = ["cross-harness-review"]
```

## Skills

| Skill | Invocation | Purpose |
|---|---|---|
| `cross-harness-review` | Slash only: `/cross-harness-review ...` | Explicit, user-triggered workflow |
| `cross-harness-auto` | Model + slash | Tells Grok **when** to auto-run a review without forcing the user to type the slash command |

### Slash commands

```text
/cross-harness-review plan [plan-file]
/cross-harness-review code [--uncommitted | --base <branch> | --commit <sha>]
/cross-harness-review tests [same scope as code]
/cross-harness-review security [same scope as code]
```

### Auto use (no slash required)

After install, Grok loads `cross-harness-auto` into the skill list. It should
auto-apply when you ask for reviews, second opinions, dual-checks with
Claude/Codex, pre-commit/PR readiness, or thorough verification of non-trivial
changes. You can still force the explicit slash form any time.

## Requirements

- Grok CLI with plugin support
- At least one of:
  - Claude Code CLI (`claude`)
  - Codex CLI (`codex`)
- `git` on PATH for repository scope snapshots

## Bridge CLI

```text
invoke.ps1|invoke.sh probe [--json]
invoke.ps1|invoke.sh run --reviewer claude|codex --task plan|code|tests|security
  --repo <absolute-path> [--input-file <absolute-path>]
  [--scope uncommitted|base:<branch>|commit:<sha>]
  [--timeout-secs <n>] --json
```

### Environment overrides

| Variable | Purpose |
|---|---|
| `CROSS_HARNESS_CLAUDE` | Explicit Claude executable |
| `CROSS_HARNESS_CODEX` | Explicit Codex executable |
| `CROSS_HARNESS_WSL_DISTRO` | Prefer a WSL distro |
| `CROSS_HARNESS_TIMEOUT_SECS` | Default process timeout (default 300) |
| `CROSS_HARNESS_MAX_INPUT_BYTES` | Plan input cap (default 1MiB) |
| `CROSS_HARNESS_MAX_DIFF_BYTES` | Diff snapshot cap (default 200KiB) |
| `CROSS_HARNESS_DEBUG` | Emit bridge stack traces on hard errors |

## What v4.1 improved

1. **Hard scope boundary in the prompt** for both Claude and Codex (allowlist + diff snapshot).
2. **Host scope gate** marks findings outside the allowlist as `verification: out_of_scope`.
3. **Binary / non-text awareness** (metadata only; no invented line-level claims).
4. **Default timeout 300s** for real provider runs.
5. **Auto skill** so Grok can start reviews from natural language.

## Safety boundary

- No hooks, agents, or active MCP configuration in Phase A.
- Claude plan review: no tools. Code-oriented: Read/Grep/Glob only.
- Codex: read-only sandbox, ephemeral, ignores user config/rules.
- User content travels on stdin, not argv.
- No permission/sandbox bypass flags.
- Reviewer text is never authority to edit.

See [SECURITY.md](SECURITY.md).

## Acceptance / release prep

See:

- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — release checklist
- [docs/verification/](docs/verification/) — phase gates
- [CHANGELOG.md](CHANGELOG.md)

### Local validation

```powershell
# From plugin root
grok plugin validate .
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/probe.Tests.ps1
# Optional on POSIX:
# bash --login tests/probe.tests.sh
```

## License

MIT — see [LICENSE](LICENSE).
