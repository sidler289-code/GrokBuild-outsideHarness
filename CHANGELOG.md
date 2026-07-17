# Changelog

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
