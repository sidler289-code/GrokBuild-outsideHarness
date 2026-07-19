'use strict';

/**
 * PR-3 discovery tests.
 *
 * Pins lib/core/discovery.cjs against the plan (revised plan, sections 2.3,
 * 2.4, 7.2): stable harness registry, PATH-based candidate discovery, explicit
 * override fail-closed, bounded version probe parsing, and the legacy
 * claude+codex reviewer list.
 *
 * Real harness probes are not exercised here; we inject a fake `runImpl` so
 * the test matrix is deterministic and offline.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  HARNESS_REGISTRY,
  LEGACY_REVIEWERS,
  DiscoveryError,
  buildSearchDirs,
  resolveOverride,
  discoverCandidates,
  parseVersion,
  probeVersion,
  detectHarness,
  detectLegacyReviewers,
} = require('../../lib/core/discovery.cjs');

// ---------------------------------------------------------------------------
// Helpers: build a fake bin directory that discovery can walk.
// ---------------------------------------------------------------------------

function makeBinDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-disc-'));
  return dir;
}

function writeFakeBin(dir, name) {
  const target = path.join(dir, name);
  // POSIX-style executable that prints a version line. On Windows, discovery
  // looks for the bare name plus .exe/.cmd/.bat/.ps1 extensions.
  if (process.platform === 'win32') {
    fs.writeFileSync(`${target}.cmd`, '@echo off\necho fake-tool 1.2.3\n');
  } else {
    fs.writeFileSync(target, '#!/bin/sh\necho "fake-tool 1.2.3"\n');
    fs.chmodSync(target, 0o755);
  }
  return target;
}

function writeBrokenBin(dir, name) {
  const target = path.join(dir, name);
  if (process.platform === 'win32') {
    fs.writeFileSync(`${target}.cmd`, '@echo off\nexit /b 3\n');
  } else {
    // A binary that exits non-zero without printing anything.
    fs.writeFileSync(target, '#!/bin/sh\nexit 3\n');
    fs.chmodSync(target, 0o755);
  }
  return target;
}

// ---------------------------------------------------------------------------
// 2.3 Harness registry.
// ---------------------------------------------------------------------------

test('2.3: registry exposes exactly the five stable harness ids', () => {
  assert.deepEqual(Object.keys(HARNESS_REGISTRY).sort(), ['antigravity', 'claude', 'codex', 'cursor', 'opencode']);
});

test('2.3: cursor registry records cursor-agent primary and agent alias', () => {
  assert.deepEqual(HARNESS_REGISTRY.cursor.binaryNames, ['cursor-agent', 'agent']);
});

test('2.3: antigravity binary is agy', () => {
  assert.deepEqual(HARNESS_REGISTRY.antigravity.binaryNames, ['agy']);
});

test('2.3: each registry entry has an env override name', () => {
  for (const entry of Object.values(HARNESS_REGISTRY)) {
    assert.equal(typeof entry.envOverride, 'string');
    assert.match(entry.envOverride, /^CROSS_HARNESS_/);
  }
});

test('2.4: LEGACY_REVIEWERS is exactly claude then codex', () => {
  assert.deepEqual(LEGACY_REVIEWERS, ['claude', 'codex']);
});

// ---------------------------------------------------------------------------
// 7.2 Search dir construction.
// ---------------------------------------------------------------------------

test('7.2: buildSearchDirs includes PATH entries and known dirs', () => {
  const dirs = buildSearchDirs({ env: { PATH: '/usr/local/bin:/usr/bin' }, platform: 'linux', home: '/home/u' });
  assert.ok(dirs.includes('/usr/local/bin'));
  assert.ok(dirs.includes('/usr/bin'));
  assert.ok(dirs.includes(path.join('/home/u', '.local', 'bin')));
  assert.ok(dirs.includes(path.join('/home/u', '.cursor', 'bin')));
});

test('7.2: buildSearchDirs splits Windows PATH on semicolons', () => {
  const dirs = buildSearchDirs({ env: { PATH: 'C:\\a;C:\\b', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32', home: 'C:\\Users\\u' });
  assert.ok(dirs.includes('C:\\a'));
  assert.ok(dirs.includes('C:\\b'));
});

// ---------------------------------------------------------------------------
// Candidate discovery.
// ---------------------------------------------------------------------------

test('discoverCandidates finds a binary in a search dir', () => {
  const dir = makeBinDir('found');
  try {
    writeFakeBin(dir, 'claude');
    const candidates = discoverCandidates('claude', {
      env: {},
      platform: process.platform,
      home: os.homedir(),
      searchDirs: [dir],
    });
    assert.ok(candidates.length >= 1, 'expected at least one candidate');
    assert.equal(candidates[0].harnessId, 'claude');
    assert.equal(candidates[0].source, 'path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverCandidates returns empty when nothing is on PATH', () => {
  const candidates = discoverCandidates('claude', {
    env: {},
    platform: 'linux',
    home: '/nonexistent-home',
    searchDirs: ['/definitely/not/here'],
  });
  assert.equal(candidates.length, 0);
});

test('discoverCandidates uses override and fails closed when override missing', () => {
  const dir = makeBinDir('ovr');
  try {
    const binPath = writeFakeBin(dir, 'claude');
    const real = process.platform === 'win32' ? `${binPath}.cmd` : binPath;
    const ok = discoverCandidates('claude', {
      env: { CROSS_HARNESS_CLAUDE_BIN: real },
      platform: process.platform,
      home: os.homedir(),
      searchDirs: [], // PATH search disabled; override must still work.
    });
    assert.equal(ok.length, 1);
    assert.equal(ok[0].source, 'override');
    assert.equal(ok[0].override, 'CROSS_HARNESS_CLAUDE_BIN');

    // Missing override must NOT fall back to PATH search.
    const missing = discoverCandidates('claude', {
      env: { CROSS_HARNESS_CLAUDE_BIN: path.join(dir, 'does-not-exist') },
      platform: process.platform,
      home: os.homedir(),
      searchDirs: [dir],
    });
    assert.equal(missing.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverCandidates rejects unknown harness id', () => {
  assert.throws(
    () => discoverCandidates('gemini', { env: {}, platform: 'linux', home: '/h', searchDirs: [] }),
    (err) => err instanceof DiscoveryError && err.code === 'unknown_harness'
  );
});

test('resolveOverride returns null when env var unset', () => {
  assert.equal(resolveOverride('claude', {}), null);
  assert.equal(resolveOverride('claude', { CROSS_HARNESS_CLAUDE_BIN: '' }), null);
});

// ---------------------------------------------------------------------------
// Version probe (with injected runner so tests are offline + deterministic).
// ---------------------------------------------------------------------------

test('parseVersion extracts semver from stdout', () => {
  assert.equal(parseVersion({ stdout: 'claude 1.4.2\n', stderr: '' }), '1.4.2');
  assert.equal(parseVersion({ stdout: '', stderr: 'codex 0.144.5\n' }), '0.144.5');
  assert.equal(parseVersion({ stdout: 'no version here', stderr: '' }), null);
});

test('probeVersion delegates to runImpl and returns its result', async () => {
  const candidate = { harnessId: 'claude', binaryName: 'claude', path: '/x/claude', source: 'path' };
  const fakeRun = async (c, args) => ({
    exitCode: 0,
    startError: null,
    stdout: `claude 9.9.9\n`,
    stderr: '',
    timedOut: false,
    calledWith: { candidate: c, args },
  });
  const result = await probeVersion(candidate, { runImpl: fakeRun });
  assert.equal(result.exitCode, 0);
  assert.equal(result.calledWith.args[0], '--version');
});

test('detectHarness reports not_found when no candidates', async () => {
  const result = await detectHarness('claude', {
    env: {},
    platform: 'linux',
    home: '/nonexistent',
    searchDirs: ['/nope'],
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'not_found');
});

test('detectHarness reports available when probe prints a version', async () => {
  // Inject the runImpl via the detectHarness options: we monkey-patch by
  // pointing searchDirs at a fake bin we wrote.
  const dir = makeBinDir('avail');
  try {
    writeFakeBin(dir, 'codex');
    const result = await detectHarness('codex', {
      env: {},
      platform: process.platform,
      home: os.homedir(),
      searchDirs: [dir],
      timeoutMs: 4_000,
    });
    assert.equal(result.available, true);
    assert.equal(result.reason, null);
    assert.match(result.version, /\d+\.\d+/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectHarness reports spawn_failed / version_probe_failed on bad binaries', async () => {
  const dir = makeBinDir('bad');
  try {
    writeBrokenBin(dir, 'codex');
    const result = await detectHarness('codex', {
      env: {},
      platform: process.platform,
      home: os.homedir(),
      searchDirs: [dir],
      timeoutMs: 4_000,
    });
    // A binary that exits non-zero without output is unavailable.
    assert.equal(result.available, false);
    assert.ok(['version_probe_failed', 'spawn_failed'].includes(result.reason), `got ${result.reason}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2.4 Legacy reviewers list.
// ---------------------------------------------------------------------------

test('2.4: detectLegacyReviewers probes claude then codex', async () => {
  let probed = [];
  const fakeDetect = async (id, opts) => {
    probed.push(id);
    return { harnessId: id, available: id === 'codex', reason: id === 'codex' ? null : 'not_found', version: id === 'codex' ? '0.1.0' : null, candidate: id === 'codex' ? { path: '/x/codex' } : null };
  };
  // detectLegacyReviewers uses detectHarness internally; override via re-mock.
  // We cannot inject into detectLegacyReviewers directly, so we test the order
  // is preserved by reading LEGACY_REVIEWERS above. Here we instead run the
  // real function against an empty PATH to confirm it returns both entries.
  const results = await detectLegacyReviewers({
    env: {},
    platform: 'linux',
    home: '/nonexistent',
    searchDirs: ['/nope'],
    timeoutMs: 250,
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].harnessId, 'claude');
  assert.equal(results[1].harnessId, 'codex');
  for (const r of results) {
    assert.equal(r.available, false);
    assert.equal(r.reason, 'not_found');
  }
});
