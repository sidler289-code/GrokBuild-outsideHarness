'use strict';

/**
 * PR-4: Audit orchestrator for plan/code/security tasks.
 *
 * Single owner (plan 4.1) of the audit turn pipeline:
 *   policy -> scope snapshot -> prompt -> adapter invocation -> bounded run
 *   -> normalize -> scope-gate findings -> return v2 envelope(s)
 *
 * This module is the place where configured-mode single-reviewer routing and
 * legacy-mode claude+codex fan-out both land. Shims never reimplement any of
 * it; they only forward to the CLI.
 *
 * Plan references:
 *  - 9.1 plan audit (read-only, requires plan file)
 *  - 9.2 code audit (requires plan file + scope, requirement coverage)
 *  - 9.3 (tests is PR-5 scope; this module refuses task='tests')
 *  - 2.4 legacy fan-out: both Claude and Codex run when available; a single
 *    reviewer degrades; both unavailable returns `unavailable`.
 *  - 12 security boundary: scope-gate findings, out-of-scope downgraded.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { runBoundedProcess, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } = require('./bounded-process.cjs');
const { EventRecorder } = require('./event-recorder.cjs');
const normalize = require('./normalize-result.cjs');
const { buildScopeSnapshot, isFileInScope } = require('./scope-snapshot.cjs');
const { buildPrompt } = require('./prompt-builder.cjs');
const { loadUserConfig } = require('./config.cjs');
const { detectLegacyReviewers } = require('./discovery.cjs');
const { getAdapter } = require('../adapters/index.cjs');
const { PLAN_POLICY } = require('../policies/plan.cjs');
const { CODE_POLICY } = require('../policies/code.cjs');
const { SECURITY_POLICY } = require('../policies/security.cjs');

const POLICIES = { plan: PLAN_POLICY, code: CODE_POLICY, security: SECURITY_POLICY };

class AuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function computePlanDigest(planFile, { fsImpl = fs } = {}) {
  if (typeof planFile !== 'string' || planFile.length === 0) {
    return null;
  }
  try {
    const content = fsImpl.readFileSync(planFile);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return `sha256:${hash}`;
  } catch {
    return null;
  }
}

function assertPlanFile(policy, planFile) {
  if (policy.requiresPlanFile) {
    if (typeof planFile !== 'string' || planFile.length === 0) {
      throw new AuditError('invalid_request', `${policy.task} audit requires --plan-file.`);
    }
    if (!fs.existsSync(planFile)) {
      throw new AuditError('invalid_request', `Plan file does not exist: ${planFile}`);
    }
  }
}

function downgradeOutOfScopeFindings(envelope, snapshot) {
  if (!isPlainObject(envelope) || !Array.isArray(envelope.findings) || !isPlainObject(snapshot)) {
    return envelope;
  }
  // Plan tasks have no scope snapshot; do not touch their findings.
  if (!Array.isArray(snapshot.files) || snapshot.files.length === 0) {
    return envelope;
  }
  const next = { ...envelope };
  next.findings = envelope.findings.map((finding) => {
    if (!isPlainObject(finding) || !isPlainObject(finding.evidence)) {
      return finding;
    }
    if (!isFileInScope(finding.evidence.file, snapshot)) {
      return { ...finding, verification: 'out_of_scope' };
    }
    return finding;
  });
  return next;
}

/**
 * Run a single reviewer for one task. Returns a v2 envelope.
 *
 * Options:
 *  - task: 'plan' | 'code' | 'security'
 *  - reviewer: stable harness id
 *  - repoRoot: absolute path
 *  - planFile: optional, required by plan/code
 *  - scopeSelector: optional, required by code/security
 *  - program: the discovered binary path for the reviewer
 *  - emptyMcpConfigPath: bundled path (Claude needs it)
 *  - timeoutMs / maxOutputBytes: bounded-process overrides
 *  - runImpl: injectable bounded runner for tests
 *  - extraInstructions: optional free-form instructions
 */
