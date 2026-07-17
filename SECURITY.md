# Security policy and boundary

This plugin is a read-only review transport, not an execution or patching authority.

## Guarantees

- No hooks, agents, active MCP server, model override, or permission/sandbox bypass flag.
- Reviewer prompts use stdin; output and diagnostics are bounded.
- Every invocation uses a unique temporary directory and final-output path.
- Claude tool access is empty for plans and limited to read/search/glob for repository reviews.
- Codex runs in its read-only sandbox with ephemeral state and ignored user rules/config.
- Reviewer output is schema-normalized and treated as untrusted candidate evidence.
- Host scope gate marks allowlist violations as `verification: out_of_scope` (does not execute them).
- Diff snapshots and plan inputs are size-capped (`CROSS_HARNESS_MAX_DIFF_BYTES`, `CROSS_HARNESS_MAX_INPUT_BYTES`).

## Known boundaries

A reviewer can still return incorrect or malicious text. Grok must verify file, line, symbol, reachability, and recommendation before action. Read-only access still sends the disclosed plan or repository content to the configured external provider.

Scope gates reduce whole-repo drift; they do not prove provider honesty. Binary files may still appear in the allowlist as metadata-only entries.

Claude Code may persist session JSONL even with `--no-session-persistence`; the bridge assigns a UUID and deletes only the exact matching session JSONL under the Claude projects directory. Cleanup failure becomes `permission_failed`.

Codex's built-in `review --uncommitted` rejects a simultaneous custom prompt and does not reliably honor the required final schema. Code-oriented reviews therefore use generic `codex exec` with an explicit read-only scope package on stdin.

The auto skill (`cross-harness-auto`) only changes **when Grok may start** a review. It does not relax tool, sandbox, or verification rules.

## Reporting

Do not include credentials, tokens, full prompts, or private source excerpts in issue reports. Include plugin version, reviewer/runtime version, task, status, and redacted diagnostics.
