# Phase A release verification

Date: 2026-07-17

- Local manifest validation: passed for 4.0.0; re-run required for 4.1.0.
- PowerShell and POSIX fake matrices: passed (4.0.0 baseline).
- Review schema and fixtures: valid Draft 2020-12 JSON Schema; 4.1.0 adds `out_of_scope` + `diagnostics.scope`.
- Claude real tasks: passed on 4.0.0; deterministic session cleanup verified.
- Windows and WSL Codex: passed on 4.0.0.
- Grok plan/code/tests/security slash flows: passed with correct dual-success and degradation behavior.
- Canary hashes/status/list: unchanged on 4.0.0 canary.
- Installed component inventory (4.1.0 target): two skills (`cross-harness-review`, `cross-harness-auto`), zero agents, zero hooks, zero MCP servers.
- Scope gate + auto skill: implemented in 4.1.0; complete [docs/ACCEPTANCE.md](../ACCEPTANCE.md) before GitHub tag.
- Optional Phase B MCP: not installed and not required for Phase A release.
