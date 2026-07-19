'use strict';

/**
 * PR-4: Git scope snapshot.
 *
 * Single owner of the 0.1.0 host scope gate (plan section 9.2, 12). Builds a
 * changed-file allowlist from a Git scope selector and normalizes paths so the
 * adapter prompt can state a hard boundary and the result normalizer can mark
 * out-of-scope findings.
 *
 * Scope selectors accepted (0.1.0 parity, plan section 5):
 *  - uncommitted            -> tracked + untracked working-tree changes
 *  - base:<branch|sha>      -> diff of HEAD against merge-base with ref
 *  - commit:<sha>           -> files changed in that commit
 *  - ref:<start>..<end>     -> files changed across a commit range
 *
 * This module only runs read-only `git` commands. It never writes to the
 * repository and never executes project-supplied commands.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

class ScopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScopeError';
    this.code = code;
  }
}

// Refs may not start with '-' so they cannot be confused with git options.
const REF_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._/\-]*$/;
const SHA_RE = /^[0-9a-f]{4,64}$/i;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function runGit(args, repoRoot, { env = process.env, runImpl } = {}) {
  const impl = runImpl || ((a, cwd) => {
    const result = spawnSync('git', a, {
      cwd: cwd,
      env,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status, error: result.error };
  });
  return impl(args, repoRoot);
}

function normalizePath(repoRoot, raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  // Git reports repo-relative paths. Reject absolute paths and any traversal
  // sequence so a hostile finding cannot claim a file outside the repo.
  if (path.isAbsolute(raw)) {
    return null;
  }
  // Normalize backslashes to forward slashes for cross-platform stability.
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') {
    return null;
  }
  return normalized;
}

function parseSelector(selector) {
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new ScopeError('invalid_selector', 'Scope selector must be a non-empty string.');
  }
  if (selector === 'uncommitted') {
    return { kind: 'uncommitted' };
  }
  if (selector.startsWith('base:')) {
    const ref = selector.slice('base:'.length).trim();
    if (!REF_NAME_RE.test(ref) && !SHA_RE.test(ref)) {
      throw new ScopeError('invalid_selector', `base: ref contains disallowed characters: ${ref}`);
    }
    return { kind: 'base', ref };
  }
  if (selector.startsWith('commit:')) {
    const sha = selector.slice('commit:'.length).trim();
    if (!SHA_RE.test(sha)) {
      throw new ScopeError('invalid_selector', `commit: must be a hex SHA, got: ${sha}`);
    }
    return { kind: 'commit', sha };
  }
  if (selector.startsWith('ref:')) {
    const body = selector.slice('ref:'.length);
    const parts = body.split('..');
    if (parts.length !== 2) {
      throw new ScopeError('invalid_selector', 'ref: must be of the form ref:<start>..<end>');
    }
    const [start, end] = parts.map((s) => s.trim());
    if (!REF_NAME_RE.test(start) || !REF_NAME_RE.test(end)) {
      throw new ScopeError('invalid_selector', `ref: range contains disallowed characters: ${body}`);
    }
    return { kind: 'ref', start, end };
  }
  throw new ScopeError('invalid_selector', `Unknown scope selector: ${selector}`);
}

function gitFilesFromDiff(args, repoRoot, options) {
  const result = runGit(args, repoRoot, options);
  if (result.error) {
    throw new ScopeError('git_failed', `git could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new ScopeError('git_failed', `git exited ${result.status}: ${result.stderr.trim() || '(no stderr)'}`);
  }
  const files = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const normalized = normalizePath(repoRoot, trimmed);
    if (normalized !== null) {
      files.push(normalized);
    }
  }
  return [...new Set(files)].sort();
}

/**
 * Build the scope snapshot. Returns { selector, kind, files, repoRoot }.
 * `files` is the repo-relative allowlist; the result normalizer uses it to
 * downgrade out-of-scope findings to verification:'out_of_scope'.
 */
function buildScopeSnapshot(selector, repoRoot, options = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new ScopeError('invalid_repo', 'repoRoot must be a non-empty string.');
  }
  const parsed = parseSelector(selector);

  switch (parsed.kind) {
    case 'uncommitted': {
      // Tracked changes (staged + unstaged) plus untracked files.
      const tracked = gitFilesFromDiff(['diff', '--name-only', 'HEAD'], repoRoot, options);
      const staged = gitFilesFromDiff(['diff', '--name-only', '--cached'], repoRoot, options);
      const untracked = gitFilesFromDiff(['ls-files', '--others', '--exclude-standard'], repoRoot, options);
      const files = [...new Set([...tracked, ...staged, ...untracked])].sort();
      return { selector, kind: parsed.kind, files, repoRoot };
    }
    case 'base': {
      // Three-dot diff against the merge-base: files changed on HEAD since the
      // ref diverged, regardless of where the ref itself has moved.
      const files = gitFilesFromDiff(['diff', '--name-only', `${parsed.ref}...HEAD`], repoRoot, options);
      return { selector, kind: parsed.kind, files, repoRoot };
    }
    case 'commit': {
      const files = gitFilesFromDiff(['show', '--name-only', '--format=', parsed.sha], repoRoot, options);
      return { selector, kind: parsed.kind, files, repoRoot };
    }
    case 'ref': {
      const files = gitFilesFromDiff(['diff', '--name-only', `${parsed.start}..${parsed.end}`], repoRoot, options);
      return { selector, kind: parsed.kind, files, repoRoot };
    }
    default:
      throw new ScopeError('invalid_selector', `Unreachable selector kind: ${parsed.kind}`);
  }
}

/**
 * Given a finding's evidence file path and a scope snapshot, return true iff
 * the file is inside the allowlist. Always returns true when the snapshot has
 * no files list (plan task, which has no scope gate).
 */
function isFileInScope(filePath, snapshot) {
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.files) || snapshot.files.length === 0) {
    return true;
  }
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return false;
  }
  const normalized = normalizePath('', filePath);
  if (normalized === null) {
    return false;
  }
  const set = new Set(snapshot.files);
  if (set.has(normalized)) {
    return true;
  }
  // A finding may point at a path nested under an allowlisted directory.
  for (const allowed of snapshot.files) {
    if (normalized === allowed || normalized.startsWith(`${allowed}/`)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  ScopeError,
  parseSelector,
  buildScopeSnapshot,
  isFileInScope,
  normalizePath,
};
