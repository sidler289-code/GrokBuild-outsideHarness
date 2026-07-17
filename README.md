# Cross-Harness Review

> A **Grok plugin** that lets Grok call **external coding harnesses and their
> models** — currently [Claude Code](https://docs.claude.com/en/docs/claude-code)
> and [OpenAI Codex](https://github.com/openai/codex) — to get a read-only
> **second opinion** on your code, plans, tests, and security.

Grok stays in the driver's seat. This plugin is a **transport**, not an
authority: the external reviewer runs in a locked-down, read-only sandbox, and
its output is treated as *untrusted candidate evidence* that Grok verifies
before any fix.

```
 ┌───────────┐      slash / natural language      ┌──────────────────────────┐
 │           │  ────────────────────────────────▶ │  cross-harness-review    │
 │   Grok    │                                     │  plugin (this repo)      │
 │  (driver) │  ◀──────────────────────────────── │                          │
 │           │   normalized review envelope +      │  ┌─── bridge ────────┐   │
 └───────────┘   diagnostics.scope gate            │  │ invoke.ps1/.sh    │   │
       ▲                                          │  └────────┬───────────┘   │
       │ verified findings only                    └───────────┼───────────────┘
       │                                                      │ stdin, bounded
       │                                          ┌────────────▼────────────┐
       │                                          │  External harness (CLI) │
       └──────────────────────────────────────────┤  • Claude Code (claude) │
                                                  │  • OpenAI Codex (codex) │
                                                  │  read-only / sandboxed  │
                                                  └─────────────────────────┘
```

## Why

A single model can be confidently wrong. This plugin lets Grok pull in a
genuinely independent reviewer — a *different* harness with a *different*
model — for plan soundness, code-review depth, test-strategy gaps, and
security passes, without handing over control or write access.

Two invocation modes:

| Skill | Trigger | Use when |
|---|---|---|
| `cross-harness-review` | Slash only: `/cross-harness-review …` | You want an explicit, user-triggered review |
| `cross-harness-auto` | Model + slash | You want Grok to **auto-run** a review when you ask in natural language ("give me a second opinion", "cross-check with Claude before I open the PR") |

## What it reviews

```text
/cross-harness-review plan [plan-file]
/cross-harness-review code  [--uncommitted | --base <branch> | --commit <sha>]
/cross-harness-review tests  [same scope as code]
/cross-harness-review security  [same scope as code]
```

For `code` / `tests` / `security`, scope defaults to `--uncommitted`.

## Architecture

```
cross-harness-review/
├── plugin.json                 # Grok plugin manifest
├── package.json                # npm manifest (distribution)
├── skills/
│   ├── cross-harness-review/   # explicit slash skill (disable-model-invocation: true)
│   │   ├── SKILL.md            # workflow + safety invariants Grok follows
│   │   ├── scripts/
│   │   │   ├── invoke.ps1      # Windows bridge
│   │   │   └── invoke.sh       # POSIX / WSL bridge
│   │   └── schemas/
│   │       ├── review-result.schema.json   # normalized envelope schema
│   │       └── claude-result.schema.json   # Claude structured-output contract
│   └── cross-harness-auto/     # model-invocable skill (when to auto-run)
│       └── SKILL.md
├── config/
│   ├── empty-mcp.json          # explicitly empty MCP config (Phase A ships none)
│   └── setup-guide.md
├── tests/                      # PowerShell + POSIX fake-CLI matrices
└── docs/
    ├── ACCEPTANCE.md           # release checklist
    └── verification/           # phase gates
```

### How a review flows

1. **Grok** parses the request, discloses the data boundary, and resolves the
   sibling `scripts/` directory (no reliance on `GROK_PLUGIN_ROOT`).
2. **Bridge `probe --json`** discovers every candidate `claude` / `codex` on
   `PATH`, `%APPDATA%` / `npm`, `%LOCALAPPDATA%`, and WSL; probes each with
   `--version`; selects the highest executable semantic version.
3. **Bridge `run`** writes the prompt to **stdin** (never argv), launches the
   reviewer in a bounded subprocess with a per-run temp dir, a hard timeout
   (default 300s), and size-capped stdout/stderr.
4. **Host scope gate** builds a changed-file allowlist from Git, sends a hard
   scope boundary to the reviewer, and rewrites any finding whose
   `evidence.file` is outside the allowlist to `verification: out_of_scope`.
5. **Normalization** maps reviewer-specific output (Claude `structured_output`,
   Codex envelope) into one schema (`review-result.schema.json`).
6. **Grok** opens the cited evidence locally, confirms the call path, and only
   then acts. Reviewer output never edits files on its own.

### Safety invariants

- Claude plan review: **no tools**. Code-oriented review: `Read,Grep,Glob` only.
- Codex: `read-only` sandbox, `--ephemeral`, `--ignore-user-config`,
  `--ignore-rules`.
- Prompts travel on **stdin**; output and diagnostics are size-capped.
- No hooks, no agents, no active MCP server, no model override, no
  permission/sandbox bypass flags.
- Reviewer success is never approval to edit — only the user's request is.

See [SECURITY.md](SECURITY.md) for the full boundary and known limitations.

## Requirements

- **Grok CLI** with plugin support.
- At least one of:
  - **Claude Code CLI** (`claude`) — installed and authenticated.
  - **Codex CLI** (`codex`) — installed and authenticated.
- `git` on `PATH` (used for the scope snapshot and host scope gate).
- Optional on Windows: **WSL** if you want the reviewer to run inside a Linux
  distro.

## Install

Pick whichever path matches how you obtained the plugin. The plugin files are
identical in all three cases.

### Option A — Install from npm (recommended)

```bash
npm install -g @sidler289-code/cross-harness-review
```

Then point Grok at the installed package directory:

```bash
grok plugin install "$(npm root -g)/@sidler289-code/cross-harness-review" --trust
grok plugin enable cross-harness-review
grok plugin list
```

### Option B — Install directly from GitHub

```bash
grok plugin install https://github.com/sidler289-code/GrokBuild-outsideHarness.git --trust
grok plugin enable cross-harness-review
```

### Option C — Local checkout

```bash
git clone https://github.com/sidler289-code/GrokBuild-outsideHarness.git
grok plugin install /absolute/path/to/GrokBuild-outsideHarness --trust
grok plugin enable cross-harness-review
```

### Enable in config

Ensure `~/.grok/config.toml` contains:

```toml
[plugins]
enabled = ["cross-harness-review"]
```

### Verify

```bash
grok inspect
```

Should list two skills (`cross-harness-review`, `cross-harness-auto`) and
**no** agents, hooks, or MCP servers.

## Usage

Run a probe first to confirm the bridge can see your reviewer CLIs:

```bash
# From the plugin root, or wherever invoke.* lives after install
skills/cross-harness-review/scripts/invoke.ps1 probe --json    # Windows
skills/cross-harness-review/scripts/invoke.sh probe --json     # POSIX / Git Bash
```

Then ask Grok, either explicitly or in natural language:

```text
/cross-harness-review code --uncommitted

# or just:
"give me a Claude + Codex cross-review of my uncommitted changes before I commit"
```

### Bridge CLI (advanced / scripting)

```text
invoke.ps1|invoke.sh probe [--json]
invoke.ps1|invoke.sh run --reviewer claude|codex --task plan|code|tests|security
  --repo <absolute-path> [--input-file <absolute-path>]
  [--scope uncommitted|base:<branch>|commit:<sha>]
  [--timeout-secs <n>] --json
```

Never concatenate user input into a shell string — pass every value as an
individual process argument.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `CROSS_HARNESS_CLAUDE` | Explicit Claude executable path | (auto-discovered) |
| `CROSS_HARNESS_CODEX` | Explicit Codex executable path | (auto-discovered) |
| `CROSS_HARNESS_WSL_DISTRO` | Prefer a specific WSL distro | (default distro) |
| `CROSS_HARNESS_TIMEOUT_SECS` | Per-review process timeout | `300` |
| `CROSS_HARNESS_MAX_INPUT_BYTES` | Plan input size cap | `1048576` (1 MiB) |
| `CROSS_HARNESS_MAX_DIFF_BYTES` | Diff snapshot size cap | `204800` (200 KiB) |
| `CROSS_HARNESS_DEBUG` | `1` emits bridge stack traces on hard errors | (off) |

A broken explicit-executable override fails closed — it does **not** silently
fall back.

## Status

First public release: **v0.1** (`v0.1` tag, npm `0.1.0`).

| Area | State |
|---|---|
| Plugin install / skills / probe | Ready |
| PowerShell + POSIX fake CLI matrices | Ready |
| Scope snapshot + host scope gate | Ready |
| Real Claude / Codex providers | Supported when CLIs are installed and authenticated |
| Active MCP server | Not shipped in v0.1 (optional future work) |

## Local validation

```powershell
# From plugin root
grok plugin validate .
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/probe.Tests.ps1
# Optional on POSIX:
# bash --login tests/probe.tests.sh
```

## License

MIT — see [LICENSE](LICENSE).
