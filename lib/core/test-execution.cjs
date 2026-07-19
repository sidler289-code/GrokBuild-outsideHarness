'use strict';

/**
 * PR-5: host-bounded direct test execution.
 *
 * This module is the sole owner of the host-side test command contract.  It
 * deliberately treats a harness' account of a command as untrusted until the
 * event exactly matches a command that the project persisted in
 * `.cross-harness-review.json`.
 */

const fs = require('node:fs');
const path = require('node:path');

const { runBoundedProcess } = require('./bounded-process.cjs');

const MAX_WORKSPACE_CHANGES = 256;
const GIT_STATUS_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_OUTPUT_BYTES = 1_048_576;

class TestExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TestExecutionError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function assertRepoRoot(repoRoot) {
  if (!isNonEmptyString(repoRoot)) {
    throw new TestExecutionError('invalid_request', 'repoRoot must be a non-empty string.');
  }
  return path.resolve(repoRoot);
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveExistingPathInside(root, candidate) {
  let realRoot;
  let realCandidate;
  try {
    realRoot = fs.realpathSync.native(root);
    realCandidate = fs.realpathSync.native(candidate);
  } catch {
    throw new TestExecutionError('cwd_unresolvable', 'Command cwd and repository root must exist before execution.');
  }
  if (!isPathInside(realRoot, realCandidate)) {
    throw new TestExecutionError('cwd_outside_repo', 'Command cwd resolves outside the repository.');
  }
  return { root: realRoot, candidate: realCandidate };
}

function normalizeArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => !isNonEmptyString(value))) {
    throw new TestExecutionError('invalid_command', 'argv must be a non-empty array of non-empty strings.');
  }
  return argv.map((value) => value.normalize('NFC'));
}

function normalizeApprovedCommand(command, { repoRoot, defaultTimeoutSeconds }) {
  if (!isPlainObject(command)) {
    throw new TestExecutionError('invalid_command', 'Approved command must be an object.');
  }
  if (!isNonEmptyString(command.id)) {
    throw new TestExecutionError('invalid_command', 'Approved command id must be a non-empty string.');
  }
  if (!isNonEmptyString(command.cwd)) {
    throw new TestExecutionError('invalid_command', `Approved command ${command.id} is missing cwd.`);
  }
  const requestedRoot = assertRepoRoot(repoRoot);
  const requestedCwd = path.resolve(requestedRoot, command.cwd);
  if (!isPathInside(requestedRoot, requestedCwd)) {
    throw new TestExecutionError('cwd_outside_repo', `Approved command ${command.id} resolves outside the repository.`);
  }
  let root;
  let cwd;
  try {
    ({ root, candidate: cwd } = resolveExistingPathInside(requestedRoot, requestedCwd));
  } catch (error) {
    if (error instanceof TestExecutionError && error.code === 'cwd_outside_repo') {
      throw new TestExecutionError('cwd_outside_repo', `Approved command ${command.id} resolves outside the repository.`);
    }
    throw error;
  }
  const timeoutSeconds = command.timeoutSeconds ?? defaultTimeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new TestExecutionError('invalid_command', `Approved command ${command.id} has an invalid timeout.`);
  }
  return Object.freeze({
    id: command.id,
    argv: normalizeArgv(command.argv),
    cwd,
    displayCwd: path.relative(root, cwd) || '.',
    timeoutSeconds,
  });
}

function normalizeApprovedCommands({ repoRoot, projectConfig, defaultTimeoutSeconds }) {
  if (!isPlainObject(projectConfig) || !isPlainObject(projectConfig.testsExecution)) {
    throw new TestExecutionError('configuration_required', 'Project testsExecution configuration is required.');
  }
  const commands = projectConfig.testsExecution.commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new TestExecutionError('configuration_required', 'Project testsExecution.commands must not be empty.');
  }
  if (!Number.isInteger(defaultTimeoutSeconds) || defaultTimeoutSeconds < 1 || defaultTimeoutSeconds > 3600) {
    throw new TestExecutionError('invalid_request', 'defaultTimeoutSeconds must be in the range 1..3600.');
  }

  const ids = new Set();
  return commands.map((command) => {
    const normalized = normalizeApprovedCommand(command, { repoRoot, defaultTimeoutSeconds });
    if (ids.has(normalized.id)) {
      throw new TestExecutionError('invalid_command', `Duplicate approved command id: ${normalized.id}.`);
    }
    ids.add(normalized.id);
    return normalized;
  });
}

