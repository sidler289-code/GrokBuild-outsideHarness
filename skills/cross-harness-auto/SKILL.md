---
name: cross-harness-auto
description: >-
  Decide when to launch a read-only cross-harness review via local Claude/Codex
  bridges without requiring the user to type /cross-harness-review. Use when the
  user asks to review code, review a plan, review tests, review security, get a
  second opinion, dual-review, cross-check with Claude or Codex, pre-commit
  review, PR readiness check, or wants external validation of recent changes.
  Also use proactively after large non-trivial edits when the user asks you to
  be careful, verify thoroughly, or prepare a PR/release. Do not use for pure
  formatting, one-line renames, or when the user forbids external tools.
user-invocable: true
disable-model-invocation: false
compatibility: "Requires the cross-harness-review plugin bridge and at least one runnable Claude or Codex CLI."
---

# Cross-Harness Auto (model-invocable)

This skill tells you **when and how** to run the cross-harness bridge without
waiting for a slash command. The bridge implementation and safety rules live
next to `skills/cross-harness-review/`.

## When you SHOULD auto-run

Launch a review when **any** of the following is true:

1. The user explicitly asks for review, second opinion, dual review, Claude/Codex
   cross-check, pre-commit review, PR readiness, or security pass.
2. You just finished a **non-trivial** change set (new feature, auth/data path,
   SQL/network/fs changes, multi-file refactor) and the user asked you to be
   careful, verify thoroughly, check work, or prepare release/PR.
3. The user asks whether the current plan is sound and a plan file already exists
   in the conversation.

Default task mapping:

| User intent | Task | Default scope |
|---|---|---|
| review recent edits / uncommitted work | `code` | `uncommitted` |
| review vs main/master/base branch | `code` | `base:<branch>` |
| review a specific commit | `code` | `commit:<sha>` |
| test strategy / missing tests | `tests` | same scope rules as code |
| threat model / injection / secrets | `security` | same scope rules as code |
| design/plan critique | `plan` | plan file path |

## When you MUST NOT auto-run

- User said no external tools, offline only, or do not call Claude/Codex.
- Change set is trivial (typo, comment, pure formatting, single rename) and user
  did not ask for review.
- No role-eligible reviewer from `detect --json`.
- Plan task but no concrete plan file is known.
- The repository path is not the current workspace root (unless the user named
  another repo explicitly).
- Secrets-bearing paths dominate the scope and the user did not approve sending
  them (disclose and ask first).

## Required preflight

1. Briefly disclose the data boundary (repo path, task, scope, that content may
   be sent to local Claude/Codex CLIs which may call their providers).
2. Resolve the sibling plugin skill directory:
   `../cross-harness-review/` relative to this skill, then `scripts/invoke.ps1`
   or `scripts/invoke.sh`.
3. Run `detect --json`. If no role-eligible reviewer is available, stop and say so.
4. Run one canonical `audit <task> ... --json` command; configured routing or
   legacy Claude/Codex fan-out is owned by the host. Prefer the default timeout
   (300s). Do not concatenate user input into shell strings.

## After results

1. Ignore `verification: out_of_scope` findings for in-scope conclusions.
2. Locally open and verify remaining candidates before recommending fixes.
3. Never treat external success as approval to edit; only the user's request
   authorizes code changes.
4. If one reviewer fails and the other succeeds, keep the successful result and
   report the failure honestly.
5. Summarize: in-scope verified findings, out-of-scope discarded count, and
   recommended next actions.

## Relationship to the slash command

- `/cross-harness-review ...` remains the explicit user entrypoint
  (`disable-model-invocation: true` on that skill).
- This auto skill is the model entrypoint. Prefer it when the user's natural
  language already requests review; you do not need them to retype the slash
  command.
