# v0.2.0 release verification

Date: 2026-07-19

## Public contract

The release supports three external reviewer IDs: `claude`, `codex`, and
`opencode`. Cursor remains an unregistered preparation: it is excluded from
discovery, user configuration, role routing, CLI help, and the public v2
result schemas until its Windows launcher and project rule/MCP isolation have
real canary evidence.

## Local evidence

- Node test suite: 212 passing.
- PowerShell shim smoke: passed.
- Plugin manifest: `grok plugin validate .` passed.
- Package shape: `npm pack --dry-run` passed; the package contains only the
  explicit distribution allowlist.
- Privacy scan: no token, private-key, or credential-pattern match in the
  package file list.
- Contract checks: public discovery, adapter registry, user config, CLI help,
  and normalized results reject Cursor.

## Host evidence boundary

The supplied host smoke record remains evidence for the real CLI calls it
records. It is not a claim that every provider is authenticated on every host.
In particular, any Codex authentication/process failure must be diagnosed on
the host rather than attributed to this package without further evidence.

## Publication commands

```bash
git tag -a v0.2.0 -m "v0.2.0"
git push origin <branch>
git push origin v0.2.0
npm publish
```

Only run `npm publish` after `npm whoami` and package ownership checks
succeed. GitHub publication is complete only after the tag and GitHub Release
both exist.
