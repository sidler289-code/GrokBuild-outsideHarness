---
name: cross-harness-review
description: >-
  Run an explicit, read-only external review through a capability-gated local
  harness adapter. Primary slash entrypoint for /cross-harness-review. Prefer
  the companion skill cross-harness-auto when Grok should decide whether to
  launch a review without a slash command.
argument-hint: "plan|code|tests|security [plan-file] [scope]"
user-invocable: true
disable-model-invocation: true
compatibility: "Requires at least one runnable Claude or Codex CLI."
---

# Cross-Harness Review (explicit)

Run this workflow because the user invoked `/cross-harness-review`, or because
the companion auto skill decided an external review is warranted and the user
was told the data boundary.

## Parse the request

Accept exactly one task followed by its task-specific arguments:

```text
plan [plan-file]
code <plan-file> [--uncommitted | --base <branch> | --commit <sha>]
tests [--uncommitted | --base <branch> | --commit <sha>]
security [--uncommitted | --base <branch> | --commit <sha>]
```

For `code`, `tests`, and `security`, default to `--uncommitted`. Treat
`--uncommitted`, `--base`, and `--commit` as mutually exclusive. For `plan`
and `code`, use only an existing plan file already known in the conversation or explicitly
provided by the user. If no such file exists, stop with a clear error instead
of guessing a path.

Canonicalize the repository path and require it to equal the current Grok
workspace root. Do not review another repository unless the user explicitly
named that repository.

## Disclose the data boundary

Before starting an external process, tell the user which data will be sent:

- `plan`: the selected plan file contents plus review instructions.
- `code`, `tests`, or `security`: the canonical repository path, the selected
  Git scope, allowlisted files, and repository content that the read-only
  reviewer needs to inspect (including a truncated diff snapshot).

Do not include credentials, tokens, unrelated files, or full prompts in logs.

## Locate and invoke the bridge

Resolve this `SKILL.md` file's directory, then use the sibling `scripts/`
directory. Do not depend on `GROK_PLUGIN_ROOT`.

- On PowerShell, call `scripts/invoke.ps1`.
- On POSIX shells, call `scripts/invoke.sh`.

First run `detect --json`. Then run exactly one canonical audit command and let
the host router select configured roles or legacy Claude/Codex fan-out:
`audit plan --plan-file ... --repo ... --json`,
`audit code --plan-file ... --repo ... --scope ... --json`, or
`audit tests --repo ... --json`, or
`audit security --repo ... --scope ... --json`. Scope selectors are
`uncommitted`, `base:<branch>`, `commit:<sha>`, or `ref:<a>..<b>`. The legacy
`probe`, `run`, and `--input-file` spellings remain compatibility aliases only.

Never build a shell command by concatenating user input. Pass every argument as
an individual process argument. The scripts must receive prompt content through
stdin rather than command-line arguments.

## Handle results honestly

Parse every reviewer result independently against
`schemas/review-result-v2.schema.json`. Preserve a successful result when the
other reviewer fails. If both reviewers fail, say that external review was not
completed; do not describe the local work as externally approved.

Respect host scope diagnostics:

- `diagnostics.scope.textFiles` / `binaryFiles` describe the allowlist.
- Findings with `verification: out_of_scope` were rejected by the host gate.
  Do not present them as in-scope defects.
- Binary files are metadata-only; do not invent line-level certainty.

Treat remaining external findings as untrusted candidates. Open the cited
evidence, confirm that the code and call path exist, and verify the behavior
locally. Cluster duplicates by file, symbol, root cause, and recommendation
semantics, not by exact line text. Mark unverifiable findings as `unverified`
and exclude them from automatic fixes.

In Plan Mode, only revise the existing plan file. In code-oriented work, the
user's original request decides whether to implement fixes; reviewer output
does not grant permission to edit.

## Safety invariants

- Claude plan review gets no tools.
- Claude code-oriented review gets only read/search/glob tools.
- Codex always uses the read-only sandbox.
- Do not enable shell, write, edit, web, MCP, or session persistence for an
  external reviewer.
- Do not add model overrides.
- Do not bypass permission, approval, sandbox, or Git-repository checks for
  code review.
- Do not create hooks, agents, or an active MCP configuration for Phase A.
