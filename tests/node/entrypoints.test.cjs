'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { repoPath } = require('./helpers/paths.cjs');

const NODE_ENTRYPOINT = repoPath('bin', 'cross-harness-review.cjs');
const POWERSHELL_SHIM = repoPath('skills', 'cross-harness-review', 'scripts', 'invoke.ps1');
const POSIX_SHIM = repoPath('skills', 'cross-harness-review', 'scripts', 'invoke.sh');

function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: repoPath(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

test('Node CLI exposes deterministic help and version output', async () => {
  const help = await run(process.execPath, [NODE_ENTRYPOINT, '--help']);
  const version = await run(process.execPath, [NODE_ENTRYPOINT, '--version']);

  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /^Usage: cross-harness-review/m);
  assert.equal(version.exitCode, 0);
  assert.match(version.stdout, /^0\.2\.0-dev\r?\n$/);
});

test('PowerShell, POSIX, and direct Node entrypoints have equivalent help results', async (t) => {
  const direct = await run(process.execPath, [NODE_ENTRYPOINT, '--help']);
  const posixShell = resolvePosixShell();
  if (posixShell === null) {
    t.skip('Git Bash is unavailable for POSIX shim parity.');
    return;
  }
  const posix = await run(posixShell, [POSIX_SHIM, '--help']);

  assert.deepEqual(posix, direct);

  if (process.platform !== 'win32') {
    t.skip('PowerShell shim parity is Windows-specific.');
    return;
  }
  const powershell = await run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    POWERSHELL_SHIM,
    '--help',
  ]);
  assert.deepEqual(powershell, direct);
});

test('compatibility shims contain no config, discovery, or provider logic', () => {
  const source = `${fs.readFileSync(POWERSHELL_SHIM, 'utf8')}\n${fs.readFileSync(POSIX_SHIM, 'utf8')}`;
  assert.doesNotMatch(source, /CROSS_HARNESS|Get-Candidates|select_capability|Invoke-BoundedProcess/i);
  assert.doesNotMatch(source, /claude|codex|opencode|antigravity|cursor/i);
  assert.match(source, /cross-harness-review\.cjs/);
});

test('audit CLI exits non-zero when no reviewer is available (fail-closed)', async () => {
  // Force legacy-unconfigured with no legacy reviewers by zeroing PATH so
  // neither claude nor codex can be discovered. The audit must exit non-zero
  // rather than silently succeed.
  const child = spawn(
    process.execPath,
    [NODE_ENTRYPOINT, 'audit', 'plan', '--repo', repoPath(), '--plan-file', repoPath('README.md')],
    {
      cwd: repoPath(),
      env: { ...process.env, PATH: '', CROSS_HARNESS_CONFIG: repoPath('.tmp-no-such-config.json') },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve) => child.once('close', resolve));
  assert.notEqual(exitCode, 0, 'audit with no available reviewer must not exit 0');
});

test('audit CLI fails closed when tests policy has not been configured', async () => {
  const child = spawn(
    process.execPath,
    [NODE_ENTRYPOINT, 'audit', 'tests', '--repo', repoPath()],
    {
      cwd: repoPath(),
      env: { ...process.env, CROSS_HARNESS_CONFIG: repoPath('.tmp-no-tests-config.json') },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  const exitCode = await new Promise((resolve) => child.once('close', resolve));
  assert.notEqual(exitCode, 0);
  assert.match(Buffer.concat(stdout).toString('utf8'), /Configured user testsExecution policy is required/);
});

function resolvePosixShell() {
  if (process.platform !== 'win32') {
    return 'sh';
  }
  const gitBash = 'C:\\Program Files\\Git\\bin\\sh.exe';
  return fs.existsSync(gitBash) ? gitBash : null;
}
