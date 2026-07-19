# Changelog

## 0.2.0-dev (unreleased)

Work-in-progress 0.2.0 delivery. Each PR is independently mergeable.

### PR-4 — Claude/Codex adapters and plan/code/security audits

- **`lib/adapters/{index,claude,codex}.cjs`**: adapter contract (plan section 8)
  for Claude Code and OpenAI Codex. Read-only, no permission-bypass flags,
  prompt on stdin (never argv), isolated config (each invocation gets a fresh
  empty temp `CLAUDE_CONFIG_DIR`/`CODEX_HOME` so user hooks, agents, rules and
  stored auth cannot load). Codex zeroes ambient OpenAI credentials
  (`OPENAI_API_KEY`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT_ID`). Per-run temp
  directories are declared on `invocation.cleanupPaths` and removed by the
  adapter `cleanup`.
- **`lib/core/scope-snapshot.cjs`**: single owner of the host scope gate (plan
  9.2 / 12). Selectors `uncommitted`, `base:<ref>`, `commit:<sha>`,
  `ref:<a>..<b>`; repo-relative normalization that rejects absolute and `../`
  traversal; `isFileInScope` exact + nested-prefix matching. Ref names may not
  start with `-` so they cannot masquerade as git options.
- **`lib/core/prompt-builder.cjs`**: single owner of per-task prompts (plan
  9.1 / 9.2). Plan/code require a planFile; code/security require a scope
  snapshot; the strict scope boundary is spelled out in the prompt; extra
  instructions are bounded and explicitly framed as non-executable.
- **`lib/core/audit.cjs`**: audit orchestrator. Resolves reviewer(s) per plan
  2.4 (legacy claude+codex fan-out, single-reviewer degradation, both-
  unavailable → `unavailable`, configured-mode routing, explicit `--reviewer`
  one-shot override that never persists). Applies the capability gate per
  call, refuses to run if the adapter tries to place the prompt in argv,
  downgrades out-of-scope findings to `verification:"out_of_scope"`, stamps the
  host-computed planDigest over any reviewer-supplied value, and rejects an
  empty scope snapshot for code/security tasks (fail-closed).
- **`lib/policies/{plan,code,security}.cjs`**: pure policy descriptors
  consulted by the orchestrator.
- **CLI**: `audit plan|code|security` with the plan-5 subcommand shape and
  legacy `--reviewer <id> --task <task>` bridge parity. Fail-closed exit
  codes: only an all-success aggregate exits 0; unavailable exits 3; any
  transport failure / invalid output / capability mismatch exits 1.
- **`lib/core/bounded-process.cjs`**: Windows `.cmd`/`.bat`/`.ps1` wrappers
  now spawn with the per-element-quoting shell mode (post-CVE-2024-27980
  Node behavior); the prompt stays on stdin and adapter argv contains only
  fixed flags, so no shell injection surface is introduced.
- **Tests**: `scope-snapshot.test.cjs`, `prompt-builder.test.cjs`,
  `adapters.test.cjs` (prompt-canary, no-dangerous-flags, isolated config,
  cleanup), `audit.test.cjs` (legacy fan-out, explicit reviewer, scope
  downgrading, planDigest authority, tests-task refusal), entrypoints
  fail-closed exit code. Full suite: 169 passing.

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
