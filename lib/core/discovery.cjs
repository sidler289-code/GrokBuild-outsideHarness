'use strict';

/**
 * PR-3: Harness candidate discovery and bounded version probe.
 *
 * Plan references (revised plan):
 *  - 2.3 supported harnesses and their binary names
 *  - 2.4 legacy-unconfigured behavior: claude/codex only, failure-closed
 *  - 7.2 discovery strategy (PATH, npm global bin, known dirs, overrides)
 *  - 7.3 capability model entry point (this module produces candidates; the
 *    adapter contract in PR-4/6/7 performs capability probing)
 *
 * This module is deliberately environment-side only. It never reads or writes
 * user config, never invents capability verdicts, and never executes harness
 * task payloads — it only runs bounded `--version` / help probes.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

// Plan 2.3: stable id -> { product, primary binary, secondary binaries }.
const HARNESS_REGISTRY = Object.freeze({
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    binaryNames: ['claude'],
    envOverride: 'CROSS_HARNESS_CLAUDE_BIN',
  },
  codex: {
    id: 'codex',
    displayName: 'OpenAI Codex CLI',
    binaryNames: ['codex'],
    envOverride: 'CROSS_HARNESS_CODEX_BIN',
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode CLI',
    binaryNames: ['opencode'],
    envOverride: 'CROSS_HARNESS_OPENCODE_BIN',
  },
  antigravity: {
    id: 'antigravity',
    displayName: 'Google Antigravity CLI',
    binaryNames: ['agy'],
    envOverride: 'CROSS_HARNESS_ANTIGRAVITY_BIN',
  },
  cursor: {
    id: 'cursor',
    displayName: 'Cursor CLI',
    // cursor-agent is primary; `agent` is the documented compatibility alias.
    binaryNames: ['cursor-agent', 'agent'],
    envOverride: 'CROSS_HARNESS_CURSOR_BIN',
  },
});

const LEGACY_REVIEWERS = ['claude', 'codex'];

class DiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DiscoveryError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isExecutableSync(target) {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      return true;
    }
    return (stat.mode & 0o111) !== 0;
  } catch (error) {
    return false;
  }
}

function which(name, searchDirs) {
  const hits = [];
  for (const dir of searchDirs) {
    if (typeof dir !== 'string' || dir.length === 0) {
      continue;
    }
    const direct = path.join(dir, name);
    if (isExecutableSync(direct)) {
      hits.push(direct);
    }
    if (process.platform === 'win32') {
      for (const ext of ['.exe', '.cmd', '.bat', '.ps1']) {
        const withExt = `${direct}${ext}`;
        if (isExecutableSync(withExt)) {
          hits.push(withExt);
        }
      }
    }
  }
  // De-duplicate while preserving order.
  return [...new Set(hits)];
}

function buildSearchDirs({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const dirs = [];
  const seen = new Set();
  function push(dir) {
    if (typeof dir === 'string' && dir.length > 0 && !seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  }

  // PATH first: the user's environment is the canonical source.
  const pathSep = platform === 'win32' ? ';' : ':';
  for (const dir of (env.PATH || '').split(pathSep)) {
    push(dir);
  }

  // npm global bin (best-effort). We shell out only to `npm config get prefix`
  // at probe time in callers; here we just add the well-known locations.
  if (platform === 'win32') {
    push(env.APPDATA ? path.join(env.APPDATA, 'npm') : null);
  } else {
    push('/usr/local/bin');
    push('/usr/bin');
    push(path.join(home, '.local', 'bin'));
    push(path.join(home, '.npm-global', 'bin'));
  }

  // Cursor's documented install locations.
  push(path.join(home, '.cursor', 'bin'));

  return dirs;
}

function resolveOverride(harnessId, env) {
  const entry = HARNESS_REGISTRY[harnessId];
  if (!entry) {
    return null;
  }
  const override = env[entry.envOverride];
  if (override === undefined || override === '') {
    return null;
  }
  return { source: 'override', envVar: entry.envOverride, value: override };
}

/**
 * Discover candidates for a single harness. Returns an array of candidates
 * (possibly empty), each tagged with its source. If an explicit override is
 * set and resolves to an executable, the result is exactly that one candidate
 * with source `override`. If the override is set but missing, we fail-closed
 * and return zero candidates (we do NOT fall back to PATH search).
 */
