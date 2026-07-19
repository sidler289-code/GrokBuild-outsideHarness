'use strict';

/**
 * PR-4: OpenAI Codex CLI adapter.
 *
 * Plan 8.2 constraints:
 *  - plan/code tasks use a read-only, ephemeral, user-config-ignoring,
 *    rules-ignoring invocation.
 *  - tests task only opened when the CLI can prove controlled command
 *    execution and structured events; until PR-5 the tests-relevant
 *    capabilities are `unknown` so the role router fails closed.
 *  - prompt is delivered on stdin (Codex supports `-` as the prompt source).
 *  - no permission-bypass flags.
 *
 * Shares the Node bounded-process runner, event recorder and result
 * normalizer with every other adapter.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const READ_CAPABILITIES = Object.freeze({
  repoRead: 'verified',
  structuredOutput: 'verified',
  writeRestriction: 'verified',
  structuredToolEvents: 'unknown',
  approvedCommandRestriction: 'unknown',
  directTestExecution: 'unknown',
});

const ID = 'codex';
const DISPLAY_NAME = 'OpenAI Codex CLI';

// Codex sandbox modes (read-only subset). We use the most restrictive mode
// that still allows reading the repository.
const READ_ONLY_SANDBOX = 'readonly';

/**
 * Build the bounded `codex` invocation for a plan/code/security task.
 *
 * Flags used (read-only, no permission bypass, no user config):
 *   --sandbox readonly          filesystem read-only, no network, no writes
 *   --ask-for-approval never    never escalate to a shell approval prompt
 *   --dangerously-bypass...     NEVER. This flag is forbidden by plan 12.
 *   --cd <repoRoot>             set the working directory explicitly
 *   --output-last-message <fd>  structured stdout output
 *   -                           read the prompt from stdin
 *
 * The prompt is ALWAYS on stdin. argv only carries capability flags.
 */
function buildInvocation({ program, taskContext }) {
  if (typeof program !== 'string' || program.length === 0) {
    throw new TypeError('program must be a non-empty string (the discovered codex binary).');
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
    'exec',
    '--sandbox', READ_ONLY_SANDBOX,
    '--ask-for-approval', 'never',
    '--cd', repoRoot,
    '--no-project-doc',
    '--config', 'approval_policy=never',
    '--config', 'sandbox_mode=readonly',
    // The final arg "-" tells Codex to read the prompt from stdin.
    '-',
  ];

  // Point Codex at a fresh empty CODEX_HOME so user instructions.toml,
  // config.toml, and stored auth.json cannot load. An empty string is treated
  // as "unset" by Codex (it falls back to ~/.codex), so we MUST use a real
  // empty directory.
  const isolatedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-codex-cfg-'));
  const env = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || process.env.USERPROFILE || '',
    USERPROFILE: process.env.USERPROFILE || '',
    LOCALAPPDATA: process.env.LOCALAPPDATA || '',
    CODEX_HOME: process.env.CROSS_HARNESS_CODEX_HOME || isolatedConfigDir,
    OPENAI_TELEMETRY_DISABLED: '1',
    // Zero every ambient OpenAI credential we know about so that even if a
    // future flag regression re-enabled network (which --sandbox readonly
    // denies), no credential could be exfiltrated.
    OPENAI_API_KEY: '',
    OPENAI_ORGANIZATION: '',
    OPENAI_PROJECT_ID: '',
  };

  // Forbid the dangerous bypass flag at the adapter layer. This is a static
  // guarantee for tests that audit adapter safety.
  for (const arg of args) {
    if (typeof arg === 'string' && /bypass|dangerous|--force/i.test(arg)) {
      throw new Error(`Refusing to emit dangerous Codex flag: ${arg}`);
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

function parseEvents(_stream) {
  return [];
}

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
  binaryNames: ['codex'],
  capabilities: READ_CAPABILITIES,
  buildInvocation,
  parseEvents,
  normalizeFinalResult,
  cleanup,
  READ_ONLY_SANDBOX,
};
