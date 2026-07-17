# Phase 0 verification

Date: 2026-07-17

Host evidence (not sandbox inference):

| Surface | Verified result |
|---|---|
| Grok | `0.2.101 (5bc4b5dfad)` |
| Claude | `2.1.181 (Claude Code)`, native npm executable |
| Windows Codex | `0.144.5`, local app-data executable |
| WSL | default and selected distribution `Ubuntu-24.04` |
| WSL Codex | `/home/omg051218/.local/bin/codex`, `0.144.4` |
| `wslpath` | converted the workspace to `/mnt/d/Claude code/grok build` |

No-sensitive PONG calls confirmed Claude and both Codex runtimes were authenticated and runnable. External data scope and read-only policy were user-approved. Gate 0 passed.
