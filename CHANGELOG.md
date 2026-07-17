# Changelog

## 4.1.1 — 2026-07-17

### Fixed

- Scope-gate path normalization no longer corrupts evidence paths that start with characters in the `{'.', '/'}` set. `lstrip("./")` (Python) and the equivalent `-replace '^\./', ''` (PowerShell) were character-set operations and would mangle names like `.../dawn.js` → `awn.js`, silently mis-gating valid findings. Both bridges now strip `./`, `../`, and leading `/` as whole prefixes in a loop.
- A bad `--scope base:<branch>` or `--scope commit:<sha>` ref (typo, unpushed branch, unknown sha) no longer produces a silently-empty allowlist that marks every finding `out_of_scope`. Both bridges now run `git rev-parse --verify` first and surface a `Note` / `scope.note` that the gate is disabled because the ref could not be resolved.
- Claude session JSONL cleanup failure no longer discards an otherwise-valid review. Previously the whole result was overwritten with `status: permission_failed` and the findings were lost. Cleanup failure is now a non-fatal `diagnostics.warnings` entry; the review result and status are preserved.
- Added `diagnostics.warnings` (optional string array) to `review-result.schema.json` to carry non-fatal warnings without changing review status.

### Changed

- `SECURITY.md` documents the `--tools ''` (empty-string) Claude plan-review uncertainty as a known boundary, alongside the existing Claude CLI quirks. The stronger enforcement signals are `--permission-mode plan` and `--safe-mode`.

## 4.1.0 — 2026-07-17

### Added

- Host **scope snapshot** (changed file allowlist + truncated diff/content).
- Host **scope gate**: findings whose `evidence.file` is outside the allowlist are marked `verification: out_of_scope`.
- `diagnostics.scope` metadata (`mode`, `textFiles`, `binaryFiles`, `diffTruncated`, `gated`, `outOfScopeCount`).
- Binary / non-text classification for metadata-only review guidance.
- New model-invocable skill **`cross-harness-auto`** describing when Grok may launch reviews without a slash command.
- `CROSS_HARNESS_MAX_DIFF_BYTES` (default 200KiB).
- Fake-CLI coverage for out-of-scope finding gating.
- Acceptance checklist and release-oriented docs.

### Changed

- Default process timeout **120s → 300s**.
- Scope prompt injection now applies to **Claude and Codex** (previously Codex-leaning).
- Explicit skill docs updated for scope diagnostics and auto companion skill.
- Schema allows `verification: out_of_scope` and optional `diagnostics.scope`.

### Fixed

- Claude code reviews no longer rely on a soft one-line scope hint alone; they receive the same hard allowlist/diff package as Codex.

## 4.0.0 — 2026-07-17

- Phase 2 bridge complete: probe, bounded execution, schema normalization, fake matrices.
- Explicit slash skill `cross-harness-review` with `disable-model-invocation: true`.
