'use strict';

/**
 * PR-4 prompt-builder tests.
 *
 * Pins lib/core/prompt-builder.cjs against plan section 9.1 / 9.2 / 12:
 *  - plan/code require a planFile; security makes it optional
 *  - code/security require a scope snapshot with the boundary text
 *  - prompt always carries the output contract
 *  - planDigest must be sha256:<hex64>
 *  - tests task is delegated to PR-5
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { PromptBuilderError, buildPrompt, formatScopeBoundary } = require('../../lib/core/prompt-builder.cjs');

const VALID_DIGEST = `sha256:${'a'.repeat(64)}`;

test('buildPrompt plan requires planFile', () => {
  assert.throws(
    () => buildPrompt({ task: 'plan', repoRoot: '/repo' }),
    (err) => err instanceof PromptBuilderError && err.code === 'missing_plan'
  );
});

test('buildPrompt plan includes plan file and output contract, no scope boundary', () => {
  const prompt = buildPrompt({ task: 'plan', repoRoot: '/repo', planFile: '/plan.md', planDigest: VALID_DIGEST });
  assert.match(prompt, /TASK: plan audit/);
  assert.match(prompt, /PLAN FILE: \/plan\.md/);
  assert.match(prompt, /PLAN DIGEST: sha256:a{64}/);
  assert.match(prompt, /OUTPUT CONTRACT/);
  assert.doesNotMatch(prompt, /SCOPE BOUNDARY/);
});

test('buildPrompt code requires both planFile and snapshot', () => {
  assert.throws(
    () => buildPrompt({ task: 'code', repoRoot: '/repo', planFile: '/plan.md' }),
    (err) => err instanceof PromptBuilderError && err.code === 'missing_scope'
  );
  assert.throws(
    () => buildPrompt({ task: 'code', repoRoot: '/repo' }),
    (err) => err instanceof PromptBuilderError && err.code === 'missing_plan'
  );
});

test('buildPrompt code includes scope boundary with allowlisted files', () => {
  const prompt = buildPrompt({
    task: 'code',
    repoRoot: '/repo',
    planFile: '/plan.md',
    snapshot: { files: ['lib/a.cjs', 'lib/b.cjs'] },
  });
  assert.match(prompt, /STRICT SCOPE BOUNDARY/);
  assert.match(prompt, /lib\/a\.cjs/);
  assert.match(prompt, /lib\/b\.cjs/);
  assert.match(prompt, /out_of_scope/);
});

test('buildPrompt security requires snapshot but not planFile', () => {
  const prompt = buildPrompt({
    task: 'security',
    repoRoot: '/repo',
    snapshot: { files: ['lib/a.cjs'] },
  });
  assert.match(prompt, /TASK: security audit/);
  assert.match(prompt, /STRICT SCOPE BOUNDARY/);
  // Optional planFile still allowed.
  const withPlan = buildPrompt({
    task: 'security',
    repoRoot: '/repo',
    planFile: '/plan.md',
    snapshot: { files: ['lib/a.cjs'] },
  });
  assert.match(withPlan, /PLAN FILE: \/plan\.md/);
});

test('buildPrompt rejects invalid planDigest', () => {
  assert.throws(
    () => buildPrompt({ task: 'plan', repoRoot: '/repo', planFile: '/p.md', planDigest: 'md5:abc' }),
    (err) => err instanceof PromptBuilderError && err.code === 'invalid_digest'
  );
});

test('buildPrompt refuses tests task', () => {
  assert.throws(
    () => buildPrompt({ task: 'tests', repoRoot: '/repo' }),
    (err) => err instanceof PromptBuilderError && err.code === 'invalid_task'
  );
});

test('buildPrompt rejects unknown task', () => {
  assert.throws(
    () => buildPrompt({ task: 'deploy', repoRoot: '/repo' }),
    (err) => err instanceof PromptBuilderError && err.code === 'invalid_task'
  );
});

test('buildPrompt echoes bounded extra instructions, never executes them', () => {
  const prompt = buildPrompt({
    task: 'plan',
    repoRoot: '/repo',
    planFile: '/p.md',
    extraInstructions: 'Focus on the config module.',
  });
  assert.match(prompt, /ADDITIONAL INSTRUCTIONS/);
  assert.match(prompt, /Focus on the config module\./);
});

test('buildPrompt truncates very long extra instructions', () => {
  const huge = 'x'.repeat(20000);
  const prompt = buildPrompt({ task: 'plan', repoRoot: '/repo', planFile: '/p.md', extraInstructions: huge });
  assert.match(prompt, /\[truncated\]/);
});

test('formatScopeBoundary describes no-restriction case', () => {
  const text = formatScopeBoundary({ files: [] });
  assert.match(text, /No file scope restriction was supplied/);
});
