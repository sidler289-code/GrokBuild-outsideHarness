# Phase 4 verification: Codex

Date: 2026-07-17

Windows Codex 0.144.5 and Ubuntu-24.04 WSL Codex 0.144.4 both completed real strict-schema, read-only canary reviews. The WSL result retained `Ubuntu-24.04` and used real converted repository, schema, and output paths.

The CLI rejects `review --uncommitted` combined with a custom prompt, while built-in review did not produce the required schema output. The verified implementation therefore uses generic `codex exec` with `-C`, `-s read-only`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, strict `--output-schema`, unique `-o`, and a scope instruction on stdin.

Direct Windows and WSL calls returned `success`. Grok end-to-end also exercised honest single-side degradation when the disposable canary's Git ownership prevented a reliable scoped diff. Gate 4 passed.
