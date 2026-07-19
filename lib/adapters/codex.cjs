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
const READ_ONLY_SANDBOX = 'read-only';

/**
 * Build the bounded `codex` invocation for a plan/code/security task.
 *
 * Flags used (read-only, no permission bypass, no user config):
 *   --sandbox read-only       filesystem read-only, no writes
 *   --ephemeral              do not persist a session
 *   --ignore-user-config     ignore ambient Codex config
 *   --ignore-rules           ignore repository instruction files
 *   --output-schema <path>   constrain the final response to v2
 *   -                        read the prompt from stdin
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
  const resultSchemaPath = taskContext.resultSchemaPath || path.join(__dirname, '..', '..', 'skills', 'cross-harness-review', 'schemas', 'review-result-v2-codex.schema.json');
  if (typeof prompt !== 'string') {
    throw new TypeError('taskContext.prompt must be a string.');
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('taskContext.repoRoot must be a non-empty string.');
  }
  if (typeof resultSchemaPath !== 'string' || resultSchemaPath.length === 0) {
    throw new TypeError('taskContext.resultSchemaPath must point at the bundled v2 schema.');
  }

  const args = [
    'exec',
    '--sandbox', READ_ONLY_SANDBOX,
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--cd', repoRoot,
    '--output-schema', resultSchemaPath,
    '-',
  ];

  // Keep authentication available while command-shell children inherit no
  // ambient environment. User config and project rules are disabled by flags.
  const env = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || process.env.USERPROFILE || '',
    USERPROFILE: process.env.USERPROFILE || '',
    LOCALAPPDATA: process.env.LOCALAPPDATA || '',
    APPDATA: process.env.APPDATA || '',
    CODEX_HOME: process.env.CODEX_HOME || '',
    OPENAI_TELEMETRY_DISABLED: '1',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_ORGANIZATION: process.env.OPENAI_ORGANIZATION || '',
    OPENAI_PROJECT_ID: process.env.OPENAI_PROJECT_ID || '',
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
    cleanupPaths: [],
  };
}

function parseEvents(_stream) {
  return [];
}

function normalizeFinalResult({ task, role, reviewer, processResult }, normalizer) {
  return normalizer.normalizeReviewResult({ task, role, reviewer, processResult });
}

function cleanup() {
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
