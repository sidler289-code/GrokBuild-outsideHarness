'use strict';

/**
 * PR-4 adapter tests for Claude and Codex.
 *
 * Pins the plan section 8.1 / 8.2 / 12 guarantees:
 *  - prompt is delivered on stdin, NEVER in argv
 *  - no permission-bypass / dangerous flags
 *  - read-only invocation; no shell, write, network, MCP
 *  - minimal environment inheritance; user config carriers stripped
 *  - tests-relevant capabilities stay `unknown` until PR-5 wires real probes
 *  - normalizeFinalResult delegates to the shared normalizer
 *
 * These are static + invocation-shape tests. Real-CLI smoke is left to the
 * acceptance gate; here we only need determinism.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const claude = require('../../lib/adapters/claude.cjs');
const codex = require('../../lib/adapters/codex.cjs');
const { getAdapter, listAdapterIds } = require('../../lib/adapters/index.cjs');
const normalize = require('../../lib/core/normalize-result.cjs');

const SECRET_PROMPT = 'PROMPT_SECRET_NEVER_IN_ARGV_OR_PROCESS_LIST';
const REPO = '/repo';
const EMPTY_MCP = '/pkg/config/empty-mcp.json';

function invocation(adapter) {
  return adapter.buildInvocation({
    program: `/bin/${adapter.id}`,
    taskContext: { prompt: SECRET_PROMPT, repoRoot: REPO, emptyMcpConfigPath: EMPTY_MCP },
  });
}

// ---------------------------------------------------------------------------
// Registry.
// ---------------------------------------------------------------------------

test('adapter registry exposes claude and codex for PR-4', () => {
  // PR-6 adds opencode; claude/codex must remain present. The exhaustive
  // registry assertion lives in adapters-opencode.test.cjs (and will grow with
  // cursor in PR-7), so this PR-4 test only pins the two original adapters.
  assert.ok(listAdapterIds().includes('claude'));
  assert.ok(listAdapterIds().includes('codex'));
  assert.equal(getAdapter('claude'), claude);
  assert.equal(getAdapter('codex'), codex);
  assert.throws(
    () => getAdapter('gemini'),
    (err) => err.code === 'unknown_adapter'
  );
});

test('adapter ids match stable harness ids', () => {
  assert.equal(claude.id, 'claude');
  assert.equal(codex.id, 'codex');
  assert.equal(claude.displayName, 'Claude Code');
  assert.equal(codex.displayName, 'OpenAI Codex CLI');
});

// ---------------------------------------------------------------------------
// Prompt canary (plan 12 — never in argv).
// ---------------------------------------------------------------------------

test('claude: prompt is on stdin and never in argv', () => {
  const inv = invocation(claude);
  assert.equal(inv.input, SECRET_PROMPT);
  for (const arg of inv.args) {
    assert.doesNotMatch(arg, /PROMPT_SECRET_NEVER_IN_ARGV/, `prompt leaked into claude argv: ${arg}`);
  }
});

test('codex: prompt is on stdin and never in argv', () => {
  const inv = invocation(codex);
  assert.equal(inv.input, SECRET_PROMPT);
  for (const arg of inv.args) {
    assert.doesNotMatch(arg, /PROMPT_SECRET_NEVER_IN_ARGV/, `prompt leaked into codex argv: ${arg}`);
  }
});

// ---------------------------------------------------------------------------
// No dangerous flags.
// ---------------------------------------------------------------------------

test('claude: no permission-bypass or write flags', () => {
  const inv = invocation(claude);
  for (const arg of inv.args) {
    assert.doesNotMatch(arg, /--dangerously|bypass|--force|--allow-write|--full-auto/i, `dangerous claude flag: ${arg}`);
  }
});

test('codex: no permission-bypass or full-auto flags', () => {
  const inv = invocation(codex);
  for (const arg of inv.args) {
    assert.doesNotMatch(arg, /bypass|dangerous|--force|full-auto/i, `dangerous codex flag: ${arg}`);
  }
  // Explicitly assert the read-only sandbox is in argv.
  assert.ok(inv.args.includes('--sandbox'));
  const sandboxIdx = inv.args.indexOf('--sandbox');
  assert.equal(inv.args[sandboxIdx + 1], 'read-only');
  assert.ok(inv.args.includes('--ignore-user-config'));
  assert.ok(inv.args.includes('--ignore-rules'));
  assert.equal(inv.args.includes('--ask-for-approval'), false);
  assert.equal(inv.args.includes('--no-project-doc'), false);
});

// ---------------------------------------------------------------------------
// Read-only capability declarations.
// ---------------------------------------------------------------------------

test('claude: read-side capabilities verified; tests-side unknown', () => {
  assert.equal(claude.capabilities.repoRead, 'verified');
  assert.equal(claude.capabilities.structuredOutput, 'verified');
  assert.equal(claude.capabilities.writeRestriction, 'verified');
  // Tests-side stays unknown until PR-5 — keeps the role router honest.
  assert.equal(claude.capabilities.structuredToolEvents, 'unknown');
  assert.equal(claude.capabilities.approvedCommandRestriction, 'unknown');
  assert.equal(claude.capabilities.directTestExecution, 'unknown');
});

test('codex: read-side capabilities verified; tests-side unknown', () => {
  assert.equal(codex.capabilities.repoRead, 'verified');
  assert.equal(codex.capabilities.structuredOutput, 'verified');
  assert.equal(codex.capabilities.writeRestriction, 'verified');
  assert.equal(codex.capabilities.structuredToolEvents, 'unknown');
  assert.equal(codex.capabilities.approvedCommandRestriction, 'unknown');
  assert.equal(codex.capabilities.directTestExecution, 'unknown');
});

// ---------------------------------------------------------------------------
// Minimal environment, no user-config leakage, no MCP loading.
// ---------------------------------------------------------------------------

test('claude: mcp-config points at the empty bundled config', () => {
  const inv = invocation(claude);
  const idx = inv.args.indexOf('--mcp-config');
  assert.ok(idx >= 0, 'claude must set --mcp-config');
  assert.equal(inv.args[idx + 1], EMPTY_MCP);
});

test('claude: safe mode disables ambient extensions while preserving authentication', () => {
  const inv = invocation(claude);
  assert.ok(inv.args.includes('--safe-mode'));
  assert.ok(inv.args.includes('--strict-mcp-config'));
  const toolsIndex = inv.args.indexOf('--tools');
  assert.equal(inv.args[toolsIndex + 1], 'Read,Glob,Grep');
  assert.deepEqual(inv.cleanupPaths, []);
  assert.equal(inv.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY || '');
  assert.equal(inv.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(inv.env.DISABLE_TELEMETRY, '1');
});

test('codex: preserves auth and uses read-only sandbox', () => {
  const inv = invocation(codex);
  assert.equal(inv.env.OPENAI_API_KEY, process.env.OPENAI_API_KEY || '');
  assert.ok(inv.args.includes('--sandbox'));
  assert.ok(inv.args.includes('read-only'));
  assert.deepEqual(inv.cleanupPaths, []);
  assert.equal(inv.env.OPENAI_TELEMETRY_DISABLED, '1');
});

test('claude: buildInvocation requires program and prompt', () => {
  assert.throws(
    () => claude.buildInvocation({ taskContext: { prompt: 'p', repoRoot: REPO, emptyMcpConfigPath: EMPTY_MCP } }),
    /program must be a non-empty string/
  );
  assert.throws(
    () => claude.buildInvocation({ program: '/bin/claude', taskContext: { repoRoot: REPO, emptyMcpConfigPath: EMPTY_MCP } }),
    /taskContext.prompt must be a string/
  );
  assert.throws(
    () => claude.buildInvocation({ program: '/bin/claude', taskContext: { prompt: 'p', repoRoot: REPO } }),
    /emptyMcpConfigPath/
  );
});

test('codex: buildInvocation requires program and prompt', () => {
  assert.throws(
    () => codex.buildInvocation({ taskContext: { prompt: 'p', repoRoot: REPO } }),
    /program must be a non-empty string/
  );
  assert.throws(
    () => codex.buildInvocation({ program: '/bin/codex' }),
    /taskContext is required/
  );
});

// ---------------------------------------------------------------------------
// normalizeFinalResult delegates to the shared normalizer.
// ---------------------------------------------------------------------------

test('claude + codex: normalizeFinalResult delegates to the shared normalizer', () => {
  for (const adapter of [claude, codex]) {
    const processResult = {
      exitCode: 0,
      timedOut: false,
      outputLimited: false,
      stdout: JSON.stringify({
        schemaVersion: 2,
        task: 'code',
        role: 'code',
        reviewer: adapter.id,
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
    const env = adapter.normalizeFinalResult({ task: 'code', role: 'code', reviewer: adapter.id, processResult }, normalize);
    assert.equal(env.status, 'success');
    assert.equal(env.schemaVersion, 2);
  }
});


test('claude: unwraps the documented JSON result wrapper before normalization', () => {
  const payload = {
    schemaVersion: 2,
    task: 'code',
    role: 'code',
    reviewer: 'claude',
    status: 'success',
    summary: 'wrapper ok',
    requirements: [],
    findings: [],
    testExecution: { attempted: false, verifiedByEvents: false, outcome: 'not_run', commands: [], workspaceChanged: false },
    diagnostics: { durationMs: 11 },
  };
  const processResult = {
    exitCode: 0,
    timedOut: false,
    outputLimited: false,
    stdout: JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(payload) }),
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 11,
  };
  const env = claude.normalizeFinalResult({ task: 'code', role: 'code', reviewer: 'claude', processResult }, normalize);
  assert.equal(env.status, 'success');
  assert.equal(env.summary, 'wrapper ok');
});

test('claude: accepts a result wrapper whose payload contains prose and fenced JSON', () => {
  const payload = {
    schemaVersion: 2,
    task: 'plan',
    role: 'plan',
    reviewer: 'claude',
    status: 'success',
    summary: 'real CLI fenced payload recovered',
    requirements: [],
    findings: [],
    testExecution: { attempted: false, verifiedByEvents: false, outcome: 'not_run', commands: [], workspaceChanged: false },
    diagnostics: { durationMs: 0 },
  };
  const processResult = {
    exitCode: 0,
    timedOut: false,
    outputLimited: false,
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: `\u5ba1\u67e5\u5df2\u5b8c\u6210\u3002\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
    }),
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 179_000,
  };

  const env = claude.normalizeFinalResult({ task: 'plan', role: 'plan', reviewer: 'claude', processResult }, normalize);
  assert.equal(env.status, 'success');
  assert.equal(env.summary, 'real CLI fenced payload recovered');
  assert.equal(env.diagnostics.durationMs, 179_000);
});

test('claude and codex cleanup are no-ops because auth homes are not replaced', async () => {
  for (const adapter of [claude, codex]) {
    const inv = invocation(adapter);
    assert.deepEqual(inv.cleanupPaths, []);
    await adapter.cleanup({ cleanupPaths: inv.cleanupPaths });
  }
});
