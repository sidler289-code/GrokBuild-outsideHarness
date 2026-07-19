'use strict';

/**
 * PR-6: OpenCode CLI adapter.
 *
 * Plan 8.3 / 10.3 constraints:
 *  - plan/code tasks use a read-only, non-interactive, structured-output
 *    invocation. The prompt is delivered on stdin (never argv).
 *  - ambient plugins and instructions are disabled by the per-call config;
 *    no undocumented CLI flags are emitted.
 *  - per-call permissions are injected via a temporary `OPENCODE_CONFIG_CONTENT`
 *    payload that grants `read` and denies `edit`, `bash`, `web` and
 *    `external_directory`. No permission-bypass flag is ever emitted
 *    (`--dangerously-skip-permissions` is forbidden by plan 12).
 *  - tests task only opens when the CLI can prove controlled command execution
 *    AND emit verifiable tool events; until the real probe is wired the three
 *    tests-relevant capabilities stay `unknown` so the role router fails closed.
 *
 * Shares the Node bounded-process runner, event recorder and result normalizer
 * with every other adapter.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ID = 'opencode';
const DISPLAY_NAME = 'OpenCode CLI';

// Verified read-side capabilities (plan 7.3). The tests-relevant capabilities
// stay `unknown` until the live capability probe is wired; the role router
// fails closed for the tests role in the meantime.
const READ_CAPABILITIES = Object.freeze({
  repoRead: 'verified',
  structuredOutput: 'verified',
  writeRestriction: 'verified',
  structuredToolEvents: 'unknown',
  approvedCommandRestriction: 'unknown',
  directTestExecution: 'unknown',
});

/**
 * Build the per-call OpenCode permission policy (plan 10.3). Plan/code tasks
 * are read-only: `read` is granted; `edit`, `bash`, `web` and
 * `external_directory` are all denied. Tests allow a whitelist of test
 * commands and deny the rest — that path is reserved for the capability probe
 * and is not built here.
 */
function buildReadPermissionConfig() {
  return {
    plugin: [],
    instructions: [],
    permission: {
      '*': 'deny',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      edit: 'deny',
      bash: 'deny',
      task: 'deny',
      skill: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      external_directory: 'deny',
    },
  };
}

/**
 * Build the bounded `opencode` invocation for a plan/code/security task.
 *
 * Flags used (read-only, no permission bypass):
 *   run                     non-interactive single-turn run subcommand
 *   --format json           structured JSON output on stdout
 *
 * The prompt is ALWAYS on stdin. argv only carries capability flags.
 *
 * Returns { program, args, env, input, cwd, cleanupPaths }. The caller passes
 * this to runBoundedProcess.
 */
function buildInvocation({ program, taskContext }) {
  if (typeof program !== 'string' || program.length === 0) {
    throw new TypeError('program must be a non-empty string (the discovered opencode binary).');
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
    'run',
    '--format', 'json',
    // The prompt never appears here; it arrives on stdin.
  ];

  // OpenCode reads its config from `OPENCODE_CONFIG_CONTENT` as an inline JSON
  // document. Injecting a per-call read-only policy means ambient user/project
  // OpenCode config cannot expand permissions for this audit turn.
  const permissionConfig = buildReadPermissionConfig();

  // Inherit only a minimal environment. We redirect OpenCode's config and
  // cache discovery at a fresh empty temp directory so user plugins, rules,
  // stored auth and on-disk config cannot load. An empty string env var is
  // treated as "unset" by OpenCode (it falls back to its default locations),
  // so we MUST point at a real (empty) dir.
  const isolatedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-opencode-cfg-'));
  const env = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || process.env.USERPROFILE || '',
    USERPROFILE: process.env.USERPROFILE || '',
    LOCALAPPDATA: process.env.LOCALAPPDATA || '',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(permissionConfig),
    // Point OpenCode's on-disk config/cache roots at the isolated empty dir.
    OPENCODE_CONFIG_DIR: process.env.CROSS_HARNESS_OPENCODE_CONFIG_DIR || isolatedConfigDir,
    XDG_CONFIG_HOME: isolatedConfigDir,
    XDG_CACHE_HOME: isolatedConfigDir,
    XDG_DATA_HOME: isolatedConfigDir,
    // Disable telemetry / auto-update so no background traffic originates
    // from this audit turn.
    OPENAI_TELEMETRY_DISABLED: '1',
    // Preserve provider authentication while the fixed permission policy
    // denies web tools, shell execution, editing, plugins, and instructions.
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_ORGANIZATION: process.env.OPENAI_ORGANIZATION || '',
    OPENAI_PROJECT_ID: process.env.OPENAI_PROJECT_ID || '',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || '',
  };

  // Forbid the dangerous bypass flag at the adapter layer. This is a static
  // guarantee for tests that audit adapter safety.
  for (const arg of args) {
    if (typeof arg === 'string' && /bypass|dangerous|--force/i.test(arg)) {
      throw new Error(`Refusing to emit dangerous OpenCode flag: ${arg}`);
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

function parseJsonLines(text) {
  if (typeof text !== 'string') {
    return [];
  }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {
      // Unknown/log lines are ignored; final normalization still fails closed.
    }
  }
  return events;
}

function parseEvents(stream) {
  const processResult = stream && stream.processResult ? stream.processResult : stream;
  return parseJsonLines(processResult && processResult.stdout);
}

function resultTextFromEvents(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === 'result' && typeof event.result === 'string') {
      return event.result;
    }
  }
  const text = events
    .filter((event) => event && event.type === 'text' && event.part && typeof event.part.text === 'string')
    .map((event) => event.part.text)
    .join('');
  return text || null;
}

function normalizeFinalResult({ task, role, reviewer, processResult }, normalizer) {
  const resultText = resultTextFromEvents(parseJsonLines(processResult.stdout));
  const normalizedProcess = resultText ? { ...processResult, stdout: resultText } : processResult;
  return normalizer.normalizeReviewResult({ task, role, reviewer, processResult: normalizedProcess });
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
  binaryNames: ['opencode'],
  capabilities: READ_CAPABILITIES,
  buildInvocation,
  parseEvents,
  normalizeFinalResult,
  cleanup,
  buildReadPermissionConfig,
};
