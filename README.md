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
│   │       ├── review-result-v2.schema.json # normalized v2 envelope schema
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
2. **`detect --json`** discovers the four supported harness IDs from explicit
   `*_BIN` overrides, `PATH`, npm's Windows bin directory, and known local bin
   directories; each candidate receives a bounded `--version` probe.
3. **`audit`** applies configured role routing (or legacy Claude/Codex fan-out),
   writes the prompt to **stdin** (never argv), and launches the reviewer in a
   bounded subprocess with a 300-second timeout and capped stdout/stderr.
4. **Host scope gate** builds a changed-file allowlist from Git, sends a hard
   scope boundary to the reviewer, and rewrites any finding whose
   `evidence.file` is outside the allowlist to `verification: out_of_scope`.
5. **Normalization** unwraps Claude JSON (including prose-wrapped Markdown JSON
   fences), Cursor NDJSON, and OpenCode JSONL into the strict v2 contract
   (`review-result-v2.schema.json`).
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
skills/cross-harness-review/scripts/invoke.ps1 detect --json   # Windows
skills/cross-harness-review/scripts/invoke.sh detect --json    # POSIX / Git Bash
```

Then ask Grok, either explicitly or in natural language:

```text
/cross-harness-review code --uncommitted

# or just:
"give me a Claude + Codex cross-review of my uncommitted changes before I commit"
```

### Bridge CLI (advanced / scripting)

```text
invoke.ps1|invoke.sh detect --json
invoke.ps1|invoke.sh setup --plan <id> --code <id> --tests <id> [--enable-tests]
invoke.ps1|invoke.sh audit plan --plan-file <path> --repo <path> --json
invoke.ps1|invoke.sh audit code --plan-file <path> --repo <path> --scope <selector> --json
invoke.ps1|invoke.sh audit security --repo <path> --scope <selector> --json
invoke.ps1|invoke.sh audit tests --repo <path> --json
```

Never concatenate user input into a shell string — pass every value as an
individual process argument.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `CROSS_HARNESS_CONFIG` | Absolute user-config path override | platform default |
| `CROSS_HARNESS_CLAUDE_BIN` | Explicit Claude executable | auto-discovered |
| `CROSS_HARNESS_CODEX_BIN` | Explicit Codex executable | auto-discovered |
| `CROSS_HARNESS_OPENCODE_BIN` | Explicit OpenCode executable | auto-discovered |
| `CROSS_HARNESS_CURSOR_BIN` | Explicit Cursor executable | auto-discovered |

A broken explicit-executable override fails closed — it does **not** silently
fall back.

## Status

Current checkout: **v0.2.0-dev** (unreleased).

| Area | State |
|---|---|
| Node CLI, compatibility shims, detect and setup | Ready |
| Node offline test matrix | Ready |
| Scope snapshot + host scope gate | Ready |
| Claude | Real CLI invocation verified; decorated JSON is normalized before strict v2 validation |
| Codex / OpenCode adapters | Capability-gated; a local `process_failed` may still require host auth/config diagnosis |
| Cursor | Detection only until safe isolation is verified; roles fail closed |
| Direct tests | Disabled unless user + project policy and adapter event capabilities all pass |

See the [v0.2.0 Grok host smoke record](docs/verification/v0.2.0-grok-host-smoke.md)
for the supplied real-CLI evidence and its host/sandbox boundary.

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
