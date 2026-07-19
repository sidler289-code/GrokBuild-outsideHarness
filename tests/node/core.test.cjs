'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { EventRecorder } = require('../../lib/core/event-recorder.cjs');
const { runBoundedProcess } = require('../../lib/core/bounded-process.cjs');
const { normalizeReviewResult } = require('../../lib/core/normalize-result.cjs');
const { repoPath } = require('./helpers/paths.cjs');

const FAKE_HARNESS = repoPath('tests', 'fixtures', 'fake-harness', 'index.cjs');
const ORPHAN_PARENT = repoPath('tests', 'fixtures', 'fake-harness', 'orphan-parent.cjs');

function runFake(mode, overrides = {}) {
  return runBoundedProcess({
    program: process.execPath,
    args: [FAKE_HARNESS],
    env: {
      ...process.env,
      FAKE_HARNESS_MODE: mode,
      ...overrides.env,
    },
    input: overrides.input ?? 'PROMPT_SECRET_STDIN_ONLY',
    timeoutMs: overrides.timeoutMs ?? 2_000,
    maxOutputBytes: overrides.maxOutputBytes ?? 1_048_576,
    eventRecorder: overrides.eventRecorder,
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function waitForExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`child process ${pid} survived bounded-process cleanup`);
}

test('bounded process returns successful stdout and records metadata without prompt text', async () => {
  const events = new EventRecorder();
  const result = await runFake('success', { eventRecorder: events });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.outputLimited, false);
  assert.match(result.stdout, /fake harness: success/);
  assert.match(result.stderr, /^$/);
  assert.equal(events.snapshot().events.length, 2);
  assert.doesNotMatch(JSON.stringify(events.snapshot()), /PROMPT_SECRET_STDIN_ONLY/);
});

test('prompt is delivered on stdin and never appended to argv', async () => {
  const secret = 'PROMPT_SECRET_MUST_NOT_BE_AN_ARGUMENT';
  const argv = await runFake('echo-argv', { input: secret });
  const stdin = await runFake('echo-stdin', { input: secret });

  assert.doesNotMatch(argv.stdout, /PROMPT_SECRET_MUST_NOT_BE_AN_ARGUMENT/);
  assert.equal(stdin.stdout, secret);
});

test('non-zero exit is preserved for the result normalizer', async () => {
  const processResult = await runFake('fail');
  const result = normalizeReviewResult({
    task: 'code',
    role: 'code',
    reviewer: 'claude',
    processResult,
  });

  assert.equal(processResult.exitCode, 1);
  assert.match(processResult.stderr, /simulated failure/);
  assert.equal(result.status, 'process_failed');
});

test('timeout terminates a process tree and reports timed_out', async () => {
  const processResult = await runFake('timeout', { timeoutMs: 75 });
  const result = normalizeReviewResult({
    task: 'code',
    role: 'code',
    reviewer: 'claude',
    processResult,
  });

  assert.equal(processResult.timedOut, true);
  assert.equal(processResult.terminationReason, 'timeout');
  assert.equal(result.status, 'timed_out');
});

test('output cap prevents unbounded capture and classifies the result as invalid_output', async () => {
  const processResult = await runFake('huge', { maxOutputBytes: 4_096 });
  const result = normalizeReviewResult({
    task: 'code',
    role: 'code',
    reviewer: 'claude',
    processResult,
  });

  assert.equal(processResult.outputLimited, true);
  assert.equal(processResult.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(processResult.stdout, 'utf8') <= 4_096);
  assert.equal(result.status, 'invalid_output');
});

test('timeout kills a descendant process instead of leaving an orphan behind', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-harness-review-core-'));
  const pidFile = path.join(temporaryDirectory, 'child.pid');
  try {
    const result = await runBoundedProcess({
      program: process.execPath,
      args: [ORPHAN_PARENT],
      env: { ...process.env, FAKE_HARNESS_CHILD_PID_FILE: pidFile },
      input: '',
      timeoutMs: 125,
      maxOutputBytes: 4_096,
    });
    assert.equal(result.timedOut, true);
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    assert.ok(Number.isInteger(pid) && pid > 0);
    await waitForExit(pid);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('normalizer rejects malformed successful output and retains only a bounded diagnostic preview', () => {
  const result = normalizeReviewResult({
    task: 'code',
    role: 'code',
    reviewer: 'claude',
    processResult: {
      exitCode: 0,
      timedOut: false,
      outputLimited: false,
      stdout: 'not JSON',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
    },
  });

  assert.equal(result.status, 'invalid_output');
  assert.equal(result.diagnostics.rawOutput, 'not JSON');
});

test('normalizer accepts a valid v2 envelope and records observed process diagnostics', () => {
  const raw = {
    schemaVersion: 2,
    task: 'code',
    role: 'code',
    reviewer: 'claude',
    status: 'success',
    summary: 'valid result',
    requirements: [
      {
        id: 'R-1',
        status: 'implemented',
        evidence: [{ file: 'lib/core/example.cjs', reason: 'covered by a focused test' }],
      },
    ],
    findings: [],
    testExecution: {
      attempted: false,
      verifiedByEvents: false,
      outcome: 'not_run',
      commands: [],
      workspaceChanged: false,
    },
    diagnostics: { durationMs: 0 },
  };
  const result = normalizeReviewResult({
    task: 'code',
    role: 'code',
    reviewer: 'claude',
    processResult: {
      exitCode: 0,
      timedOut: false,
      outputLimited: false,
      stdout: JSON.stringify(raw),
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 12,
    },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.requirements[0].evidence[0].reason, 'covered by a focused test');
  assert.equal(result.diagnostics.durationMs, 12);
});