async function runSingleReview({
  task,
  reviewer,
  repoRoot,
  planFile,
  scopeSelector,
  program,
  emptyMcpConfigPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  runImpl = runBoundedProcess,
  extraInstructions,
  adapterOverride, // test hook; bypasses the registry
}) {
  const policy = POLICIES[task];
  if (!policy) {
    throw new AuditError('invalid_request', `Unsupported task: ${task}`);
  }
  if (task === 'tests') {
    throw new AuditError('invalid_request', 'tests audits ship in PR-5.');
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new AuditError('invalid_request', 'repoRoot must be a non-empty string.');
  }
  if (typeof program !== 'string' || program.length === 0) {
    throw new AuditError('invalid_request', 'program (reviewer binary) is required.');
  }
  assertPlanFile(policy, planFile);

  const adapter = adapterOverride || getAdapter(reviewer);
  // Capability gate: the adapter must declare the policy's required caps as
  // verified. We re-check this per call (not just at setup) so a future
  // capability regression cannot silently widen access.
  for (const cap of policy.allowedCapabilities) {
    if (adapter.capabilities[cap] !== 'verified') {
      const envelope = normalize.normalizeReviewResult({
        task,
        role: policy.role,
        reviewer,
        processResult: { exitCode: 0, timedOut: false, outputLimited: false, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 0 },
      });
      return {
        ...envelope,
        status: 'capability_mismatch',
        summary: `Reviewer ${reviewer} does not verifiedly support ${cap} for task ${task}.`,
      };
    }
  }

  const planDigest = computePlanDigest(planFile);
  let snapshot = null;
  if (policy.requiresScopeSnapshot) {
    if (typeof scopeSelector !== 'string' || scopeSelector.length === 0) {
      throw new AuditError('invalid_request', `${task} audit requires a --scope selector.`);
    }
    snapshot = buildScopeSnapshot(scopeSelector, repoRoot);
    // Fail-closed: an empty diff means nothing is in scope, so a reviewer has
    // no business reporting findings. We refuse rather than silently letting
    // every finding through the gate (or downgrading everything to noise).
    if (!Array.isArray(snapshot.files) || snapshot.files.length === 0) {
      throw new AuditError(
        'invalid_request',
        `${task} audit scope "${scopeSelector}" matched no files; nothing to review.`
      );
    }
  }

  const prompt = buildPrompt({
    task,
    repoRoot,
    planFile,
    planDigest,
    snapshot,
    extraInstructions,
  });

  const invocation = adapter.buildInvocation({
    program,
    taskContext: { prompt, repoRoot, emptyMcpConfigPath },
  });

  // Static safety: the prompt must NEVER appear in argv.
  if (invocation.args.some((a) => typeof a === 'string' && a.includes(prompt))) {
    throw new AuditError('policy_violation', 'Adapter attempted to place the prompt in argv.');
  }

  const eventRecorder = new EventRecorder();
  const processResult = await runImpl({
    program: invocation.program,
    args: invocation.args,
    env: invocation.env,
    input: invocation.input,
    cwd: invocation.cwd,
    timeoutMs,
    maxOutputBytes,
    eventRecorder,
  });

  let envelope = adapter.normalizeFinalResult({ task, role: policy.role, reviewer, processResult }, normalize);
  envelope = downgradeOutOfScopeFindings(envelope, snapshot);
  // The host-computed plan digest is authoritative; always overwrite any
  // reviewer-supplied value so a compromised reviewer cannot spoof integrity.
  if (planDigest) {
    envelope = { ...envelope, planDigest };
  }
  // Bounded cleanup of any per-run temp files the adapter created (isolated
  // config dirs, etc.). Cleanup is best-effort and never masks the envelope.
  try {
    await adapter.cleanup({ cleanupPaths: invocation.cleanupPaths });
  } catch {
    // Best-effort; the bounded-process runner already terminated the child.
  }
  return envelope;
}

