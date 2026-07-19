# Changelog

## 0.2.0 ? 2026-07-19

First public release of the Node-core workflow, role routing, bounded host test execution, and the supported Claude Code, OpenAI Codex, and OpenCode adapters.

- The supported harness set is finalized at three: Claude Code, OpenAI Codex,
  and OpenCode. Cursor is deliberately deferred: its adapter preparation stays
  in the source tree but is removed from discovery, configuration, schemas,
  role routing, and release scope until Windows launcher and rules/MCP
  isolation can be verified.
### Release hardening

These release-hardening entries supersede earlier per-PR slice notes wherever
the implementation contract changed.
- Replaced invalid Codex arguments with the current `exec --sandbox read-only
  --ephemeral --ignore-user-config --ignore-rules --output-schema` contract,
  while preserving the user's authentication context.
- Claude now uses `--safe-mode`, a fixed `Read,Glob,Grep` tool set, strict
  empty MCP config, and no session persistence without hiding its auth home.
- OpenCode no longer emits the undocumented `--pure` flag. Its inline config
  uses the documented `allow` / `deny` permission values and disables plugins
  and instructions.
- Cursor is deliberately unregistered. Its prepared adapter and tests remain
  private development material; it is neither discoverable nor assignable until
  Windows launcher handling and project-rule/MCP isolation have real canary
  evidence.
- Claude JSON wrappers and OpenCode JSONL events are
  unwrapped before the shared v2 normalizer runs.
- The shared normalizer now also recovers schema-valid JSON from reviewer prose,
  `json`/untagged Markdown fences, or a balanced outer object. This fixes real
  Claude runs whose high-quality result was previously mislabeled
  `invalid_output` solely because Claude decorated the JSON.
- Windows `.cmd`, `.bat`, and `.ps1` reviewer wrappers are rejected by the
  argv-only subprocess runner; it never enables `shell:true`. This keeps
  Cursor's Windows wrapper-only distribution out of the supported set.
- Restored the legacy `probe`, `run`, and `--input-file` spellings as aliases
  for the Node core. Legacy unconfigured `tests` remains a static review and
  never receives direct execution authority.
- Added a non-interactive, capability-gated `setup --plan ... --code ...
  --tests ...` command. Direct tests default to disabled; `--enable-tests`
  fails closed unless all three execution/event capabilities are verified.
- Synchronized the plugin manifest with package version `0.2.0` and updated
  the skills to consume `review-result-v2.schema.json`.

### Deferred ? Cursor adapter preparation (not registered)

- **`lib/adapters/cursor.cjs`**: Cursor CLI adapter (plan section 8.5 /
  10.5). Non-interactive `cursor-agent --print --output-format stream-json`
  invocation. **`--force` is never emitted** and any `--dangerously*` /
  `bypass` token is statically rejected at the adapter layer (the headline
  plan 8.5 guarantee). A fresh per-call permission-config file is written for
  every invocation denying the entire Write family (`Write`, `Edit`,
  `MultiEdit`) and every shell tool (`Shell`, `Bash`, `Terminal`); MCP is set
  to an empty list. Prompt is delivered on stdin (never argv). Each
  invocation redirects every Cursor config / state / cache root
  (`CURSOR_CONFIG_DIR`, `CURSOR_CACHE_DIR`, `CURSOR_STATE_DIR`, `XDG_*`) at a
  fresh empty temp dir so user rules, project rules, stored auth and on-disk
  MCP config cannot load; the temp dir + permission file are declared on
  `invocation.cleanupPaths` and removed by the adapter `cleanup`. Ambient
  provider credentials (`OPENAI_API_KEY` / `OPENAI_ORGANIZATION` /
  `OPENAI_PROJECT_ID` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` /
  `GOOGLE_API_KEY`) are zeroed defensively.
- **`lib/adapters/cursor.cjs`** remains in the source tree but is not imported
  by `lib/adapters/index.cjs`; the supported registry exposes only `claude`,
  `codex`, and `opencode`.
- **Capabilities**: all Cursor capabilities remain `unknown` while it is
  unregistered. A future integration must first prove Windows launcher safety,
  read-only enforcement, and rule/MCP isolation with real canaries.
- **Tests**: `tests/node/adapters-cursor.test.cjs` — private-preparation exclusion from the
  public registry, prompt canary, **no-`--force`** guarantee,
  `--print --output-format stream-json` argv shape, per-call permission
  config file denying Write/Edit/MultiEdit/Shell/Bash/Terminal, isolated env
  + zeroed credentials, capability declarations, normalize delegation,
  cleanup, and a distinct-per-invocation permission-file check. The PR-6
  opencode registry snapshot was extended to the four-adapter set. Full suite:
  201 passing.

### PR-6 — OpenCode adapter

- **`lib/adapters/opencode.cjs`**: OpenCode CLI adapter (plan section 8.3 /
  10.3). Non-interactive `opencode run --format json --pure` invocation;
  `--pure` skips external plugins so ambient plugin config cannot load for an
  audit turn. Per-call read-only permission policy is injected via
  `OPENCODE_CONFIG_CONTENT` (grants `read`; denies `edit`, `bash`, `web` and
  `external_directory`). Prompt is delivered on stdin (never argv).
  `--dangerously-skip-permissions` (and any `bypass`/`--force` token) is
  statically rejected at the adapter layer. Each invocation gets a fresh
  empty temp `OPENCODE_CONFIG_DIR` / `XDG_*` config + cache root so user
  plugins, rules, stored auth and on-disk config cannot load; the temp dir is
  declared on `invocation.cleanupPaths` and removed by the adapter `cleanup`.
  Ambient provider credentials (`OPENAI_API_KEY` / `OPENAI_ORGANIZATION` /
  `OPENAI_PROJECT_ID` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` /
  `GOOGLE_API_KEY`) are zeroed defensively.
- **`lib/adapters/index.cjs`**: `opencode` registered; the public registry
  exposes `claude`, `codex`, and `opencode`. Cursor preparation is deferred
  and not registered.
- **Capabilities**: read-side (`repoRead`, `structuredOutput`,
  `writeRestriction`) declared `verified`; the three tests-side capabilities
  (`structuredToolEvents`, `approvedCommandRestriction`,
  `directTestExecution`) stay `unknown` so the role router fails closed for
  the tests role until the live capability probe is wired (plan 7.3).
- **Tests**: `tests/node/adapters-opencode.test.cjs` — registry, prompt
  canary, no-dangerous-flags, `run --format json --pure` argv shape,
  `OPENCODE_CONFIG_CONTENT` permission policy, isolated env + zeroed
  credentials, capability declarations, normalize delegation, cleanup. The
  PR-4 `adapters.test.cjs` registry assertion was relaxed from an exhaustive
  two-adapter snapshot to the two original adapters (the exhaustive snapshot
  lives in the per-adapter test files and grows with each adapter PR). Full
  suite: 187 passing.

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
  claude/codex/opencode), PATH + known-dir candidate
  discovery, explicit-override fail-closed behavior (plan 7.2), and a bounded
  `--version` probe. `detectLegacyReviewers` reproduces the 0.1.0
  claude-then-codex fan-out order (plan 2.4).
- **`lib/core/role-router.cjs`**: 1/2/3-harness role allocation state machine
  (plan 2.2), per-role capability gating that fails closed on `unknown` and
  `failed` (plan 7.3), and the public `roles --json` shape for both
  configured and `legacy-unconfigured` modes (plan 2.4). Never fabricates a
  role mapping and never implicitly surfaces OpenCode in legacy mode.
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
