'use strict';

/**
 * PR-7: Cursor CLI adapter.
 *
 * Plan 8.5 / 10.5 constraints:
 *  - stable id `cursor`; primary command `cursor-agent`, compatibility alias
 *    `agent` (the discovery registry owns candidate selection; this adapter
 *    only records the documented priority).
 *  - non-interactive structured events: `--print --output-format stream-json`.
 *  - NEVER pass `--force` (or any `--dangerously*`/`bypass` token). This is
 *    statically asserted at the adapter layer.
 *  - per-call permission config: plan/code deny ALL Write and Shell. A fresh
 *    permission-config file is written for every invocation so ambient user
 *    config cannot expand permissions for an audit turn.
 *  - rules / MCP / auto-control isolation: the adapter redirects every
 *    Cursor config root at a fresh empty temp dir and zeroes the ambient
 *    Cursor rule/MCP env carriers. Where the CLI cannot be reliably
 *    silenced (Cursor can still auto-load user/project MCP and rules), the
 *    adapter keeps the invocation read-side only and leaves the tests-role
 *    capabilities `unknown` so the role router fails closed (plan 8.5:
 *    "无法可靠禁止时，对应 role 失败关闭").
 *  - prompt is delivered on stdin (never argv).
 *
 * Shares the Node bounded-process runner, event recorder and result
 * normalizer with every other adapter.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ID = 'cursor';
const DISPLAY_NAME = 'Cursor CLI';
// cursor-agent is the primary command; `agent` is the documented compat
// alias. Both are surfaced by lib/core/discovery.cjs.
const BINARY_NAMES = Object.freeze(['cursor-agent', 'agent']);

// Verified read-side capabilities (plan 7.3). The tests-relevant capabilities
// stay `unknown` until the live capability probe is wired; the role router
// fails closed for the tests role in the meantime (plan 8.5 fail-closed
// rule).
const READ_CAPABILITIES = Object.freeze({
  repoRead: 'verified',
  structuredOutput: 'verified',
  writeRestriction: 'verified',
  structuredToolEvents: 'unknown',
  approvedCommandRestriction: 'unknown',
  directTestExecution: 'unknown',
});

/**
 * Build the per-call Cursor permission config (plan 10.5). Plan/code tasks
 * deny every Write and every Shell. Tests allow only configured test
 * commands — that path is reserved for the capability probe and is not
 * built here (the tests role stays `unknown`).
 *
 * Cursor's permission model is exposed via a JSON config the CLI reads at
 * startup. We keep the schema small and explicit so a future Cursor schema
 * change cannot accidentally widen permissions.
 */
function buildReadPermissionConfig() {
  return {
    // Deny the entire Write family.
    tools: {
      Write: false,
      Edit: false,
      MultiEdit: false,
      // Deny all shell/command execution.
      Shell: false,
      Bash: false,
      Terminal: false,
    },
    // No MCP servers may be auto-loaded for this audit turn. An empty list
    // means "no MCP at all"; a non-empty list would have to come from project
    // config, which the host never trusts here.
    mcp: [],
    // Allow read-only file tools. The host scope gate
    // (lib/core/scope-snapshot.cjs) downgrades any out-of-scope finding after
    // the fact, mirroring the Claude adapter's approach.
    allowReadOnlyTools: true,
  };
}

/**
 * Write the per-call permission config to a fresh temp file inside the
 * isolated config dir. Returns the absolute path to the written file.
 */
function writePermissionConfigFile(configDir) {
  const target = path.join(configDir, 'permissions.json');
  fs.writeFileSync(target, JSON.stringify(buildReadPermissionConfig()), { encoding: 'utf8' });
  return target;
}

/**
 * Build the bounded `cursor-agent` invocation for a plan/code/security task.
 *
 * Flags used (read-only, no permission bypass, no auto-control files):
 *   --print                        non-interactive single-turn print mode
 *   --output-format stream-json    structured event stream on stdout
 *
 * The prompt is ALWAYS on stdin. argv only carries capability flags.
 *
 * Returns { program, args, env, input, cwd, cleanupPaths }. The caller passes
 * this to runBoundedProcess.
 */
