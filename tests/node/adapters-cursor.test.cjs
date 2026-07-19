'use strict';

/**
 * PR-7 adapter tests for Cursor.
 *
 * Pins the plan section 8.5 / 10.5 / 12 guarantees:
 *  - prompt is delivered on stdin, NEVER in argv
 *  - `--force` is NEVER emitted (the single most-asserted Cursor guarantee,
 *    plan 8.5 "不传 --force"); any `--dangerously*`/`bypass` token is rejected
 *  - `--print --output-format stream-json` invocation shape
 *  - a fresh per-call permission-config file is written for every invocation
 *    (plan/code deny all Write + Shell); it lives in cleanupPaths and is
 *    removed by cleanup
 *  - config/state/MCP roots redirected at a fresh empty temp dir so user
 *    rules, project rules, stored auth and on-disk MCP config cannot load
 *  - ambient provider credentials zeroed
 *  - tests-relevant capabilities stay `unknown` until the live probe is wired
 *    (plan 8.5 fail-closed: "无法可靠禁止时，对应 role 失败关闭")
 *  - normalizeFinalResult delegates to the shared normalizer
 *
 * These are static + invocation-shape tests. Real-CLI smoke is left to the
 * acceptance gate; here we only need determinism.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cursor = require('../../lib/adapters/cursor.cjs');
const { getAdapter, listAdapterIds } = require('../../lib/adapters/index.cjs');
const normalize = require('../../lib/core/normalize-result.cjs');

const SECRET_PROMPT = 'PROMPT_SECRET_NEVER_IN_ARGV_OR_PROCESS_LIST';
const REPO = '/repo';

function invocation() {
  return cursor.buildInvocation({
    program: '/bin/cursor-agent',
    taskContext: { prompt: SECRET_PROMPT, repoRoot: REPO },
  });
}

// ---------------------------------------------------------------------------
// Registry.
// ---------------------------------------------------------------------------

test('cursor: registered in the adapter registry', () => {
  assert.ok(listAdapterIds().includes('cursor'));
  assert.equal(getAdapter('cursor'), cursor);
  // claude + codex + opencode must still be present; cursor is additive.
  assert.deepEqual(listAdapterIds().sort(), ['claude', 'codex', 'cursor', 'opencode']);
});

test('cursor: stable id, display name and binary-name priority', () => {
  assert.equal(cursor.id, 'cursor');
  assert.equal(cursor.displayName, 'Cursor CLI');
  // cursor-agent is primary; `agent` is the documented compatibility alias.
  assert.deepEqual(cursor.binaryNames, ['cursor-agent', 'agent']);
});

// ---------------------------------------------------------------------------
// Prompt canary (plan 12 — never in argv).
// ---------------------------------------------------------------------------

test('cursor: prompt is on stdin and never in argv', () => {
  const inv = invocation();
  assert.equal(inv.input, SECRET_PROMPT);
  for (const arg of inv.args) {
    assert.doesNotMatch(arg, /PROMPT_SECRET_NEVER_IN_ARGV/, `prompt leaked into cursor argv: ${arg}`);
  }
});

// ---------------------------------------------------------------------------
// No dangerous flags. --force is the headline guarantee (plan 8.5).
// ---------------------------------------------------------------------------

test('cursor: never emits --force or any bypass/dangerous flag', () => {
  const inv = invocation();
  for (const arg of inv.args) {
    assert.doesNotMatch(
      arg,
      /--force\b|bypass|dangerous/i,
      `dangerous cursor flag: ${arg}`
    );
  }
});

test('cursor: argv uses --print --output-format stream-json', () => {
  const inv = invocation();
  assert.ok(inv.args.includes('--print'), 'cursor must set --print');
  const formatIdx = inv.args.indexOf('--output-format');
  assert.ok(formatIdx >= 0, 'cursor must set --output-format');
  assert.equal(inv.args[formatIdx + 1], 'stream-json');
});

// ---------------------------------------------------------------------------
// Per-call permission config file (plan 10.5: plan/code deny all Write + Shell).
// ---------------------------------------------------------------------------

test('cursor: writes the documented per-call cli-config permissions', () => {
  const inv = invocation();
  const permPath = path.join(inv.cleanupPaths[0], '.cursor', 'cli-config.json');
  assert.equal(fs.existsSync(permPath), true, 'permission config file must exist on disk');
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(fs.readFileSync(permPath, 'utf8'));
  }, 'permission config file must be valid JSON');
  assert.deepEqual(parsed, {
    permissions: {
      allow: ['Read(**)'],
      deny: ['Write(**)', 'Shell(*)'],
    },
  });
});

test('cursor: buildReadPermissionConfig uses Cursor permission rule syntax', () => {
  const cfg = cursor.buildReadPermissionConfig();
  assert.deepEqual(cfg.permissions.allow, ['Read(**)']);
  assert.deepEqual(cfg.permissions.deny, ['Write(**)', 'Shell(*)']);
});

// ---------------------------------------------------------------------------
// Read-only capability declarations.
// ---------------------------------------------------------------------------

test('cursor: every capability remains unknown until a real CLI probe verifies isolation', () => {
  assert.equal(cursor.capabilities.repoRead, 'unknown');
  assert.equal(cursor.capabilities.structuredOutput, 'unknown');
  assert.equal(cursor.capabilities.writeRestriction, 'unknown');
  // Tests-side stays unknown — keeps the role router honest. Plan 8.5
  // fail-closed: where auto-control cannot be reliably disabled the role
  // must not open.
  assert.equal(cursor.capabilities.structuredToolEvents, 'unknown');
  assert.equal(cursor.capabilities.approvedCommandRestriction, 'unknown');
  assert.equal(cursor.capabilities.directTestExecution, 'unknown');
});

// ---------------------------------------------------------------------------
// Minimal environment, no user-config / rules / MCP leakage.
// ---------------------------------------------------------------------------

test('cursor: config/state/cache roots redirected at a fresh empty temp dir (not the user home)', () => {
  const inv = invocation();
  for (const name of ['CURSOR_CONFIG_DIR', 'CURSOR_CACHE_DIR', 'CURSOR_STATE_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    assert.ok(typeof inv.env[name] === 'string' && inv.env[name].length > 0, `${name} must point at a real dir`);
    assert.notEqual(inv.env[name], process.env.HOME);
    assert.notEqual(inv.env[name], process.env.USERPROFILE);
  }
  assert.ok(Array.isArray(inv.cleanupPaths) && inv.cleanupPaths.length === 1);
});

test('cursor: ambient provider credentials are zeroed and telemetry disabled', () => {
  const inv = invocation();
  assert.equal(inv.env.OPENAI_API_KEY, '');
  assert.equal(inv.env.OPENAI_ORGANIZATION, '');
  assert.equal(inv.env.OPENAI_PROJECT_ID, '');
  assert.equal(inv.env.ANTHROPIC_API_KEY, '');
  assert.equal(inv.env.GEMINI_API_KEY, '');
  assert.equal(inv.env.GOOGLE_API_KEY, '');
  assert.equal(inv.env.CURSOR_TELEMETRY_DISABLED, '1');
});

// ---------------------------------------------------------------------------
// Argument validation.
// ---------------------------------------------------------------------------

test('cursor: buildInvocation requires program, prompt and repoRoot', () => {
  assert.throws(
    () => cursor.buildInvocation({ taskContext: { prompt: 'p', repoRoot: REPO } }),
    /program must be a non-empty string/
  );
  assert.throws(
    () => cursor.buildInvocation({ program: '/bin/cursor-agent', taskContext: { repoRoot: REPO } }),
    /taskContext.prompt must be a string/
  );
  assert.throws(
    () => cursor.buildInvocation({ program: '/bin/cursor-agent', taskContext: { prompt: 'p' } }),
    /taskContext.repoRoot must be a non-empty string/
  );
  assert.throws(
    () => cursor.buildInvocation({ program: '/bin/cursor-agent' }),
    /taskContext is required/
  );
});

// ---------------------------------------------------------------------------
// normalizeFinalResult delegates to the shared normalizer.
// ---------------------------------------------------------------------------

test('cursor: normalizeFinalResult delegates to the shared normalizer', () => {
  const processResult = {
    exitCode: 0,
    timedOut: false,
    outputLimited: false,
    stdout: JSON.stringify({
      schemaVersion: 2,
      task: 'code',
      role: 'code',
      reviewer: 'cursor',
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
  const env = cursor.normalizeFinalResult({ task: 'code', role: 'code', reviewer: 'cursor', processResult }, normalize);
  assert.equal(env.status, 'success');
  assert.equal(env.schemaVersion, 2);
  assert.equal(env.reviewer, 'cursor');
});


test('cursor: extracts the terminal v2 payload from stream-json NDJSON', () => {
  const payload = {
    schemaVersion: 2,
    task: 'code',
    role: 'code',
    reviewer: 'cursor',
    status: 'success',
    summary: 'stream ok',
    requirements: [],
    findings: [],
    testExecution: { attempted: false, verifiedByEvents: false, outcome: 'not_run', commands: [], workspaceChanged: false },
    diagnostics: { durationMs: 7 },
  };
  const processResult = {
    exitCode: 0,
    timedOut: false,
    outputLimited: false,
    stdout: [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(payload) }),
    ].join('\n'),
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 7,
  };
  const env = cursor.normalizeFinalResult({ task: 'code', role: 'code', reviewer: 'cursor', processResult }, normalize);
  assert.equal(env.status, 'success');
  assert.equal(env.summary, 'stream ok');
});
test('cursor: cleanup removes the isolated config dir (and the permission file inside it)', async () => {
  const inv = invocation();
  const tempDir = inv.cleanupPaths[0];
  const permPath = path.join(tempDir, '.cursor', 'cli-config.json');
  assert.ok(tempDir, 'cursor should declare a cleanup path');
  assert.equal(fs.existsSync(tempDir), true, 'temp dir should exist before cleanup');
  assert.equal(fs.existsSync(permPath), true, 'permission file should exist before cleanup');
  await cursor.cleanup({ cleanupPaths: inv.cleanupPaths });
  assert.equal(fs.existsSync(tempDir), false, 'temp dir should be removed after cleanup');
  assert.equal(fs.existsSync(permPath), false, 'permission file should be removed after cleanup');
});

// ---------------------------------------------------------------------------
// Each invocation gets its OWN permission file (no cross-turn reuse).
// ---------------------------------------------------------------------------

test('cursor: each invocation writes a distinct permission-config file path', () => {
  const a = invocation();
  const b = invocation();
  const aConfig = path.join(a.cleanupPaths[0], '.cursor', 'cli-config.json');
  const bConfig = path.join(b.cleanupPaths[0], '.cursor', 'cli-config.json');
  assert.notEqual(aConfig, bConfig);
  assert.notEqual(a.cleanupPaths[0], b.cleanupPaths[0]);
  // Clean both up so the test does not leak temp dirs.
  cursor.cleanup({ cleanupPaths: a.cleanupPaths });
  cursor.cleanup({ cleanupPaths: b.cleanupPaths });
});
