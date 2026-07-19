# Changelog

## 0.2.0-dev (unreleased)

Work-in-progress 0.2.0 delivery. Each PR is independently mergeable.

### PR-3 — Config, discovery, doctor and role routing

- **`lib/core/config.cjs`**: the single owner of user-config path resolution
  (plan 6.2 priority: `CROSS_HARNESS_CONFIG` > Windows `LOCALAPPDATA`/`USERPROFILE`
  > POSIX `XDG_CONFIG_HOME`/`~/.config`), runtime schema validation (plan 6.3
  with `additionalProperties:false`, required roles, `testsExecution`
  boundaries, ISO 8601 timestamps), atomic write with `.bak` and preserved
  `createdAt` (plan 6.5), project config load (plan 6.4), and
  `legacy-unconfigured` detection when no file exists (plan 6.6).
- **`lib/core/discovery.cjs`**: stable harness registry (plan 2.3:
  claude/codex/opencode/antigravity/cursor), PATH + known-dir candidate
  discovery, explicit-override fail-closed behavior (plan 7.2), and a bounded
  `--version` probe. `detectLegacyReviewers` reproduces the 0.1.0
  claude-then-codex fan-out order (plan 2.4).
- **`lib/core/role-router.cjs`**: 1/2/3-harness role allocation state machine
  (plan 2.2), per-role capability gating that fails closed on `unknown` and
  `failed` (plan 7.3), and the public `roles --json` shape for both
  configured and `legacy-unconfigured` modes (plan 2.4). Never fabricates a
  role mapping and never implicitly surfaces opencode/antigravity/cursor in
  legacy mode.
- **CLI commands**: `config path`, `config show`, `detect [--json]`,
  `doctor [--json]`, `roles [--json]`. `setup` and the `audit` family are
  reserved for later 0.2.0 PRs and refuse non-interactively.
- **Tests**: `tests/node/config.test.cjs`, `discovery.test.cjs`,
  `role-router.test.cjs`. Full suite: 106 passing.

## 0.1.0 — 2026-07-17 (first public release, tag `v0.1`)

### Added

- **Grok plugin** that lets Grok call **external coding harnesses and their
  models** as read-only second-opinion reviewers. Initial providers:
  - **Claude Code** (`claude`) — locally configured CLI.
  - **OpenAI Codex** (`codex`) — locally configured CLI.
- Two skills:
  - `cross-harness-review` — explicit slash entrypoint
    (`/cross-harness-review plan|code|tests|security [scope]`).
  - `cross-harness-auto` — model-invocable; lets Grok decide when to launch a
    review from natural language without requiring the slash command.
- **Bridge CLI** (`invoke.ps1` / `invoke.sh`):
  - `probe --json` — discovers and semantic-version-probes every candidate
    Claude / Codex CLI on PATH, `%APPDATA%`, `%LOCALAPPDATA%`, and WSL.
  - `run --reviewer claude|codex --task plan|code|tests|security --repo …`
    with bounded subprocess execution, stdin-only prompt delivery, size-capped
    output, and per-run temp-directory isolation.
- **Host scope gate**: builds a changed-file allowlist from Git
  (`uncommitted` / `base:<branch>` / `commit:<sha>`), sends a hard scope
  boundary to the reviewer, and marks any finding whose `evidence.file` falls
  outside the allowlist as `verification: out_of_scope`.
- **Binary / non-text awareness**: binary file types are listed to the
  reviewer as metadata-only; the host gate does not invent line-level claims
  for them.
- **JSON Schema** for the normalized review envelope
  (`review-result.schema.json`) and Claude's structured output
  (`claude-result.schema.json`).
- PowerShell (`probe.Tests.ps1`) and POSIX (`probe.tests.sh`) fake-CLI test
  matrices covering success, quota, auth, permission, process failure,
  invalid output, timeout, and out-of-scope gating.
- `diagnostics.warnings` field on the review envelope for non-fatal warnings
  (e.g. session cleanup failure) without changing review status.
- Acceptance checklist and phase verification docs under `docs/`.

### Security boundary

- No hooks, agents, or active MCP server in this release.
- Reviewer prompts travel on stdin; output and diagnostics are size-capped.
- Every invocation uses a unique temporary directory.
- Claude plan review: no tools. Code-oriented review: `Read,Grep,Glob` only.
- Codex: read-only sandbox, ephemeral, ignores user config/rules.
- Reviewer text is schema-normalized and treated as **untrusted candidate
  evidence** — Grok must verify before acting.
- No permission/sandbox bypass flags.

See [SECURITY.md](SECURITY.md) for the full boundary, including known
limitations (Claude `--tools ''` semantics, Codex `--ignore-rules`, session
JSONL cleanup).

---

### Internal development history (pre-release, not tagged)

The following iterations happened before the first public tag. They are kept
here for traceability; no public release was made for them.

- `4.1.x` — host scope snapshot + host scope gate, binary classification,
  default timeout 120s → 300s, `cross-harness-auto` companion skill,
  `CROSS_HARNESS_MAX_DIFF_BYTES`, out-of-scope fake-CLI coverage.
- `4.0.x` — Phase 2 bridge: probe, bounded execution, schema normalization,
  fake matrices; explicit slash skill.
- Earlier fixes folded into 0.1.0:
  - Scope-gate path normalization no longer corrupts evidence paths that begin
    with characters in the `{'.', '/'}` set (`lstrip("./")` → whole-prefix
    strip loop in both bridges).
  - Unresolvable `base:<branch>` / `commit:<sha>` refs no longer produce a
    silently-empty allowlist; both bridges run `git rev-parse --verify` first.
  - Claude session JSONL cleanup failure no longer discards an otherwise-valid
    review; it is surfaced as a non-fatal `diagnostics.warnings` entry.
