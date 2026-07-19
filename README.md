# Cross-Harness Review

Cross-Harness Review is a Grok plugin and Node CLI for obtaining a bounded,
read-only second opinion from external coding harnesses. Grok remains the
decision maker: every reviewer result is untrusted evidence that must be
verified locally before any change is made.

## v0.2.0 at a glance

- Supported reviewer IDs: `claude`, `codex`, and `opencode`.
- One Node core owns discovery, configuration, routing, bounded execution, and
  normalized v2 results. PowerShell and POSIX scripts are forwarding shims.
- Prompts are sent on stdin, output is bounded, and review scope is enforced by
  a host-computed Git snapshot.
- Direct host test execution is opt-in and fails closed unless the user policy,
  project allowlist, and adapter capabilities all permit it.
- Cursor is deliberately deferred. Its preparatory source remains in the
  repository but is not discoverable, configurable, assignable, or accepted by
  the public result schema.

## Requirements

- Grok CLI with plugin support.
- Node.js 20 or later.
- Git on `PATH`.
- At least one authenticated reviewer CLI: Claude Code (`claude`), OpenAI
  Codex (`codex`), or OpenCode (`opencode`).

## Install

### npm package

```bash
npm install -g @sidler289-code/cross-harness-review
grok plugin install "$(npm root -g)/@sidler289-code/cross-harness-review" --trust
grok plugin enable cross-harness-review
```

### GitHub checkout

```bash
grok plugin install https://github.com/sidler289-code/GrokBuild-outsideHarness.git --trust
grok plugin enable cross-harness-review
```

Verify the installation:

```bash
cross-harness-review --version
grok inspect
```

The CLI should report `0.2.0`. Grok should list the two skills
`cross-harness-review` and `cross-harness-auto`, with no hooks, agents, or
active MCP server.

## v0.2.0 workflow

Discover installed reviewer CLIs, persist an explicit role mapping, and verify
it before an audit:

```bash
cross-harness-review detect --json
cross-harness-review setup --plan claude --code codex --tests opencode --json
cross-harness-review roles --json
```

The example assigns three roles explicitly. You may use one, two, or three of
the supported IDs, subject to their capability gates. `setup` does not enable
direct test execution by default. Do not pass `--enable-tests` until the
selected adapter has verified structured events, approved-command restriction,
and direct execution.

### Run reviews

```bash
cross-harness-review audit plan --plan-file docs/plan.md --repo . --json
cross-harness-review audit code --plan-file docs/plan.md --repo . --scope uncommitted --json
cross-harness-review audit security --repo . --scope base:main --json
cross-harness-review audit tests --repo . --json
```

From Grok, use the explicit slash workflow, for example:

```text
/cross-harness-review code --uncommitted
```

Natural-language requests may invoke the auto skill when appropriate. Reviewer
output never has authority to edit the working tree.

## Configuration

| Variable | Purpose |
|---|---|
| `CROSS_HARNESS_CONFIG` | Absolute user-config path override |
| `CROSS_HARNESS_CLAUDE_BIN` | Explicit Claude executable |
| `CROSS_HARNESS_CODEX_BIN` | Explicit Codex executable |
| `CROSS_HARNESS_OPENCODE_BIN` | Explicit OpenCode executable |

A broken explicit override fails closed; it does not fall back to another
binary. On Windows, shell wrappers (`.cmd`, `.bat`, `.ps1`) remain
rejected by the argv-only subprocess runner.

## Security boundary

- Claude uses a restricted tool set and empty MCP configuration.
- Codex uses a read-only, ephemeral sandbox and ignores user config and rules.
- Prompts travel through stdin, not argv; output and diagnostics are capped.
- No permission or sandbox bypass flags are used.
- Findings outside the selected Git scope are downgraded to
  `verification: out_of_scope`.

See [SECURITY.md](SECURITY.md), [the v0.2.0 verification record](docs/verification/release.md), and [the host smoke record](docs/verification/v0.2.0-grok-host-smoke.md) for the evidence boundary and release details.

## Local validation

```powershell
grok plugin validate .
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/probe.Tests.ps1
npm.cmd run test:node
npm.cmd pack --dry-run
```

## License

MIT ? see [LICENSE](LICENSE).
