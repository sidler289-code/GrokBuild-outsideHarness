'use strict';

/**
 * PR-6 adapter tests for OpenCode.
 *
 * Pins the plan section 8.3 / 10.3 / 12 guarantees:
 *  - prompt is delivered on stdin, NEVER in argv
 *  - no permission-bypass / dangerous flags (`--dangerously-skip-permissions`
 *    is forbidden; `--force` and `bypass` are rejected too)
 *  - `run --format json --pure` invocation shape
 *  - per-call permission policy injected via `OPENCODE_CONFIG_CONTENT` that
 *    grants `read` and denies `edit`/`bash`/`web`/`external_directory`
 *  - minimal environment inheritance; user config carriers redirected at a
 *    fresh empty temp dir
 *  - tests-relevant capabilities stay `unknown` until the live probe is wired
 *  - normalizeFinalResult delegates to the shared normalizer
 *
 * These are static + invocation-shape tests. Real-CLI smoke is left to the
 * acceptance gate; here we only need determinism.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const opencode = require('../../lib/adapters/opencode.cjs');
const { getAdapter, listAdapterIds } = require('../../lib/adapters/index.cjs');
const normalize = require('../../lib/core/normalize-result.cjs');

const SECRET_PROMPT = 'PROMPT_SECRET_NEVER_IN_ARGV_OR_PROCESS_LIST';
const REPO = '/repo';

function invocation() {
  return opencode.buildInvocation({
    program: '/bin/opencode',
    taskContext: { prompt: SECRET_PROMPT, repoRoot: REPO },
  });
}

// ---------------------------------------------------------------------------
// Registry.
// ---------------------------------------------------------------------------

test('opencode: registered in the adapter registry', () => {
  assert.ok(listAdapterIds().includes('opencode'));
  assert.equal(getAdapter('opencode'), opencode);
  // Exhaustive registry snapshot. Grows with each adapter PR; cursor joined
  // in PR-7, antigravity is reserved for PR-8.
  assert.deepEqual(listAdapterIds().sort(), ['claude', 'codex', 'cursor', 'opencode']);
});

test('opencode: stable id, display name and binary name', () => {
  assert.equal(opencode.id, 'opencode');
  assert.equal(opencode.displayName, 'OpenCode CLI');
  assert.deepEqual(opencode.binaryNames, ['opencode']);
});

// ---------------------------------------------------------------------------
// Prompt canary (plan 12 — never in argv).
// ---------------------------------------------------------------------------

test('opencode: prompt is on stdin and never in argv', () => {
  const inv = invocation();
  assert.equal(inv.input, SECRET_PROMPT);
  for (const arg of inv.args) {
    assert.doesNotMatch(arg, /PROMPT_SECRET_NEVER_IN_ARGV/, `prompt leaked into opencode argv: ${arg}`);
  }
});

// ---------------------------------------------------------------------------
// No dangerous flags.
// ---------------------------------------------------------------------------

test('opencode: no permission-bypass or dangerous flags', () => {
  const inv = invocation();
  for (const arg of inv.args) {
    assert.doesNotMatch(
      arg,
      /dangerously-skip-permissions|bypass|--force/i,
      `dangerous opencode flag: ${arg}`
    );
  }
});

test('opencode: argv uses run --format json --pure', () => {
  const inv = invocation();
  assert.equal(inv.args[0], 'run');
  const formatIdx = inv.args.indexOf('--format');
  assert.ok(formatIdx >= 0, 'opencode must set --format');
  assert.equal(inv.args[formatIdx + 1], 'json');
  assert.ok(inv.args.includes('--pure'), 'opencode must set --pure to skip external plugins');
});

// ---------------------------------------------------------------------------
// Per-call permission policy injected via OPENCODE_CONFIG_CONTENT.
// ---------------------------------------------------------------------------

test('opencode: OPENCODE_CONFIG_CONTENT is valid JSON granting read, denying edit/bash/web/external_directory', () => {
  const inv = invocation();
  assert.ok(typeof inv.env.OPENCODE_CONFIG_CONTENT === 'string' && inv.env.OPENCODE_CONFIG_CONTENT.length > 0);
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(inv.env.OPENCODE_CONFIG_CONTENT);
  }, 'OPENCODE_CONFIG_CONTENT must be valid JSON');
  assert.equal(parsed.permission.read, true);
  assert.equal(parsed.permission.edit, false);
  assert.equal(parsed.permission.bash, false);
  assert.equal(parsed.permission.web, false);
  // external_directory must be empty (no directory escapes permitted).
  assert.deepEqual(parsed.permission.external_directory, []);
});

// ---------------------------------------------------------------------------
// Read-only capability declarations.
// ---------------------------------------------------------------------------

test('opencode: read-side capabilities verified; tests-side unknown', () => {
  assert.equal(opencode.capabilities.repoRead, 'verified');
  assert.equal(opencode.capabilities.structuredOutput, 'verified');
  assert.equal(opencode.capabilities.writeRestriction, 'verified');
  // Tests-side stays unknown — keeps the role router honest.
  assert.equal(opencode.capabilities.structuredToolEvents, 'unknown');
  assert.equal(opencode.capabilities.approvedCommandRestriction, 'unknown');
  assert.equal(opencode.capabilities.directTestExecution, 'unknown');
});

// ---------------------------------------------------------------------------
// Minimal environment, no user-config leakage.
// ---------------------------------------------------------------------------

test('opencode: config/cache env redirected at a fresh empty temp dir (not the user home)', () => {
  const inv = invocation();
  for (const name of ['OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    assert.ok(typeof inv.env[name] === 'string' && inv.env[name].length > 0, `${name} must point at a real dir`);
    assert.notEqual(inv.env[name], process.env.HOME);
    assert.notEqual(inv.env[name], process.env.USERPROFILE);
  }
  assert.ok(Array.isArray(inv.cleanupPaths) && inv.cleanupPaths.length === 1);
});

test('opencode: ambient provider credentials are zeroed', () => {
  const inv = invocation();
  assert.equal(inv.env.OPENAI_API_KEY, '');
  assert.equal(inv.env.OPENAI_ORGANIZATION, '');
  assert.equal(inv.env.OPENAI_PROJECT_ID, '');
  assert.equal(inv.env.ANTHROPIC_API_KEY, '');
  assert.equal(inv.env.GEMINI_API_KEY, '');
  assert.equal(inv.env.GOOGLE_API_KEY, '');
  assert.equal(inv.env.OPENAI_TELEMETRY_DISABLED, '1');
});

// ---------------------------------------------------------------------------
// Argument validation.
// ---------------------------------------------------------------------------

test('opencode: buildInvocation requires program, prompt and repoRoot', () => {
  assert.throws(
    () => opencode.buildInvocation({ taskContext: { prompt: 'p', repoRoot: REPO } }),
    /program must be a non-empty string/
  );
  assert.throws(
    () => opencode.buildInvocation({ program: '/bin/opencode', taskContext: { repoRoot: REPO } }),
    /taskContext.prompt must be a string/
  );
  assert.throws(
    () => opencode.buildInvocation({ program: '/bin/opencode', taskContext: { prompt: 'p' } }),
    /taskContext.repoRoot must be a non-empty string/
  );
  assert.throws(
    () => opencode.buildInvocation({ program: '/bin/opencode' }),
    /taskContext is required/
  );
});

// ---------------------------------------------------------------------------
// normalizeFinalResult delegates to the shared normalizer.
// ---------------------------------------------------------------------------

test('opencode: normalizeFinalResult delegates to the shared normalizer', () => {
  const processResult = {
    exitCode: 0,
    timedOut: false,
    outputLimited: false,
    stdout: JSON.stringify({
      schemaVersion: 2,
      task: 'code',
      role: 'code',
      reviewer: 'opencode',
      status: 'success',
      summary: 'ok',
      requirements: [],
      findings: [],
      testExecution: { attempted: false, verifiedByEvents: false, outcome: 'not_run', commands: [], workspaceChanged: false },
      diagnostics: { durationMs: 5 },
    }),
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 5,
  };
  const env = opencode.normalizeFinalResult({ task: 'code', role: 'code', reviewer: 'opencode', processResult }, normalize);
  assert.equal(env.status, 'success');
  assert.equal(env.schemaVersion, 2);
  assert.equal(env.reviewer, 'opencode');
});

test('opencode: cleanup removes the isolated config dir', async () => {
  const inv = invocation();
  const tempDir = inv.cleanupPaths[0];
  assert.ok(tempDir, 'opencode should declare a cleanup path');
  assert.equal(fs.existsSync(tempDir), true, 'temp dir should exist before cleanup');
  await opencode.cleanup({ cleanupPaths: inv.cleanupPaths });
  assert.equal(fs.existsSync(tempDir), false, 'temp dir should be removed after cleanup');
});
