# v0.2.0 release checklist

This checklist records the public release contract for `0.2.0`.

## Release scope

- [x] Public reviewer IDs are `claude`, `codex`, and `opencode`.
- [x] Cursor preparation is retained in source but is not discoverable,
  configurable, assignable, or accepted by the public result schema.
- [x] No hooks, agents, or active MCP server are shipped.
- [x] Direct host tests are disabled unless user policy, project allowlist, and
  adapter capability gates all pass.

## Identity and package

- [x] `package.json`, `package-lock.json`, and `plugin.json` use `0.2.0`.
- [x] README documents installation and the v0.2.0 `detect ? setup ? roles`
  workflow.
- [x] CHANGELOG contains the v0.2.0 release notes.
- [x] `npm pack --dry-run` has been reviewed for its exact published file list.
- [x] The package content scan found no token, private-key, or credential match.

## Verification

- [x] `npm.cmd run test:node` passes.
- [x] `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/probe.Tests.ps1` passes.
- [x] `grok plugin validate .` passes.
- [x] `git diff --check` passes.
- [x] The published tarball has no tests, local planner output, npm cache, or
  temporary work directories.

## Publication

- [ ] Commit the release tree only; do not include `.zcode/`.
- [ ] Tag `v0.2.0` at the release commit.
- [ ] Push the branch and tag to `origin`.
- [ ] Create the GitHub Release with the v0.2.0 notes below.
- [ ] Publish to npm only after checking the account and package ownership.
