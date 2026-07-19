# fake-harness

Node-callable fake harness for the PR-2..PR-7 Node core test matrix.

This is the Node-side counterpart of `tests/fixtures/fake-cli/`. It exists so
that the bounded process runner, prompt-stdin canary, argv construction, and
event parsing can be tested deterministically without invoking a real Claude
or Codex CLI.

Behavior is controlled by environment variables (which the Node test runner
must set explicitly — no ambient inheritance):

| Env var | Effect |
|---|---|
| `FAKE_HARNESS_MODE` | `success` (default), `fail`, `timeout`, `huge`, `malformed`, `echo-argv`, `echo-stdin` |
| `FAKE_HARNESS_EXIT_CODE` | Override exit code (default 0 for success, 1 for fail) |
| `FAKE_HARNESS_SLEEP_MS` | Sleep before exit, used by `timeout` mode |
| `FAKE_HARNESS_OUTPUT_BYTES` | For `huge`: emit this many bytes to stdout |

Hard rules enforced by the fixture itself:

- It MUST NOT read the prompt from argv. If `FAKE_HARNESS_MODE=echo-argv`,
  it prints the argv it received; if `echo-stdin`, it prints what arrived on
  stdin. Tests for prompt-canary use `echo-stdin` together with an assertion
  that the argv contains no prompt content.
- It MUST NOT touch the network or files outside this directory.

This fixture is loaded by Node's `child_process.spawn` using an absolute path
to `index.cjs`, with `node` as argv[0]. It is never invoked via the system
shell.
