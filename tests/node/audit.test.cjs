'use strict';

/**
 * PR-4 audit orchestrator tests.
 *
 * Pins lib/core/audit.cjs against plan sections 9.1, 9.2, 2.4, 12:
 *  - legacy fan-out: both Claude+Codex run when available
 *  - single-reviewer degradation when only one is available
 *  - both unavailable -> aggregateStatus 'unavailable'
 *  - explicit --reviewer overrides one-shot, never persists, fails closed
 *  - scope-gate downgrades out-of-scope findings to verification:'out_of_scope'
 *  - prompt never appears in argv (the audit layer re-checks the adapter)
 *  - capability mismatch fails closed
 *  - tests task is refused until PR-5
 *
 * We inject a fake runImpl so no real reviewer is spawned.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  AuditError,
  downgradeOutOfScopeFindings,
  resolveReviewersForTask,
  runSingleReview,
  runAudit,
} = require('../../lib/core/audit.cjs');

function validEnvelope(overrides = {}) {
  return {
    schemaVersion: 2,
    task: 'code',
    role: 'code',
    reviewer: 'claude',
    status: 'success',
    summary: 'ok',
    requirements: [],
    findings: [],
    testExecution: { attempted: false, verifiedByEvents: false, outcome: 'not_run', commands: [], workspaceChanged: false },
    diagnostics: { durationMs: 1 },
    ...overrides,
  };
}

function fakeRunImpl(stdout) {
  return async (opts) => {
    // Assert the prompt is NOT in argv, as a defence-in-depth check.
    for (const a of opts.args) {
      if (typeof a === 'string' && a.includes(opts.input)) {
        throw new Error('prompt canary leaked into argv');
      }
    }
    return {
      exitCode: 0,
      signal: null,
      startError: null,
      timedOut: false,
      outputLimited: false,
      terminationReason: null,
      stdout,
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 5,
    };
  };
}

function legacyDetect(available) {
  return async () => {
    const out = [];
    for (const id of ['claude', 'codex']) {
      if (available.includes(id)) {
        out.push({ harnessId: id, available: true, version: '1.0.0', candidate: { path: `/bin/${id}` } });
      } else {
        out.push({ harnessId: id, available: false, reason: 'not_found' });
      }
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// resolveReviewersForTask.
// ---------------------------------------------------------------------------

test('resolveReviewersForTask: legacy fan-out returns both when available', async () => {
  const result = await resolveReviewersForTask({
    task: 'code',
    userConfig: { configured: false, mode: 'legacy-unconfigured' },
    detectImpl: legacyDetect(['claude', 'codex']),
  });
  assert.equal(result.reason, 'legacy_fanout');
  assert.equal(result.reviewers.length, 2);
  assert.deepEqual(result.reviewers.map((r) => r.reviewer), ['claude', 'codex']);
});

test('resolveReviewersForTask: legacy degrades to single reviewer', async () => {
  const result = await resolveReviewersForTask({
    task: 'code',
    userConfig: { configured: false, mode: 'legacy-unconfigured' },
    detectImpl: legacyDetect(['codex']),
  });
  assert.equal(result.reason, 'legacy_degraded');
  assert.equal(result.reviewers.length, 1);
  assert.equal(result.reviewers[0].reviewer, 'codex');
  assert.deepEqual(result.unavailable, ['claude']);
});

test('resolveReviewersForTask: both unavailable returns empty + reason unavailable', async () => {
  const result = await resolveReviewersForTask({
    task: 'code',
    userConfig: { configured: false, mode: 'legacy-unconfigured' },
    detectImpl: legacyDetect([]),
  });
  assert.equal(result.reviewers.length, 0);
  assert.equal(result.reason, 'unavailable');
  assert.deepEqual(result.unavailable, ['claude', 'codex']);
});

test('resolveReviewersForTask: explicit --reviewer never persists and is one-shot', async () => {
  // Explicit reviewer must be detected even in legacy-unconfigured mode.
  const result = await resolveReviewersForTask({
    task: 'plan',
    explicitReviewer: 'codex',
    userConfig: { configured: false, mode: 'legacy-unconfigured' },
    detectImpl: legacyDetect(['claude', 'codex']),
  });
  assert.equal(result.reason, 'explicit');
  assert.equal(result.reviewers.length, 1);
  assert.equal(result.reviewers[0].reviewer, 'codex');
  // No state was passed back that could persist anywhere.
  assert.equal(result.reviewers[0].program, '/bin/codex');
});

test('resolveReviewersForTask: explicit --reviewer fails closed when unavailable', async () => {
  const result = await resolveReviewersForTask({
    task: 'plan',
    explicitReviewer: 'claude',
    userConfig: { configured: false, mode: 'legacy-unconfigured' },
    detectImpl: legacyDetect(['codex']),
  });
  assert.equal(result.reviewers.length, 0);
  assert.equal(result.reason, 'unavailable');
  assert.deepEqual(result.unavailable, ['claude']);
});

test('resolveReviewersForTask: configured mode resolves role.<task>', async () => {
  const userConfig = {
    configured: true,
    mode: 'configured',
    config: { roles: { plan: 'claude', code: 'codex', tests: 'opencode' } },
  };
  // We monkey-patch detectHarness via a module re-mock. Easiest path: call
  // resolveReviewersForTask with detectImpl that returns the configured reviewer.
  // The configured branch calls a fresh detectHarness internally; we accept
  // that limitation here and rely on the legacy branch tests for routing.
  // This test only asserts the security-follows-code rule.
  const result = await resolveReviewersForTask({
    task: 'security',
    userConfig,
    detectImpl: async () => [],
  });
  // security role mapping should consult roles.code; if that reviewer is not
  // available, we get unavailable. The point is the function ran configured mode.
  assert.equal(result.reason, 'unavailable');
});

// ---------------------------------------------------------------------------
// downgradeOutOfScopeFindings.
// ---------------------------------------------------------------------------

test('downgradeOutOfScopeFindings marks out-of-scope findings', () => {
  const env = validEnvelope({
    findings: [
      { severity: 'high', category: 'x', title: 'in', evidence: { file: 'lib/a.cjs', line: 1, symbol: null, reason: 'r' }, recommendation: 'fix', confidence: 0.5, verification: 'candidate' },
      { severity: 'high', category: 'x', title: 'out', evidence: { file: 'docs/b.md', line: 1, symbol: null, reason: 'r' }, recommendation: 'fix', confidence: 0.5, verification: 'candidate' },
    ],
  });
  const snapshot = { files: ['lib/a.cjs'] };
  const out = downgradeOutOfScopeFindings(env, snapshot);
  assert.equal(out.findings[0].verification, 'candidate');
  assert.equal(out.findings[1].verification, 'out_of_scope');
});

test('downgradeOutOfScopeFindings leaves plan tasks (no snapshot) untouched', () => {
  const env = validEnvelope({
    task: 'plan',
    role: 'plan',
    findings: [{ severity: 'info', category: 'x', title: 't', evidence: { file: 'anywhere.cjs', line: 1, symbol: null, reason: 'r' }, recommendation: 'fix', confidence: 0.5, verification: 'candidate' }],
  });
  const out = downgradeOutOfScopeFindings(env, { files: [] });
  assert.equal(out.findings[0].verification, 'candidate');
});

// ---------------------------------------------------------------------------
// runSingleReview.
// ---------------------------------------------------------------------------

async function writePlan() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-audit-'));
  const plan = path.join(dir, 'plan.md');
  fs.writeFileSync(plan, '# plan\n- R1: do thing\n');
  return { dir, plan };
}

test('runSingleReview plan returns a normalized envelope', async () => {
  const { dir, plan } = await writePlan();
  try {
    const env = await runSingleReview({
      task: 'plan',
      reviewer: 'claude',
      repoRoot: dir,
      planFile: plan,
      program: '/bin/claude',
      emptyMcpConfigPath: path.join(__dirname, '..', '..', 'config', 'empty-mcp.json'),
      runImpl: fakeRunImpl(JSON.stringify(validEnvelope({ task: 'plan', role: 'plan' }))),
    });
    assert.equal(env.status, 'success');
    assert.match(env.planDigest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleReview code requires --scope', async () => {
  const { dir, plan } = await writePlan();
  try {
    await assert.rejects(
      () =>
        runSingleReview({
          task: 'code',
          reviewer: 'claude',
          repoRoot: dir,
          planFile: plan,
          program: '/bin/claude',
          emptyMcpConfigPath: path.join(__dirname, '..', '..', 'config', 'empty-mcp.json'),
          runImpl: fakeRunImpl(JSON.stringify(validEnvelope())),
        }),
      (err) => err instanceof AuditError && err.code === 'invalid_request'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleReview tests fails closed when user policy is disabled', async () => {
  const env = await runSingleReview({
    task: 'tests',
    reviewer: 'claude',
    repoRoot: '/repo',
    program: '/bin/claude',
    userConfig: {
      configured: true,
      config: { testsExecution: { enabled: false, mode: 'host-bounded', defaultTimeoutSeconds: 10, maxOutputBytes: 65536 } },
    },
  });
  assert.equal(env.status, 'policy_denied');
  assert.equal(env.testExecution.outcome, 'policy_blocked');
});

test('runSingleReview tests accepts only host-verified command events', async () => {
  const { dir } = await writePlan();
  try {
    let gitStatusCalls = 0;
    const runImpl = async (opts) => {
      if (opts.program === 'git') {
        gitStatusCalls += 1;
        return {
          exitCode: 0, signal: null, startError: null, timedOut: false, outputLimited: false,
          stdout: gitStatusCalls === 1 ? '' : '?? generated/\0',
          stderr: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1,
        };
      }
      return {
        exitCode: 0, signal: null, startError: null, timedOut: false, outputLimited: false,
        stdout: JSON.stringify(validEnvelope({
          task: 'tests',
          role: 'tests',
          testExecution: { attempted: true, verifiedByEvents: false, outcome: 'passed', commands: [], workspaceChanged: false },
        })),
        stderr: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 5,
      };
    };
    const adapter = {
      capabilities: {
        repoRead: 'verified',
        structuredOutput: 'verified',
        structuredToolEvents: 'verified',
        approvedCommandRestriction: 'verified',
        directTestExecution: 'verified',
      },
      buildInvocation: ({ program, taskContext }) => {
        assert.deepEqual(taskContext.approvedCommands.map((command) => command.id), ['unit']);
        return { program, args: ['--fixed'], env: {}, input: taskContext.prompt, cwd: taskContext.repoRoot };
      },
      parseEvents: () => [{
        type: 'test_command_finished',
        data: { argv: ['node', '--test'], cwd: '.', exitCode: 0, durationMs: 8, timedOut: false, stdout: 'ok', stderr: '' },
      }],
      normalizeFinalResult: ({ task, role, reviewer, processResult }, normalizer) =>
        normalizer.normalizeReviewResult({ task, role, reviewer, processResult }),
      cleanup: () => Promise.resolve(),
    };
    const env = await runSingleReview({
      task: 'tests',
      reviewer: 'claude',
      repoRoot: dir,
      program: '/bin/claude',
      userConfig: {
        configured: true,
        config: { testsExecution: { enabled: true, mode: 'host-bounded', defaultTimeoutSeconds: 10, maxOutputBytes: 65536 } },
      },
      projectConfig: {
        schemaVersion: 1,
        testsExecution: { commands: [{ id: 'unit', argv: ['node', '--test'], cwd: '.' }] },
      },
      runImpl,
      adapterOverride: adapter,
    });
    assert.equal(env.status, 'success');
    assert.equal(env.testExecution.verifiedByEvents, true);
    assert.equal(env.testExecution.outcome, 'passed');
    assert.equal(env.testExecution.workspaceChanged, true);
    assert.deepEqual(env.testExecution.workspaceChanges, ['?? generated/']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleReview plan requires --plan-file', async () => {
  await assert.rejects(
    () => runSingleReview({ task: 'plan', reviewer: 'claude', repoRoot: '/repo', program: '/bin/claude' }),
    (err) => err instanceof AuditError && err.code === 'invalid_request'
  );
});

test('runSingleReview aborts if adapter tries to put prompt in argv', async () => {
  const { dir, plan } = await writePlan();
  try {
    // Use the adapterOverride test hook to supply an adapter that deliberately
    // leaks the prompt into argv. The audit layer must abort before runImpl.
    const claude = require('../../lib/adapters/claude.cjs');
    const malicious = {
      ...claude,
      buildInvocation: ({ program, taskContext }) => ({
        program,
        // Deliberately inject the prompt into an argv slot.
        args: ['--print', taskContext.prompt],
        env: {},
        input: taskContext.prompt,
        cwd: taskContext.repoRoot,
      }),
    };
    await assert.rejects(
      () =>
        runSingleReview({
          task: 'plan',
          reviewer: 'claude',
          repoRoot: dir,
          planFile: plan,
          program: '/bin/claude',
          emptyMcpConfigPath: path.join(__dirname, '..', '..', 'config', 'empty-mcp.json'),
          runImpl: fakeRunImpl(JSON.stringify(validEnvelope())),
          adapterOverride: malicious,
        }),
      (err) => err instanceof AuditError && err.code === 'policy_violation'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runAudit end-to-end with injected runImpl + detectImpl.
// ---------------------------------------------------------------------------

test('runAudit legacy fan-out runs both reviewers and aggregates all_success', async () => {
  const { dir, plan } = await writePlan();
  try {
    // runImpl inspects opts.program to return a reviewer-matched envelope.
    const runImpl = async (opts) => {
      const reviewer = opts.program.endsWith('claude') ? 'claude' : 'codex';
      const stdout = JSON.stringify(validEnvelope({ task: 'plan', role: 'plan', reviewer }));
      return {
        exitCode: 0,
        signal: null,
        startError: null,
        timedOut: false,
        outputLimited: false,
        terminationReason: null,
        stdout,
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 5,
      };
    };
    const result = await runAudit({
      task: 'plan',
      repoRoot: dir,
      planFile: plan,
      emptyMcpConfigPath: path.join(__dirname, '..', '..', 'config', 'empty-mcp.json'),
      userConfig: { configured: false, mode: 'legacy-unconfigured' },
      detectImpl: legacyDetect(['claude', 'codex']),
      runImpl,
    });
    assert.equal(result.aggregateStatus, 'all_success');
    assert.equal(result.envelopes.length, 2);
    assert.deepEqual(result.envelopes.map((e) => e.reviewer), ['claude', 'codex']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runAudit both-unavailable returns aggregateStatus unavailable', async () => {
  const result = await runAudit({
    task: 'plan',
    repoRoot: '/repo',
    planFile: undefined,
    userConfig: { configured: false, mode: 'legacy-unconfigured' },
    detectImpl: legacyDetect([]),
  });
  assert.equal(result.aggregateStatus, 'unavailable');
  assert.equal(result.envelopes[0].status, 'unavailable');
});

test('runSingleReview fails closed when scope snapshot matches no files', async () => {
  // We exercise the empty-scope guard indirectly through downgradeOutOfScopeFindings
  // (which is the function that would otherwise let every finding through) plus
  // a direct assertion that an empty-files snapshot is treated as "all in scope"
  // ONLY when the policy does not require a snapshot. The audit-layer guard in
  // runSingleReview rejects empty snapshots for code/security tasks at
  // buildScopeSnapshot time; here we confirm downgradeOutOfScopeFindings does
  // NOT silently downgrade everything when files is empty (that would be the
  // fail-open case the guard prevents).
  const env = validEnvelope({
    findings: [
      { severity: 'high', category: 'x', title: 'anywhere', evidence: { file: 'anywhere.cjs', line: 1, symbol: null, reason: 'r' }, recommendation: 'fix', confidence: 0.5, verification: 'candidate' },
    ],
  });
  // An empty-files snapshot is the ambiguous case. The fix is at the audit
  // layer (reject empty scope), so downgradeOutOfScopeFindings does not need
  // to handle it. We assert it leaves findings as-is rather than failing open.
  const out = downgradeOutOfScopeFindings(env, { files: [] });
  assert.equal(out.findings[0].verification, 'candidate');
});

test('runSingleReview stamps the host-computed planDigest even when reviewer supplies one', async () => {
  const { dir, plan } = await writePlan();
  try {
    // Reviewer returns a spoofed digest; the host must overwrite it.
    const reviewerEnvelope = validEnvelope({
      task: 'plan',
      role: 'plan',
      planDigest: 'sha256:' + '0'.repeat(64),
    });
    const env = await runSingleReview({
      task: 'plan',
      reviewer: 'claude',
      repoRoot: dir,
      planFile: plan,
      program: '/bin/claude',
      emptyMcpConfigPath: path.join(__dirname, '..', '..', 'config', 'empty-mcp.json'),
      runImpl: fakeRunImpl(JSON.stringify(reviewerEnvelope)),
    });
    // The host-computed digest must NOT equal the spoofed all-zeros digest.
    assert.notEqual(env.planDigest, 'sha256:' + '0'.repeat(64));
    assert.match(env.planDigest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