function equalArgv(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveEventCwd(cwd, repoRoot) {
  if (!isNonEmptyString(cwd)) {
    return null;
  }
  const root = assertRepoRoot(repoRoot);
  try {
    return resolveExistingPathInside(root, path.resolve(root, cwd)).candidate;
  } catch {
    return null;
  }
}

/**
 * Match only an exact normalized argv and an exact resolved cwd.  In
 * particular, a path prefix (for example `repo-old`) does not match `repo`.
 */
function matchApprovedCommand(event, approvedCommands, repoRoot) {
  if (!isPlainObject(event)) {
    return null;
  }
  let argv;
  try {
    argv = normalizeArgv(event.argv);
  } catch {
    return null;
  }
  const cwd = resolveEventCwd(event.cwd, repoRoot);
  if (!cwd) {
    return null;
  }
  return approvedCommands.find((command) => command.cwd === cwd && equalArgv(command.argv, argv)) || null;
}

function capText(value, maxBytes) {
  const text = typeof value === 'string' ? value : '';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) {
    return { text, truncated: false };
  }
  return { text: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

function commandEvidence(event, approved, maxOutputBytes) {
  if (!Number.isInteger(event.durationMs) || event.durationMs < 0 || typeof event.timedOut !== 'boolean') {
    return null;
  }
  if (event.exitCode !== null && (!Number.isInteger(event.exitCode) || event.exitCode < 0)) {
    return null;
  }
  const stdout = capText(event.stdout, maxOutputBytes);
  const stderr = capText(event.stderr, maxOutputBytes);
  return {
    argv: approved.argv.slice(),
    cwd: approved.displayCwd,
    exitCode: event.exitCode ?? null,
    durationMs: event.durationMs,
    timedOut: event.timedOut,
    stdoutTruncated: Boolean(event.stdoutTruncated) || stdout.truncated,
    stderrTruncated: Boolean(event.stderrTruncated) || stderr.truncated,
  };
}

function outcomeForCommands(commands) {
  if (commands.length === 0) {
    return 'inconclusive';
  }
  if (commands.some((command) => command.timedOut || command.exitCode === null || command.stdoutTruncated || command.stderrTruncated)) {
    return 'inconclusive';
  }
  return commands.some((command) => command.exitCode !== 0) ? 'failed' : 'passed';
}

/**
 * Convert adapter-produced structured events into host-verified evidence.
 * Unknown events are ignored.  A malformed, unapproved, or outside-repo test
 * event invalidates the entire claimed run instead of silently accepting a
 * subset of its commands.
 */
function verifyTestExecutionEvents({ events, approvedCommands, repoRoot, maxOutputBytes }) {
  if (!Array.isArray(events)) {
    throw new TestExecutionError('invalid_events', 'events must be an array.');
  }
  if (!Array.isArray(approvedCommands)) {
    throw new TestExecutionError('invalid_request', 'approvedCommands must be an array.');
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new TestExecutionError('invalid_request', 'maxOutputBytes must be a positive integer.');
  }

  const observed = events.filter((event) => isPlainObject(event) && event.type === 'test_command_finished');
  if (observed.length === 0) {
    return {
      attempted: false,
      verifiedByEvents: false,
      outcome: 'inconclusive',
      commands: [],
      workspaceChanged: false,
      warnings: ['No verifiable test_command_finished event was produced.'],
    };
  }

  const commands = [];
  for (const wrappedEvent of observed) {
    const event = isPlainObject(wrappedEvent.data) ? wrappedEvent.data : wrappedEvent;
    const approved = matchApprovedCommand(event, approvedCommands, repoRoot);
    const evidence = approved && commandEvidence(event, approved, maxOutputBytes);
    if (!approved || !evidence) {
      return {
        attempted: true,
        verifiedByEvents: false,
        outcome: 'policy_blocked',
        commands: [],
        workspaceChanged: false,
        warnings: ['A test command event was malformed, unapproved, or used a cwd outside the repository.'],
      };
    }
    commands.push(evidence);
  }

  return {
    attempted: true,
    verifiedByEvents: true,
    outcome: outcomeForCommands(commands),
    commands,
    workspaceChanged: false,
    warnings: [],
  };
}

function safeTestEnvironment({ environmentAllowlist = [], env = process.env } = {}) {
  if (!Array.isArray(environmentAllowlist) || environmentAllowlist.some((name) => !isNonEmptyString(name))) {
    throw new TestExecutionError('invalid_environment', 'environmentAllowlist must contain non-empty strings.');
  }
  const baselineNames = process.platform === 'win32'
    ? ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME']
    : ['PATH', 'HOME', 'TMPDIR', 'TMP'];
  const next = {};
  for (const name of new Set([...baselineNames, ...environmentAllowlist])) {
    if (typeof env[name] === 'string') {
      next[name] = env[name];
    }
  }
  return next;
}

function parseGitStatus(stdout) {
  return stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.length > 3 ? entry : entry.trim())
    .slice(0, MAX_WORKSPACE_CHANGES);
}

async function snapshotGitStatus({ repoRoot, runImpl = runBoundedProcess }) {
  const root = assertRepoRoot(repoRoot);
  const result = await runImpl({
    program: 'git',
    args: ['status', '--porcelain=v1', '-z'],
    cwd: root,
    env: safeTestEnvironment(),
    input: '',
    timeoutMs: GIT_STATUS_TIMEOUT_MS,
    maxOutputBytes: GIT_STATUS_MAX_OUTPUT_BYTES,
  });
  if (result.startError || result.timedOut || result.outputLimited || result.exitCode !== 0) {
    throw new TestExecutionError('workspace_observation_failed', 'Unable to record Git status for the test run.');
  }
  return parseGitStatus(result.stdout);
}

function requireEnabledUserPolicy(userConfig) {
  if (!isPlainObject(userConfig) || userConfig.configured !== true || !isPlainObject(userConfig.config)) {
    return { allowed: false, reason: 'configuration_required' };
  }
  const policy = userConfig.config.testsExecution;
  if (!isPlainObject(policy) || policy.enabled !== true || policy.mode !== 'host-bounded') {
    return { allowed: false, reason: 'policy_blocked' };
  }
  return { allowed: true, policy };
}

/**
 * Directly execute a caller-selected subset of already-approved commands.
 * This API is deliberately separate from event verification: an adapter must
 * still provide verifiable tool events before it can be assigned the tests
 * role.  The executor is used by adapters that have that capability and by
 * focused host-level tests.
 */
async function executeApprovedCommands({
  repoRoot,
  userConfig,
  projectConfig,
  commandIds,
  runImpl = runBoundedProcess,
  env = process.env,
}) {
  const policyCheck = requireEnabledUserPolicy(userConfig);
  if (!policyCheck.allowed) {
    return {
      attempted: false,
      verifiedByEvents: false,
      outcome: policyCheck.reason === 'policy_blocked' ? 'policy_blocked' : 'not_run',
      commands: [],
      workspaceChanged: false,
      workspaceChanges: [],
      warnings: [policyCheck.reason === 'policy_blocked' ? 'testsExecution.enabled is not true.' : 'Configured user testsExecution policy is required.'],
    };
  }
  const approved = normalizeApprovedCommands({
    repoRoot,
    projectConfig,
    defaultTimeoutSeconds: policyCheck.policy.defaultTimeoutSeconds,
  });
  if (!Array.isArray(commandIds) || commandIds.length === 0 || commandIds.some((id) => !isNonEmptyString(id))) {
    throw new TestExecutionError('invalid_request', 'commandIds must select at least one approved command.');
  }
  const selected = commandIds.map((id) => approved.find((command) => command.id === id));
  if (selected.some((command) => !command)) {
    throw new TestExecutionError('command_not_approved', 'A selected test command is not approved by project configuration.');
  }

  const before = await snapshotGitStatus({ repoRoot, runImpl });
  const environment = safeTestEnvironment({ environmentAllowlist: projectConfig.testsExecution.environmentAllowlist || [], env });
  const commands = [];
  for (const command of selected) {
    let result;
    try {
      result = await runImpl({
        program: command.argv[0],
        args: command.argv.slice(1),
        cwd: command.cwd,
        env: environment,
        input: '',
        timeoutMs: command.timeoutSeconds * 1000,
        maxOutputBytes: policyCheck.policy.maxOutputBytes,
      });
    } catch {
      // The after-status snapshot still runs: a failed launcher can leave files.
      result = { exitCode: null, durationMs: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false };
    }
    commands.push({
      argv: command.argv.slice(),
      cwd: command.displayCwd,
      exitCode: result.exitCode ?? null,
      durationMs: Number.isInteger(result.durationMs) && result.durationMs >= 0 ? result.durationMs : 0,
      timedOut: Boolean(result.timedOut),
      stdoutTruncated: Boolean(result.stdoutTruncated) || Boolean(result.outputLimited),
      stderrTruncated: Boolean(result.stderrTruncated) || Boolean(result.outputLimited),
    });
  }
  const after = await snapshotGitStatus({ repoRoot, runImpl });
  return {
    attempted: true,
    verifiedByEvents: false,
    outcome: outcomeForCommands(commands),
    commands,
    workspaceChanged: before.join('\0') !== after.join('\0'),
    workspaceChanges: after,
    warnings: ['Commands were host-executed; a harness tool-event proof is required before attributing this execution to a tests reviewer.'],
  };
}

module.exports = {
  TestExecutionError,
  isPathInside,
  resolveExistingPathInside,
  normalizeArgv,
  normalizeApprovedCommand,
  normalizeApprovedCommands,
  matchApprovedCommand,
  verifyTestExecutionEvents,
  safeTestEnvironment,
  parseGitStatus,
  snapshotGitStatus,
  requireEnabledUserPolicy,
  executeApprovedCommands,
};
