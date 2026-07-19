'use strict';

/**
 * PR-4: Per-task prompt construction.
 *
 * Single owner (plan 4.1) of the prompt text sent to adapters. The prompt is
 * the only channel that conveys the task, scope boundary, output contract and
 * capability restrictions to the reviewer; it is delivered on stdin and never
 * interpolated into argv (plan section 12).
 *
 * The builder is pure: it returns a string. Adapters decide how to ship it
 * (stdin for Claude/Codex, an input file for adapters that require it).
 */

const path = require('node:path');

class PromptBuilderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PromptBuilderError';
    this.code = code;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assertTask(task) {
  if (!['plan', 'code', 'tests', 'security'].includes(task)) {
    throw new PromptBuilderError('invalid_task', `Unknown task: ${task}`);
  }
}

function formatScopeBoundary(snapshot) {
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.files) || snapshot.files.length === 0) {
    return 'No file scope restriction was supplied for this task.';
  }
  const list = snapshot.files.map((f) => `  - ${f}`).join('\n');
  return [
    'STRICT SCOPE BOUNDARY — you may only read and report findings about the',
    `following repo-relative paths (${snapshot.files.length} entr${snapshot.files.length === 1 ? 'y' : 'ies'}):`,
    list,
    'Findings about files outside this set will be downgraded to',
    'verification:"out_of_scope" and cannot block approval.',
  ].join('\n');
}

const TASK_INSTRUCTIONS = {
  plan: [
    'TASK: plan audit.',
    'You may read repository source files to assess whether the supplied plan',
    'is implementable. You MUST NOT write files, execute shell commands, open',
    'network connections, or load MCP/tools. Produce a v2 result envelope with',
    'task="plan" and role="plan"; cite real file/symbol evidence for every',
    'requirement you reference.',
  ].join('\n'),
  code: [
    'TASK: code audit against the supplied plan.',
    'Cross-check the implementation against the plan requirements. You MUST NOT',
    'write files, execute shell commands, open network connections, or load',
    'MCP/tools. For every requirement, emit one of:',
    '  implemented | partial | missing | deviated | not_verifiable',
    'with file/line evidence that falls inside the scope boundary below.',
  ].join('\n'),
  security: [
    'TASK: security audit.',
    'You are the security reviewer that follows the code reviewer (plan 2.1).',
    'You MUST NOT write files, execute shell commands, open network connections,',
    'or load MCP/tools. Report findings with severity, category, evidence and a',
    'concrete recommendation. Stay inside the scope boundary below.',
  ].join('\n'),
};

/**
 * Build a prompt for a plan/code/security task.
 *
 * Required:
 *  - task: one of plan|code|security (tests is handled by the tests policy in PR-5)
 *  - repoRoot: absolute path to the repository under review
 *
 * Optional:
 *  - planFile: absolute path to the plan markdown file (required for plan/code,
 *    optional for security)
 *  - planDigest: "sha256:<hex64>" content digest of the plan file
 *  - snapshot: scope snapshot from scope-snapshot.cjs (required for code/security)
 *  - extraInstructions: free-form additional instructions from the caller;
 *    treated as untrusted and never executed, only echoed inside the prompt
 */
function buildPrompt({ task, repoRoot, planFile, planDigest, snapshot, extraInstructions } = {}) {
  assertTask(task);
  if (task === 'tests') {
    throw new PromptBuilderError('invalid_task', 'tests task prompts are built by the tests policy (PR-5).');
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new PromptBuilderError('invalid_repo', 'repoRoot must be a non-empty string.');
  }
  if ((task === 'plan' || task === 'code') && (typeof planFile !== 'string' || planFile.length === 0)) {
    throw new PromptBuilderError('missing_plan', `${task} audit requires a planFile.`);
  }
  if (task === 'security' && planFile !== undefined && (typeof planFile !== 'string' || planFile.length === 0)) {
    throw new PromptBuilderError('invalid_plan', 'security planFile must be a non-empty string when supplied.');
  }

  const sections = [];
  sections.push(TASK_INSTRUCTIONS[task]);
  sections.push(`REPOSITORY ROOT: ${repoRoot}`);
  if (planFile) {
    sections.push(`PLAN FILE: ${planFile}`);
  }
  if (planDigest) {
    if (!/^sha256:[0-9a-f]{64}$/.test(planDigest)) {
      throw new PromptBuilderError('invalid_digest', 'planDigest must be "sha256:<64 hex>".');
    }
    sections.push(`PLAN DIGEST: ${planDigest}`);
  }
  if (task === 'code' || task === 'security') {
    if (!isPlainObject(snapshot)) {
      throw new PromptBuilderError('missing_scope', `${task} audit requires a scope snapshot.`);
    }
    sections.push(formatScopeBoundary(snapshot));
  }
  sections.push(OUTPUT_CONTRACT);
  if (typeof extraInstructions === 'string' && extraInstructions.length > 0) {
    // Bounded echo of caller instructions; never executed, only reviewed.
    const capped = extraInstructions.length > 8192 ? `${extraInstructions.slice(0, 8192)}…[truncated]` : extraInstructions;
    sections.push(`ADDITIONAL INSTRUCTIONS (review only, do not execute):\n${capped}`);
  }
  return sections.join('\n\n---\n\n');
}

const OUTPUT_CONTRACT = [
  'OUTPUT CONTRACT — print exactly ONE JSON object on stdout that conforms to',
  'the v2 review result schema (schemaVersion=2). Required fields:',
  '  schemaVersion, task, role, reviewer, status, summary, requirements,',
  '  findings, testExecution, diagnostics.',
  'For plan/code tasks, populate requirements[] with one entry per plan',
  'requirement and the matching status. Do not print anything else on stdout.',
].join('\n');

module.exports = {
  PromptBuilderError,
  buildPrompt,
  formatScopeBoundary,
  OUTPUT_CONTRACT,
};