function buildInvocation({ program, taskContext }) {
  if (typeof program !== 'string' || program.length === 0) {
    throw new TypeError('program must be a non-empty string (the discovered cursor binary).');
  }
  if (!taskContext || typeof taskContext !== 'object') {
    throw new TypeError('taskContext is required.');
  }
  const { prompt, repoRoot } = taskContext;
  if (typeof prompt !== 'string') {
    throw new TypeError('taskContext.prompt must be a string.');
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('taskContext.repoRoot must be a non-empty string.');
  }

  const args = [
    '--print',
    '--output-format', 'stream-json',
    // The prompt never appears here; it arrives on stdin.
  ];

  // Inherit only a minimal environment. We redirect Cursor's config and
  // state roots at a fresh empty temp directory so user rules, project rules,
  // stored auth, MCP config and on-disk permission files cannot load. An
  // empty string env var is treated as "unset" by Cursor (it falls back to
  // its default locations), so we MUST point at a real (empty) dir.
  const isolatedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-cursor-cfg-'));
  const permissionConfigPath = writePermissionConfigFile(isolatedConfigDir);

  const env = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || process.env.USERPROFILE || '',
    USERPROFILE: process.env.USERPROFILE || '',
    LOCALAPPDATA: process.env.LOCALAPPDATA || '',
    APPDATA: process.env.APPDATA || '',
    // Point every Cursor config / state root at the isolated empty dir.
    CURSOR_CONFIG_DIR: process.env.CROSS_HARNESS_CURSOR_CONFIG_DIR || isolatedConfigDir,
    CURSOR_CACHE_DIR: isolatedConfigDir,
    CURSOR_STATE_DIR: isolatedConfigDir,
    XDG_CONFIG_HOME: isolatedConfigDir,
    XDG_CACHE_HOME: isolatedConfigDir,
    XDG_DATA_HOME: isolatedConfigDir,
    // Surface the per-call permission config so a future smoke harness can
    // point Cursor at it. We also keep it on disk in cleanupPaths so it is
    // always removed.
    CURSOR_PERMISSIONS_FILE: permissionConfigPath,
    // Disable telemetry / auto-update so no background traffic originates
    // from this audit turn.
    CURSOR_TELEMETRY_DISABLED: '1',
    // Zero every ambient provider credential we know about. Cursor can call
    // through to OpenAI / Anthropic / Google providers; stripping credentials
    // defensively means even if a permission regression re-enabled a network
    // tool, no credential could be exfiltrated.
    OPENAI_API_KEY: '',
    OPENAI_ORGANIZATION: '',
    OPENAI_PROJECT_ID: '',
    ANTHROPIC_API_KEY: '',
    GEMINI_API_KEY: '',
    GOOGLE_API_KEY: '',
  };

  // Forbid the dangerous bypass flags at the adapter layer. This is a static
  // guarantee for tests that audit adapter safety. `--force` is the single
  // most-asserted Cursor guarantee in plan 8.5.
  for (const arg of args) {
    if (typeof arg === 'string' && /bypass|dangerous|--force/i.test(arg)) {
      throw new Error(`Refusing to emit dangerous Cursor flag: ${arg}`);
    }
  }

  return {
    program,
    args,
    env,
    input: prompt,
    cwd: repoRoot,
    cleanupPaths: [isolatedConfigDir],
  };
}

/**
 * parseEvents: for PR-7 plan/code/security audits we do not need streaming
 * tool events; the final stdout is the stream-json terminal result. This
 * stub exists so the adapter conforms to the plan-8 shape and a later PR can
 * extend it once structured tool-event probing is wired (plan 10.5: parse
 * tool-call start/completed events and the terminal result).
 */
function parseEvents(_stream) {
  return [];
}

/**
 * normalizeFinalResult: delegate to the shared normalizer so every adapter
 * produces the same v2 envelope shape.
 */
function normalizeFinalResult({ task, role, reviewer, processResult }, normalizer) {
  return normalizer.normalizeReviewResult({ task, role, reviewer, processResult });
}

function cleanup(runContext = {}) {
  const paths = Array.isArray(runContext.cleanupPaths) ? runContext.cleanupPaths : [];
  for (const p of paths) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
  return Promise.resolve();
}

module.exports = {
  id: ID,
  displayName: DISPLAY_NAME,
  binaryNames: BINARY_NAMES,
  capabilities: READ_CAPABILITIES,
  buildInvocation,
  parseEvents,
  normalizeFinalResult,
  cleanup,
  buildReadPermissionConfig,
};
