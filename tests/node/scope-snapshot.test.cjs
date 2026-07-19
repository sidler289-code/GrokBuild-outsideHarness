'use strict';

/**
 * PR-4 scope-snapshot tests.
 *
 * Pins lib/core/scope-snapshot.cjs against plan section 9.2 / 12:
 *  - selectors: uncommitted, base:<ref>, commit:<sha>, ref:<a>..<b>
 *  - repo-relative path normalization; reject absolute + ../ traversal
 *  - isFileInScope allowlist match (including prefix match for nested paths)
 *
 * Git is exercised through an injectable runImpl so the tests are offline and
 * deterministic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ScopeError,
  parseSelector,
  buildScopeSnapshot,
  isFileInScope,
  normalizePath,
} = require('../../lib/core/scope-snapshot.cjs');

function fakeGit(outputByArgs) {
  return (args) => {
    const key = args.join(' ');
    const match = outputByArgs[key];
    if (match === undefined) {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (typeof match === 'string') {
      return { status: 0, stdout: match, stderr: '' };
    }
    return match; // {status, stdout, stderr}
  };
}

// ---------------------------------------------------------------------------
// Selector parsing.
// ---------------------------------------------------------------------------

test('parseSelector accepts uncommitted', () => {
  assert.deepEqual(parseSelector('uncommitted'), { kind: 'uncommitted' });
});

test('parseSelector accepts base:<ref>', () => {
  assert.deepEqual(parseSelector('base:main'), { kind: 'base', ref: 'main' });
  assert.deepEqual(parseSelector('base:feature/x'), { kind: 'base', ref: 'feature/x' });
  assert.deepEqual(parseSelector('base:abc1234'), { kind: 'base', ref: 'abc1234' });
});

test('parseSelector rejects malicious base: ref characters', () => {
  assert.throws(
    () => parseSelector('base:main;rm -rf'),
    (err) => err instanceof ScopeError && err.code === 'invalid_selector'
  );
  assert.throws(
    () => parseSelector('base:$(whoami)'),
    (err) => err instanceof ScopeError && err.code === 'invalid_selector'
  );
});

test('parseSelector accepts commit:<sha> only with hex', () => {
  assert.deepEqual(parseSelector('commit:abc1234def5678'), { kind: 'commit', sha: 'abc1234def5678' });
  assert.throws(
    () => parseSelector('commit:not-a-sha'),
    (err) => err instanceof ScopeError && err.code === 'invalid_selector'
  );
});

test('parseSelector accepts ref:<a>..<b>', () => {
  assert.deepEqual(parseSelector('ref:main..dev'), { kind: 'ref', start: 'main', end: 'dev' });
});

test('parseSelector rejects unknown selector', () => {
  assert.throws(
    () => parseSelector('everything'),
    (err) => err instanceof ScopeError && err.code === 'invalid_selector'
  );
  assert.throws(
    () => parseSelector(''),
    (err) => err instanceof ScopeError && err.code === 'invalid_selector'
  );
});

// ---------------------------------------------------------------------------
// Path normalization.
// ---------------------------------------------------------------------------

test('normalizePath accepts repo-relative paths and converts backslashes', () => {
  assert.equal(normalizePath('', 'lib/core/x.cjs'), 'lib/core/x.cjs');
  assert.equal(normalizePath('', 'lib\\core\\x.cjs'), 'lib/core/x.cjs');
});

test('normalizePath rejects absolute and traversal', () => {
  assert.equal(normalizePath('', '/etc/passwd'), null);
  assert.equal(normalizePath('', '../secret'), null);
  assert.equal(normalizePath('', 'lib/../../secret'), null);
  assert.equal(normalizePath('', '..'), null);
});

test('normalizePath rejects empty and non-string', () => {
  assert.equal(normalizePath('', ''), null);
  assert.equal(normalizePath('', null), null);
  assert.equal(normalizePath('', 42), null);
});

// ---------------------------------------------------------------------------
// buildScopeSnapshot via injected git.
// ---------------------------------------------------------------------------

test('buildScopeSnapshot uncommitted merges tracked + staged + untracked', () => {
  const runImpl = fakeGit({
    'diff --name-only HEAD': 'lib/a.cjs\nlib/b.cjs\n',
    'diff --name-only --cached': 'lib/b.cjs\n', // already in tracked, dedupe
    'ls-files --others --exclude-standard': 'lib/new.cjs\n',
  });
  const snap = buildScopeSnapshot('uncommitted', '/repo', { runImpl });
  assert.equal(snap.kind, 'uncommitted');
  assert.deepEqual(snap.files, ['lib/a.cjs', 'lib/b.cjs', 'lib/new.cjs']);
});

test('buildScopeSnapshot base:<ref> uses three-dot merge-base diff', () => {
  const runImpl = fakeGit({
    'diff --name-only main...HEAD': 'lib/changed.cjs\n',
  });
  const snap = buildScopeSnapshot('base:main', '/repo', { runImpl });
  assert.deepEqual(snap.files, ['lib/changed.cjs']);
});

test('buildScopeSnapshot commit:<sha> uses git show', () => {
  const runImpl = fakeGit({
    'show --name-only --format= abc1234': 'lib/c1.cjs\nlib/c2.cjs\n',
  });
  const snap = buildScopeSnapshot('commit:abc1234', '/repo', { runImpl });
  assert.deepEqual(snap.files, ['lib/c1.cjs', 'lib/c2.cjs']);
});

test('buildScopeSnapshot ref:<a>..<b> uses git diff range', () => {
  const runImpl = fakeGit({
    'diff --name-only main..dev': 'lib/r.cjs\n',
  });
  const snap = buildScopeSnapshot('ref:main..dev', '/repo', { runImpl });
  assert.deepEqual(snap.files, ['lib/r.cjs']);
});

test('buildScopeSnapshot propagates git failure as ScopeError', () => {
  const runImpl = () => ({ status: 128, stdout: '', stderr: 'fatal: bad ref' });
  assert.throws(
    () => buildScopeSnapshot('uncommitted', '/repo', { runImpl }),
    (err) => err instanceof ScopeError && err.code === 'git_failed'
  );
});

test('buildScopeSnapshot strips traversal paths returned by git', () => {
  const runImpl = fakeGit({
    'diff --name-only HEAD': 'lib/ok.cjs\n../../etc/passwd\n',
    'diff --name-only --cached': '',
    'ls-files --others --exclude-standard': '',
  });
  const snap = buildScopeSnapshot('uncommitted', '/repo', { runImpl });
  assert.deepEqual(snap.files, ['lib/ok.cjs']);
});

// ---------------------------------------------------------------------------
// isFileInScope.
// ---------------------------------------------------------------------------

test('isFileInScope true when no snapshot (plan task has no scope)', () => {
  assert.equal(isFileInScope('any/file', { files: [] }), true);
  assert.equal(isFileInScope('any/file', {}), true);
});

test('isFileInScope matches exact + nested paths', () => {
  const snap = { files: ['lib/core', 'README.md'] };
  assert.equal(isFileInScope('lib/core/config.cjs', snap), true); // nested under allowlisted dir
  assert.equal(isFileInScope('README.md', snap), true);
  assert.equal(isFileInScope('lib/other.cjs', snap), false); // lib itself is not allowlisted, only lib/core
  assert.equal(isFileInScope('docs/x.md', snap), false);
});

test('isFileInScope rejects traversal in the evidence path', () => {
  const snap = { files: ['lib/core'] };
  assert.equal(isFileInScope('../etc/passwd', snap), false);
  assert.equal(isFileInScope('/etc/passwd', snap), false);
});