/**
 * Resolve which reviewer(s) to call for a task. Plan 2.4:
 *  - explicit --reviewer overrides one-shot and never persists.
 *  - configured mode: call roles.<task> (security follows code).
 *  - legacy-unconfigured mode: fan out to all available legacy reviewers.
 *
 * Returns an array of { reviewer, program } entries to call.
 */
async function resolveReviewersForTask({ task, explicitReviewer, userConfig, detectImpl = detectLegacyReviewers }) {
  if (explicitReviewer) {
    const detected = await detectImpl();
    const match = detected.find((d) => d.harnessId === explicitReviewer && d.available);
    if (!match) {
      return { reviewers: [], reason: 'unavailable', unavailable: [explicitReviewer] };
    }
    return { reviewers: [{ reviewer: explicitReviewer, program: match.candidate.path }], reason: 'explicit' };
  }

  if (!userConfig) {
    userConfig = loadUserConfig();
  }

  if (!userConfig.configured) {
    const detected = await detectImpl();
    const reviewers = detected
      .filter((d) => d.available)
      .map((d) => ({ reviewer: d.harnessId, program: d.candidate.path }));
    const unavailable = detected.filter((d) => !d.available).map((d) => d.harnessId);
    if (reviewers.length === 0) {
      return { reviewers: [], reason: 'unavailable', unavailable };
    }
    return { reviewers, reason: reviewers.length === 1 ? 'legacy_degraded' : 'legacy_fanout', unavailable };
  }

  // Configured mode: security follows code (plan 2.1).
  const roleForTask = task === 'security' ? 'code' : task;
  const harnessId = userConfig.config.roles[roleForTask];
  if (!harnessId) {
    return { reviewers: [], reason: 'unconfigured_role', unavailable: [] };
  }
  // Configured-mode discovery: detectImpl may be specialized for a single
  // harness (harnessId arg) or fall back to the legacy dual-probe. Either way
  // it returns detection summaries; we filter to the configured harness.
  const detected = await detectImpl(harnessId);
  const match = detected.find((d) => d.harnessId === harnessId && d.available);
  if (!match) {
    return { reviewers: [], reason: 'unavailable', unavailable: [harnessId] };
  }
  return {
    reviewers: [{ reviewer: harnessId, program: match.candidate.path }],
    reason: 'configured',
    unavailable: [],
  };
}

/**
 * Top-level audit entrypoint. Runs the resolved reviewer set, returns an
 * aggregated result with the individual envelopes and a transport-level
 * aggregate status. Plan-level approval aggregation (approved / needs_revision
 * etc.) is Grok's job, not the transport's (plan section 9.1).
 */
async function runAudit(options) {
  const { reviewers, reason, unavailable } = await resolveReviewersForTask(options);
  if (reviewers.length === 0) {
    const empty = normalize.normalizeReviewResult({
      task: options.task,
      role: POLICIES[options.task].role,
      reviewer: options.explicitReviewer || unavailable[0] || 'claude',
      processResult: { exitCode: 0, timedOut: false, outputLimited: false, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 0 },
    });
    return {
      aggregateStatus: 'unavailable',
      reason,
      unavailable,
      envelopes: [{ ...empty, status: 'unavailable', summary: 'No reviewer was available for this task.' }],
    };
  }

  const envelopes = [];
  for (const { reviewer, program } of reviewers) {
    const envelope = await runSingleReview({ ...options, reviewer, program });
    envelopes.push(envelope);
  }

  return {
    aggregateStatus: envelopes.every((e) => e.status === 'success') ? 'all_success' : 'mixed',
    reason,
    unavailable,
    envelopes,
  };
}

module.exports = {
  AuditError,
  POLICIES,
  computePlanDigest,
  downgradeOutOfScopeFindings,
  runSingleReview,
  resolveReviewersForTask,
  runAudit,
};
