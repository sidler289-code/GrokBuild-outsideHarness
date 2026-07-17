# Acceptance checklist (GitHub release readiness)

Use this before tagging a public release.

## 0. Identity

- [ ] `plugin.json` version matches `CHANGELOG.md` top entry
- [ ] README status table is accurate
- [ ] LICENSE present
- [ ] SECURITY.md redaction guidance is correct
- [ ] No secrets, tokens, private paths, or canary credentials in the tree

## 1. Package shape

- [ ] `plugin.json` validates (`grok plugin validate .`)
- [ ] Skills present:
  - [ ] `skills/cross-harness-review/SKILL.md` (slash / explicit)
  - [ ] `skills/cross-harness-auto/SKILL.md` (model-invocable)
- [ ] Bridge scripts present and executable on target OS:
  - [ ] `skills/cross-harness-review/scripts/invoke.ps1`
  - [ ] `skills/cross-harness-review/scripts/invoke.sh`
- [ ] Schemas present and Draft 2020-12 valid
- [ ] Zero hooks, zero agents, no active MCP required for Phase A
- [ ] `config/empty-mcp.json` present

## 2. Automated gates

- [ ] `powershell -NoProfile -ExecutionPolicy Bypass -File tests/probe.Tests.ps1` passes
- [ ] `bash tests/probe.tests.sh` passes on a POSIX host (or documented as Windows-primary for this tag)
- [ ] Fake matrix covers: success, quota, auth, permission, process failure, invalid output, timeout, out-of-scope gate

## 3. Functional smoke (real CLIs, optional but recommended)

On a machine with authenticated Claude and/or Codex:

- [ ] `invoke.* probe --json` shows expected availability
- [ ] `run --task code --scope uncommitted` against a tiny disposable repo
- [ ] Scope gate: plant a finding for a non-allowlisted file (or use fake mode) → `out_of_scope`
- [ ] Binary-only change yields metadata-aware summary, not invented line findings
- [ ] Plan review with a tiny plan file succeeds or degrades honestly

## 4. Grok integration

- [ ] `grok plugin install <path> --trust`
- [ ] `grok plugin enable cross-harness-review`
- [ ] `grok inspect` lists both skills; plugin enabled
- [ ] Slash: `/cross-harness-review code --uncommitted` works
- [ ] Natural language: “帮我用 Claude/Codex 交叉审查未提交改动” triggers auto skill behavior
- [ ] Host verifies candidates; does not auto-edit solely from reviewer output

## 5. Safety regression

- [ ] No argv leakage of plan/diff secrets (stdin only)
- [ ] No sandbox/permission bypass flags in recorded fake argv
- [ ] Claude session JSONL cleanup still works (or fails closed as `permission_failed`)
- [ ] Codex uses read-only + ephemeral + ignore-user-config/rules

## 6. GitHub publish steps

1. `git init` (if needed), add remote, ensure `.gitignore` excludes temp/test workdirs
2. Commit release tree only
3. Tag `vX.Y.Z` matching `plugin.json`
4. Push branch + tag
5. Create GitHub Release notes from `CHANGELOG.md`
6. Document install:

```bash
grok plugin install <owner>/<repo> --trust
# or
grok plugin install https://github.com/<owner>/<repo>.git --trust
```

7. Post-release: install from GitHub on a clean machine and re-run section 4

## 7. Known non-goals (do not block Phase A)

- Automatic code patching from reviewer output
- MCP server surface (Phase B optional)
- Guaranteed provider quality (providers remain probabilistic)
- Full-repo review without an explicit base/commit scope
