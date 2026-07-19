'use strict';

const TASKS = new Set(['plan', 'code', 'tests', 'security']);
const REVIEWERS = new Set(['claude', 'codex', 'opencode', 'antigravity', 'cursor']);
const STATUSES = new Set([
  'success',
  'unavailable',
  'invalid_request',
  'configuration_required',
  'capability_mismatch',
  'process_failed',
  'timed_out',
  'policy_denied',
  'invalid_output',
]);
const OUTCOMES = new Set(['passed', 'failed', 'inconclusive', 'not_run', 'policy_blocked']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireKeys(value, required, optional = []) {
  if (!isPlainObject(value)) {
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function stringWithin(value, { min = 0, max = Infinity } = {}) {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function nullableInteger(value, minimum = 0) {
  return value === null || (Number.isInteger(value) && value >= minimum);
}

function isStringArray(value, maxLength = 4096) {
  return Array.isArray(value) && value.every((item) => stringWithin(item, { max: maxLength }));
}

function validateEvidence(value) {
  return (
    requireKeys(value, ['file', 'line', 'symbol', 'reason']) &&
    stringWithin(value.file, { min: 1, max: 4096 }) &&
    nullableInteger(value.line, 1) &&
    (value.symbol === null || stringWithin(value.symbol, { max: 512 })) &&
    stringWithin(value.reason, { min: 1, max: 8192 })
  );
}

function validateRequirementEvidence(value) {
  return (
    requireKeys(value, ['file', 'reason'], ['line', 'symbol']) &&
    stringWithin(value.file, { min: 1, max: 4096 }) &&
    (value.line === undefined || nullableInteger(value.line, 1)) &&
    (value.symbol === undefined || value.symbol === null || stringWithin(value.symbol, { max: 512 })) &&
    stringWithin(value.reason, { min: 1, max: 8192 })
  );
}

function validateRequirement(value) {
  return (
    requireKeys(value, ['id', 'status'], ['title', 'evidence']) &&
    stringWithin(value.id, { min: 1, max: 256 }) &&
    ['implemented', 'partial', 'missing', 'deviated', 'not_verifiable'].includes(value.status) &&
    (value.title === undefined || stringWithin(value.title, { max: 512 })) &&
    (value.evidence === undefined || (Array.isArray(value.evidence) && value.evidence.every(validateRequirementEvidence)))
  );
}

function validateFinding(value) {
  return (
    requireKeys(value, ['severity', 'category', 'title', 'evidence', 'recommendation', 'confidence', 'verification']) &&
    ['critical', 'high', 'medium', 'low', 'info'].includes(value.severity) &&
    stringWithin(value.category, { min: 1, max: 128 }) &&
    stringWithin(value.title, { min: 1, max: 512 }) &&
    validateEvidence(value.evidence) &&
    stringWithin(value.recommendation, { min: 1, max: 8192 }) &&
    typeof value.confidence === 'number' &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    ['candidate', 'verified', 'unverified', 'out_of_scope'].includes(value.verification)
  );
}

function validateCommand(value) {
  return (
    requireKeys(value, ['argv', 'cwd', 'exitCode', 'durationMs', 'timedOut'], ['stdoutTruncated', 'stderrTruncated']) &&
    Array.isArray(value.argv) &&
    value.argv.length > 0 &&
    value.argv.every((argument) => stringWithin(argument, { min: 1 })) &&
    stringWithin(value.cwd, { min: 1, max: 4096 }) &&
    nullableInteger(value.exitCode, 0) &&
    Number.isInteger(value.durationMs) &&
    value.durationMs >= 0 &&
    typeof value.timedOut === 'boolean' &&
    (value.stdoutTruncated === undefined || typeof value.stdoutTruncated === 'boolean') &&
    (value.stderrTruncated === undefined || typeof value.stderrTruncated === 'boolean')
  );
}

function validateReviewResult(value, expected) {
  if (
    !requireKeys(
      value,
      ['schemaVersion', 'task', 'role', 'reviewer', 'status', 'summary', 'requirements', 'findings', 'testExecution', 'diagnostics'],
      ['planDigest']
    ) ||
    value.schemaVersion !== 2 ||
    !TASKS.has(value.task) ||
    !TASKS.has(value.role) ||
    !REVIEWERS.has(value.reviewer) ||
    !STATUSES.has(value.status) ||
    !stringWithin(value.summary, { max: 16384 }) ||
    !Array.isArray(value.requirements) ||
    !value.requirements.every(validateRequirement) ||
    !Array.isArray(value.findings) ||
    value.findings.length > 500 ||
    !value.findings.every(validateFinding) ||
    (value.planDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(value.planDigest))
  ) {
    return false;
  }

  if (expected.task !== undefined && value.task !== expected.task) {
    return false;
  }
  if (expected.role !== undefined && value.role !== expected.role) {
    return false;
  }
  if (expected.reviewer !== undefined && value.reviewer !== expected.reviewer) {
    return false;
  }

  const tests = value.testExecution;
  if (
    !requireKeys(tests, ['attempted', 'verifiedByEvents', 'outcome', 'commands', 'workspaceChanged'], ['workspaceChanges', 'artifacts']) ||
    typeof tests.attempted !== 'boolean' ||
    typeof tests.verifiedByEvents !== 'boolean' ||
    !OUTCOMES.has(tests.outcome) ||
    !Array.isArray(tests.commands) ||
    !tests.commands.every(validateCommand) ||
    typeof tests.workspaceChanged !== 'boolean' ||
    (tests.workspaceChanges !== undefined && !isStringArray(tests.workspaceChanges)) ||
    (tests.artifacts !== undefined && !isStringArray(tests.artifacts))
  ) {
    return false;
  }

  const diagnostics = value.diagnostics;
  return (
    requireKeys(diagnostics, ['durationMs'], ['stdoutTruncated', 'stderrTruncated', 'warnings', 'rawOutput']) &&
    Number.isInteger(diagnostics.durationMs) &&
    diagnostics.durationMs >= 0 &&
    (diagnostics.stdoutTruncated === undefined || typeof diagnostics.stdoutTruncated === 'boolean') &&
    (diagnostics.stderrTruncated === undefined || typeof diagnostics.stderrTruncated === 'boolean') &&
    (diagnostics.warnings === undefined || isStringArray(diagnostics.warnings)) &&
    (diagnostics.rawOutput === undefined || diagnostics.rawOutput === null || stringWithin(diagnostics.rawOutput, { max: 32768 }))
  );
}

function baseEnvelope({ task, role, reviewer, status, summary, processResult, rawOutput = undefined }) {
  const diagnostics = {
    durationMs: processResult.durationMs,
    stdoutTruncated: processResult.stdoutTruncated,
    stderrTruncated: processResult.stderrTruncated,
  };
  if (rawOutput !== undefined) {
    diagnostics.rawOutput = rawOutput;
  }
  return {
    schemaVersion: 2,
    task,
    role,
    reviewer,
    status,
    summary,
    requirements: [],
    findings: [],
    testExecution: {
      attempted: false,
      verifiedByEvents: false,
      outcome: 'not_run',
      commands: [],
      workspaceChanged: false,
    },
    diagnostics,
  };
}

function normalizeReviewResult({ task, role, reviewer, processResult }) {
  if (!TASKS.has(task) || !TASKS.has(role) || !REVIEWERS.has(reviewer)) {
    throw new TypeError('task, role, and reviewer must use stable contract IDs.');
  }
  if (!isPlainObject(processResult)) {
    throw new TypeError('processResult must be an object.');
  }

  if (processResult.timedOut) {
    return baseEnvelope({ task, role, reviewer, status: 'timed_out', summary: 'Reviewer process timed out.', processResult });
  }
  if (processResult.outputLimited) {
    return baseEnvelope({ task, role, reviewer, status: 'invalid_output', summary: 'Reviewer output exceeded the configured limit.', processResult });
  }
  if (processResult.startError || processResult.exitCode !== 0) {
    return baseEnvelope({ task, role, reviewer, status: 'process_failed', summary: 'Reviewer process failed.', processResult });
  }

  let parsed;
  try {
    parsed = JSON.parse(processResult.stdout);
  } catch {
    return baseEnvelope({
      task,
      role,
      reviewer,
      status: 'invalid_output',
      summary: 'Reviewer output was not valid JSON.',
      processResult,
      rawOutput: processResult.stdout.slice(0, 32768),
    });
  }

  if (!validateReviewResult(parsed, { task, role, reviewer })) {
    return baseEnvelope({
      task,
      role,
      reviewer,
      status: 'invalid_output',
      summary: 'Reviewer output did not satisfy the v2 result contract.',
      processResult,
      rawOutput: processResult.stdout.slice(0, 32768),
    });
  }

  parsed.diagnostics = {
    ...parsed.diagnostics,
    durationMs: processResult.durationMs,
    stdoutTruncated: processResult.stdoutTruncated,
    stderrTruncated: processResult.stderrTruncated,
  };
  return parsed;
}

module.exports = {
  normalizeReviewResult,
  validateReviewResult,
};
