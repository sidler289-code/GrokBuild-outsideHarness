'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TestExecutionError,
  normalizeApprovedCommands,
  matchApprovedCommand,
  verifyTestExecutionEvents,
  safeTestEnvironment,
  executeApprovedCommands,
} = require('../../lib/core/test-execution.cjs');

const REPO = path.resolve(process.cwd());

function userConfig(enabled = true) {
  return {
    configured: true,
    config: {
      testsExecution: {
        enabled,
        mode: 'host-bounded',
        defaultTimeoutSeconds: 10,
        maxOutputBytes: 128,
      },
    },
  };
}

function projectConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    testsExecution: {
      commands: [{ id: 'unit', argv: ['node', '--test'], cwd: '.', timeoutSeconds: 5 }],
      environmentAllowlist: ['CI'],
      ...overrides,
    },
  };
}

function testEvent(overrides = {}) {
  return {
    type: 'test_command_finished',
    data: {
      argv: ['node', '--test'],
      cwd: '.',
      exitCode: 0,
      durationMs: 12,
      timedOut: false,
      stdout: 'all green',
      stderr: '',
      ...overrides,
    },
  };
}

test('approved command matching requires exact normalized argv and cwd inside the repository', () => {
  const approved = normalizeApprovedCommands({
    repoRoot: REPO,
    projectConfig: projectConfig(),
    defaultTimeoutSeconds: 10,
  });
  assert.equal(matchApprovedCommand(testEvent().data, approved, REPO).id, 'unit');
  assert.equal(matchApprovedCommand(testEvent({ argv: ['node', '--test', '--watch'] }).data, approved, REPO), null);
  assert.equal(matchApprovedCommand(testEvent({ cwd: '../outside' }).data, approved, REPO), null);
  assert.throws(
    () => normalizeApprovedCommands({ repoRoot: REPO, projectConfig: projectConfig({ commands: [{ id: 'escape', argv: ['node'], cwd: '../outside' }] }), defaultTimeoutSeconds: 10 }),
    (error) => error instanceof TestExecutionError && error.code === 'cwd_outside_repo'
  );
});

test('event verification classifies pass, fail, timeout, and capped output without trusting a claim', () => {
  const approved = normalizeApprovedCommands({ repoRoot: REPO, projectConfig: projectConfig(), defaultTimeoutSeconds: 10 });
  const pass = verifyTestExecutionEvents({ events: [testEvent()], approvedCommands: approved, repoRoot: REPO, maxOutputBytes: 128 });
  assert.equal(pass.verifiedByEvents, true);
  assert.equal(pass.outcome, 'passed');

  const fail = verifyTestExecutionEvents({ events: [testEvent({ exitCode: 1 })], approvedCommands: approved, repoRoot: REPO, maxOutputBytes: 128 });
  assert.equal(fail.outcome, 'failed');

  const timeout = verifyTestExecutionEvents({ events: [testEvent({ exitCode: null, timedOut: true })], approvedCommands: approved, repoRoot: REPO, maxOutputBytes: 128 });
  assert.equal(timeout.outcome, 'inconclusive');

  const limited = verifyTestExecutionEvents({ events: [testEvent({ stdout: 'x'.repeat(1024) })], approvedCommands: approved, repoRoot: REPO, maxOutputBytes: 128 });
  assert.equal(limited.outcome, 'inconclusive');
  assert.equal(limited.commands[0].stdoutTruncated, true);
});

test('missing, malformed, or unapproved test events fail closed', () => {
  const approved = normalizeApprovedCommands({ repoRoot: REPO, projectConfig: projectConfig(), defaultTimeoutSeconds: 10 });
  const missing = verifyTestExecutionEvents({ events: [], approvedCommands: approved, repoRoot: REPO, maxOutputBytes: 128 });
  assert.equal(missing.outcome, 'inconclusive');
  assert.equal(missing.verifiedByEvents, false);

  const unapproved = verifyTestExecutionEvents({
    events: [testEvent({ argv: ['node', '--eval', 'process.exit(0)'] })],
    approvedCommands: approved,
    repoRoot: REPO,
    maxOutputBytes: 128,
  });
  assert.equal(unapproved.outcome, 'policy_blocked');
  assert.equal(unapproved.commands.length, 0);
});

test('safe test environment rejects secrets and language runtime injection variables', () => {
  for (const name of ['OPENAI_API_KEY', 'TOKEN', 'NODE_OPTIONS', 'BASH_ENV', 'PYTHONPATH']) {
    assert.throws(
      () => safeTestEnvironment({ environmentAllowlist: [name], env: { [name]: 'danger' } }),
      (error) => error instanceof TestExecutionError && error.code === 'unsafe_environment'
    );
  }
});

test('safe test environment keeps a fixed baseline plus explicit allowlist only', () => {
  const env = safeTestEnvironment({
    environmentAllowlist: ['CI'],
    env: { PATH: '/bin', HOME: '/home/tester', CI: '1', SECRET_SHOULD_NOT_APPEAR: 'not-a-secret-here', OTHER: 'discard' },
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CI, '1');
  assert.equal(env.OTHER, undefined);
});

test('direct executor observes workspace changes and does not run when the user policy is disabled', async () => {
  const calls = [];
  let statusCalls = 0;
  const runImpl = async (options) => {
    calls.push(options);
    if (options.program === 'git') {
      statusCalls += 1;
      return {
        exitCode: 0, timedOut: false, outputLimited: false, startError: null,
        stdout: statusCalls === 1 ? '' : '?? coverage/\0', stderr: '',
        stdoutTruncated: false, stderrTruncated: false, durationMs: 1,
      };
    }
    return {
      exitCode: 0, timedOut: false, outputLimited: false, startError: null,
      stdout: 'ok', stderr: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 2,
    };
  };
  const result = await executeApprovedCommands({
    repoRoot: REPO,
    userConfig: userConfig(true),
    projectConfig: projectConfig(),
    commandIds: ['unit'],
    runImpl,
    env: { PATH: '/bin', HOME: '/home/tester', CI: '1', OTHER: 'discard' },
  });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.workspaceChanged, true);
  assert.deepEqual(result.workspaceChanges, ['?? coverage/']);
  const commandCall = calls.find((call) => call.program === 'node');
  assert.deepEqual(commandCall.env, { PATH: '/bin', HOME: '/home/tester', CI: '1' });

  const blocked = await executeApprovedCommands({
    repoRoot: REPO,
    userConfig: userConfig(false),
    projectConfig: projectConfig(),
    commandIds: ['unit'],
    runImpl,
  });
  assert.equal(blocked.outcome, 'policy_blocked');
  assert.equal(blocked.attempted, false);
});
