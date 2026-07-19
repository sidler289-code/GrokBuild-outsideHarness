'use strict';

/**
 * PR-4: Claude Code adapter.
 *
 * Plan 8.1 constraints:
 *  - plan/code tasks expose read-only capabilities only.
 *  - tests task only opened when the CLI can restrict to approved commands and
 *    emit verifiable tool events (PR-5 scope; until then tests capability is
 *    reported as unknown so the role router fails closed).
 *  - no permission-bypass flags; no user hooks, agents or MCP loaded.
 *  - prompt is delivered on stdin.
 *
 * This adapter only describes the Claude-specific invocation differences. It
 * shares the Node bounded-process runner, event recorder and result
 * normalizer with every other adapter.
 */

const ID = 'claude';
const DISPLAY_NAME = 'Claude Code';

// Verified read-side capabilities (plan 7.3). `directTestExecution` and the
// tests-relevant capabilities stay `unknown` until PR-5 wires the real probe.
//
// Note on read scope: Claude Code's permission modes can deny shell/write/
// network/MCP, but they cannot confine `Read`/`Grep` to a directory. This
// adapter therefore declares `repoRead: 'verified'` (the CLI can read
// repository files and emit structured output), while file-system scope
// confinement is enforced AFTER the fact by the audit layer's scope gate
// (lib/core/scope-snapshot.cjs + audit.cjs downgradeOutOfScopeFindings). The
// reviewer's output is untrusted candidate evidence; only in-scope, host-
// verified findings can block approval (plan section 12).
const READ_CAPABILITIES = Object.freeze({
  repoRead: 'verified',
  structuredOutput: 'verified',
  writeRestriction: 'verified',
  structuredToolEvents: 'unknown',
  approvedCommandRestriction: 'unknown',
  directTestExecution: 'unknown',
});

/**
 * Build the bounded `claude` invocation for a plan/code/security task.
 *
 * Returns { program, args, env, input, cwd }. The caller passes this to
 * runBoundedProcess. The prompt is ALWAYS on stdin; it never appears in argv.
 *
 * Flags used (read-only, no permission bypass, no MCP):
 *   --print                  non-interactive single-turn print mode
 *   --output-format json     structured v2-shaped envelope on stdout
 *   --input-format text      treat stdin as plain text
 *   --permission-mode plan   Claude's most restrictive built-in mode
 *   --allowedTools ""        explicit empty allowlist; deny every tool except
 *                            the read-only defaults below
 *   --mcp-config <empty>     point at an empty MCP config so user/project MCP
 *                            cannot expand permissions (config/empty-mcp.json)
 *   --no-user-rules          do not load CLAUDE.md / user rules
 *   --no-project-rules       do not load project-local rules
 *
 * Read-only tools are intentionally a fixed, minimal set. We do NOT include
 * Bash, Edit, Write, or any network tool.
 */
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

function buildInvocation({ program, taskContext }) {
  if (typeof program !== 'string' || program.length === 0) {
    throw new TypeError('program must be a non-empty string (the discovered claude binary).');
  }
  if (!taskContext || typeof taskContext !== 'object') {
    throw new TypeError('taskContext is required.');
  }
  const { prompt, repoRoot, emptyMcpConfigPath } = taskContext;
  if (typeof prompt !== 'string') {
    throw new TypeError('taskContext.prompt must be a string.');
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('taskContext.repoRoot must be a non-empty string.');
  }
  if (typeof emptyMcpConfigPath !== 'string' || emptyMcpConfigPath.length === 0) {
    throw new TypeError('taskContext.emptyMcpConfigPath must point at the bundled empty MCP config.');
  }

  const args = [
    '--print',
    '--input-format', 'text',
    '--output-format', 'json',
    '--permission-mode', 'plan',
    '--tools', READ_ONLY_TOOLS.join(','),
    '--disallowedTools', 'mcp__*',
    '--strict-mcp-config',
    '--mcp-config', emptyMcpConfigPath,
    '--safe-mode',
    '--no-session-persistence',
    '--add-dir', repoRoot,
  ];

  // --safe-mode disables CLAUDE.md, hooks, skills, plugins, agents and ambient
  // MCP while preserving authentication. --tools is the actual built-in tool
  // restriction; --allowedTools would only auto-approve matching tools.
  const env = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || process.env.USERPROFILE || '',
    USERPROFILE: process.env.USERPROFILE || '',
    LOCALAPPDATA: process.env.LOCALAPPDATA || '',
    CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  };

  return {
    program,
    args,
    env,
    input: prompt,
    cwd: repoRoot,
    cleanupPaths: [],
  };
}

/**
 * parseEvents: for PR-4 plan/code/security audits we do not need streaming
 * tool events; the final stdout is a single JSON envelope. This stub exists
 * so the adapter conforms to the plan-8 shape and PR-5 can extend it.
 */
function parseEvents(_stream) {
  return [];
}

/**
 * normalizeFinalResult: delegate to the shared normalizer so every adapter
 * produces the same v2 envelope shape.
 */
function normalizeFinalResult({ task, role, reviewer, processResult }, normalizer) {
  let normalizedProcess = processResult;
  if (!processResult.startError && !processResult.timedOut && !processResult.outputLimited && processResult.exitCode === 0) {
    try {
      const wrapper = JSON.parse(processResult.stdout);
      if (wrapper && wrapper.type === 'result' && typeof wrapper.result === 'string') {
        normalizedProcess = { ...processResult, stdout: wrapper.result };
      }
    } catch {
      // Shared normalization reports invalid_output with a bounded preview.
    }
  }
  return normalizer.normalizeReviewResult({ task, role, reviewer, processResult: normalizedProcess });
}

function cleanup() {
  return Promise.resolve();
}

module.exports = {
  id: ID,
  displayName: DISPLAY_NAME,
  binaryNames: ['claude'],
  capabilities: READ_CAPABILITIES,
  buildInvocation,
  parseEvents,
  normalizeFinalResult,
  cleanup,
  READ_ONLY_TOOLS,
};