function discoverCandidates(harnessId, { env = process.env, platform = process.platform, home = os.homedir(), searchDirs } = {}) {
  const entry = HARNESS_REGISTRY[harnessId];
  if (!entry) {
    throw new DiscoveryError('unknown_harness', `Unknown harness id: ${harnessId}`);
  }

  const override = resolveOverride(harnessId, env);
  if (override) {
    if (isExecutableSync(override.value)) {
      return [
        {
          harnessId,
          binaryName: path.basename(override.value),
          path: override.value,
          source: 'override',
          override: override.envVar,
        },
      ];
    }
    // Fail-closed on a bad explicit override.
    return [];
  }

  const dirs = searchDirs || buildSearchDirs({ env, platform, home });
  const candidates = [];
  for (const binaryName of entry.binaryNames) {
    for (const found of which(binaryName, dirs)) {
      candidates.push({
        harnessId,
        binaryName,
        path: found,
        source: 'path',
      });
    }
  }
  // Deduplicate by path.
  const seen = new Set();
  return candidates.filter((c) => {
    if (seen.has(c.path)) {
      return false;
    }
    seen.add(c.path);
    return true;
  });
}

/**
 * Bounded `--version` probe. Runs the candidate with a single argv flag and a
 * short timeout. Never raises; returns a result object describing the probe.
 *
 * `runImpl` is injectable for tests; the default spawns the real binary.
 */
function probeVersion(candidate, { timeoutMs = 4_000, runImpl = defaultRun } = {}) {
  if (!isPlainObject(candidate) || typeof candidate.path !== 'string') {
    throw new DiscoveryError('invalid_candidate', 'candidate must be an object with a path.');
  }
  return runImpl(candidate, ['--version'], { timeoutMs });
}

function defaultRun(candidate, args, { timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    const stdoutChunks = [];
    const stderrChunks = [];

    function settle(result) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    }

    try {
      // On Windows, .cmd/.bat wrappers must be spawned with shell=true to be
      // found reliably. We limit the risk surface by passing argv as an array
      // and only enabling shell for the known wrapper extensions.
      const isWrapper =
        process.platform === 'win32' &&
        /\.(cmd|bat|ps1)$/i.test(candidate.path);
      child = spawn(candidate.path, args, {
        cwd: os.tmpdir(),
        env: { ...process.env },
        shell: isWrapper,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      settle({ exitCode: null, startError: error.message, stdout: '', stderr: '', timedOut: false });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutMs);
    timer.unref();

    child.on('error', (error) => {
      clearTimeout(timer);
      settle({ exitCode: null, startError: error.message, stdout: '', stderr: '', timedOut });
    });
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      settle({
        exitCode,
        startError: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
      });
    });
  });
}

/**
 * Parse a version string out of a probe result. Returns the first
 * semver-looking token found in stdout, falling back to stderr, or null if
 * nothing plausible is present.
 */
function parseVersion(result) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = text.match(/\b(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

/**
 * Convenience: discover + probe a single harness and return a summary suitable
 * for the `detect`/`doctor` commands. Does not produce capability verdicts —
 * those are the adapter contract's job in later PRs.
 */
async function detectHarness(harnessId, options = {}) {
  const candidates = discoverCandidates(harnessId, options);
  if (candidates.length === 0) {
    return {
      harnessId,
      available: false,
      reason: 'not_found',
      candidates: [],
      version: null,
      runtime: null,
    };
  }
  const candidate = candidates[0];
  const probe = await probeVersion(candidate, options);
  if (probe.startError) {
    return {
      harnessId,
      available: false,
      reason: 'spawn_failed',
      candidates,
      candidate,
      probe,
      version: null,
      runtime: null,
    };
  }
  if (probe.timedOut) {
    return {
      harnessId,
      available: false,
      reason: 'version_probe_timeout',
      candidates,
      candidate,
      probe,
      version: null,
      runtime: null,
    };
  }
  if (probe.exitCode !== 0 && !probe.stdout) {
    return {
      harnessId,
      available: false,
      reason: 'version_probe_failed',
      candidates,
      candidate,
      probe,
      version: null,
      runtime: null,
    };
  }
  return {
    harnessId,
    available: true,
    reason: null,
    candidates,
    candidate,
    probe,
    version: parseVersion(probe),
    runtime: process.execPath.startsWith('node') ? 'node' : null,
  };
}

/**
 * Legacy fan-out base (plan 2.4): when no user config exists, the only
 * harnesses eligible for routing are claude and codex, in that candidate order.
 * Returns the subset of detection summaries that are available.
 */
async function detectLegacyReviewers(options = {}) {
  const detected = [];
  for (const id of LEGACY_REVIEWERS) {
    const result = await detectHarness(id, options);
    detected.push(result);
  }
  return detected;
}

module.exports = {
  HARNESS_REGISTRY,
  LEGACY_REVIEWERS,
  DiscoveryError,
  buildSearchDirs,
  resolveOverride,
  discoverCandidates,
  probeVersion,
  parseVersion,
  detectHarness,
  detectLegacyReviewers,
};
