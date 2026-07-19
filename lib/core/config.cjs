'use strict';

/**
 * PR-3: Unified user configuration core.
 *
 * This module is the single owner of three responsibilities the plan forbids
 * duplicating in PowerShell/Bash shims:
 *
 *  1. User config path resolution across Windows, POSIX and explicit override.
 *  2. JSON Schema v1 validation (a runtime copy of the contract subset the
 *     contract tests pin via tests/node/helpers/schema-loader.cjs).
 *  3. Atomic, mode-preserving, user-restricted writes with a `.bak` backup.
 *
 * Plan references (revised plan, section 6):
 *  - 6.2 path priority
 *  - 6.3 schema constraints (additionalProperties false, required roles,
 *    testsExecution boundaries)
 *  - 6.5 write + migration rules (createdAt immutable, updatedAt now(),
 *    temp file + atomic rename, .bak, fail-closed on unknown schemaVersion)
 *  - 2.4 / 6.6 legacy-unconfigured mode when no user config exists
 *
 * The module never reads or stores auto-discovered executable paths; those
 * are transient and stay inside the discover/setup process only.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const STABLE_HARNESS_IDS = ['claude', 'codex', 'opencode', 'antigravity', 'cursor'];
const ROLES = ['plan', 'code', 'tests'];
const SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|([+-]\d{2}:\d{2}))$/;

class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Path resolution (plan 6.2). Implemented once here; shims must not reimplement.
// ---------------------------------------------------------------------------

function pathLibFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isAbsolutePath(p, platform = process.platform) {
  if (typeof p !== 'string' || p.length === 0) {
    return false;
  }
  if (platform === 'win32') {
    // Drive-letter absolute (C:\), UNC (\\), and POSIX-style under Git Bash (/c/...).
    return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
  }
  return p.startsWith('/');
}

function resolveUserConfigPath({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const p = pathLibFor(platform);
  const explicit = env.CROSS_HARNESS_CONFIG;
  if (explicit !== undefined && explicit !== '') {
    if (!isAbsolutePath(explicit, platform)) {
      throw new ConfigError(
        'invalid_override',
        `CROSS_HARNESS_CONFIG must be an absolute path, got: ${explicit}`
      );
    }
    return { source: 'CROSS_HARNESS_CONFIG', path: explicit };
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;
    if (typeof localAppData === 'string' && localAppData.length > 0 && isAbsolutePath(localAppData, platform)) {
      return {
        source: 'LOCALAPPDATA',
        path: p.join(localAppData, 'cross-harness-review', 'config.json'),
      };
    }
    // Fallback for unusual Windows shells without LOCALAPPDATA: %USERPROFILE%\AppData\Local.
    const userProfile = env.USERPROFILE;
    if (typeof userProfile === 'string' && userProfile.length > 0) {
      return {
        source: 'USERPROFILE',
        path: p.join(userProfile, 'AppData', 'Local', 'cross-harness-review', 'config.json'),
      };
    }
    throw new ConfigError('no_home', 'Could not resolve a Windows user config directory (LOCALAPPDATA/USERPROFILE unset).');
  }

  // POSIX: XDG_CONFIG_HOME (must be absolute to count), then ~/.config fallback.
  const xdg = env.XDG_CONFIG_HOME;
  if (typeof xdg === 'string' && xdg.length > 0 && isAbsolutePath(xdg, platform)) {
    return {
      source: 'XDG_CONFIG_HOME',
      path: p.join(xdg, 'cross-harness-review', 'config.json'),
    };
  }
  return {
    source: 'home',
    path: p.join(home, '.config', 'cross-harness-review', 'config.json'),
  };
}

// ---------------------------------------------------------------------------
// Schema validation (plan 6.3). Runtime mirror of the contract schema. Kept
// minimal but strict enough to fail-closed on every drift field called out by
// the PR-1 contract tests.
// ---------------------------------------------------------------------------

function fail(code, message) {
  throw new ConfigError(code, message);
}

function validateIso8601(value, field) {
  if (typeof value !== 'string' || !ISO_8601_RE.test(value)) {
    fail('invalid_field', `${field} must be an ISO 8601 date-time string.`);
  }
}

function validateIntegerRange(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('invalid_field', `${field} must be an integer in [${min}, ${max}].`);
  }
}

function validateUserConfig(raw) {
  if (!isPlainObject(raw)) {
    fail('invalid_shape', 'User config must be a JSON object.');
  }

  // additionalProperties: false at the top level.
  const allowedTop = new Set(['schemaVersion', 'roles', 'testsExecution', 'createdAt', 'updatedAt']);
  for (const key of Object.keys(raw)) {
    if (!allowedTop.has(key)) {
      fail('unknown_field', `Unknown top-level field: ${key}.`);
    }
  }

  for (const required of ['schemaVersion', 'roles', 'testsExecution', 'createdAt', 'updatedAt']) {
    if (!Object.prototype.hasOwnProperty.call(raw, required)) {
      fail('missing_field', `Missing required field: ${required}.`);
    }
  }

  if (raw.schemaVersion !== SCHEMA_VERSION) {
    fail('unsupported_schema', `Unsupported schemaVersion ${raw.schemaVersion}; only ${SCHEMA_VERSION} is accepted.`);
  }

  // roles: exactly plan/code/tests, each a stable harness id.
  if (!isPlainObject(raw.roles)) {
    fail('invalid_field', 'roles must be an object.');
  }
  const allowedRoles = new Set(ROLES);
  for (const key of Object.keys(raw.roles)) {
    if (!allowedRoles.has(key)) {
      fail('unknown_field', `Unknown role: ${key}.`);
    }
  }
  for (const role of ROLES) {
    if (!Object.prototype.hasOwnProperty.call(raw.roles, role)) {
      fail('missing_field', `roles must include ${role}.`);
    }
    if (!STABLE_HARNESS_IDS.includes(raw.roles[role])) {
      fail('invalid_field', `roles.${role} must be a stable harness id.`);
    }
  }

  // testsExecution
  const te = raw.testsExecution;
  if (!isPlainObject(te)) {
    fail('invalid_field', 'testsExecution must be an object.');
  }
  const allowedTe = new Set(['enabled', 'mode', 'defaultTimeoutSeconds', 'maxOutputBytes']);
  for (const key of Object.keys(te)) {
    if (!allowedTe.has(key)) {
      fail('unknown_field', `Unknown testsExecution field: ${key}.`);
    }
  }
  for (const required of ['enabled', 'mode', 'defaultTimeoutSeconds', 'maxOutputBytes']) {
    if (!Object.prototype.hasOwnProperty.call(te, required)) {
      fail('missing_field', `testsExecution must include ${required}.`);
    }
  }
  if (typeof te.enabled !== 'boolean') {
    fail('invalid_field', 'testsExecution.enabled must be boolean.');
  }
  if (te.mode !== 'host-bounded') {
    fail('invalid_field', 'testsExecution.mode must be "host-bounded".');
  }
  validateIntegerRange(te.defaultTimeoutSeconds, 'testsExecution.defaultTimeoutSeconds', 1, 3600);
  validateIntegerRange(te.maxOutputBytes, 'testsExecution.maxOutputBytes', 65536, 16_777_216);

  validateIso8601(raw.createdAt, 'createdAt');
  validateIso8601(raw.updatedAt, 'updatedAt');
}

// ---------------------------------------------------------------------------
// Role-mapping state machine (plan 2.2). Enforces the 1/2/3 harness rule and
// is reused by setup and the role router.
// ---------------------------------------------------------------------------

/**
 * Classify a role mapping into the harness-count class and verify it satisfies
 * the plan 2.2 allocation rules. Returns { count, distinctHarnesses }.
 *
 *  - 1 harness: plan == code == tests (single reviewer carries all).
 *  - 2 harnesses: exactly one carries plan+code, the other carries tests.
 *  - 3 harnesses: every role is a different harness.
 *
 * Any other shape (e.g. plan==tests != code) is rejected.
 */
function classifyRoleMapping(roles) {
  const set = new Set(Object.values(roles));
  const count = set.size;

  if (count === 1) {
    return { count, distinctHarnesses: [...set] };
  }
  if (count === 2) {
    // 2-harness rule: the two-reviewer split must be {plan+code} vs {tests}.
    // i.e. plan === code, and tests is the lone one.
    if (roles.plan !== roles.code) {
      throw new ConfigError('invalid_allocation', 'With 2 harnesses, one must carry plan+code and the other tests.');
    }
    return { count, distinctHarnesses: [...set] };
  }
  if (count === 3) {
    if (!(roles.plan !== roles.code && roles.code !== roles.tests && roles.plan !== roles.tests)) {
      throw new ConfigError('invalid_allocation', 'With 3 harnesses, every role must map to a different harness.');
    }
    return { count, distinctHarnesses: [...set] };
  }
  throw new ConfigError('invalid_allocation', `Role mapping must use 1, 2, or 3 distinct harnesses (got ${count}).`);
}

// ---------------------------------------------------------------------------
// Project config (plan 6.4) — read from <repo>/.cross-harness-review.json.
// ---------------------------------------------------------------------------

function resolveProjectConfigPath(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new ConfigError('invalid_repo', 'repoRoot must be a non-empty string.');
  }
  return path.join(repoRoot, '.cross-harness-review.json');
}

function validateProjectConfig(raw) {
  if (!isPlainObject(raw)) {
    fail('invalid_shape', 'Project config must be a JSON object.');
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'schemaVersion' && key !== 'testsExecution') {
      fail('unknown_field', `Unknown project config field: ${key}.`);
    }
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    fail('unsupported_schema', `Unsupported project schemaVersion ${raw.schemaVersion}.`);
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'testsExecution')) {
    fail('missing_field', 'Project config missing testsExecution.');
  }
  const te = raw.testsExecution;
  if (!isPlainObject(te)) {
    fail('invalid_field', 'project testsExecution must be an object.');
  }
  const allowedTe = new Set(['commands', 'environmentAllowlist', 'artifacts']);
  for (const key of Object.keys(te)) {
    if (!allowedTe.has(key)) {
      fail('unknown_field', `Unknown project testsExecution field: ${key}.`);
    }
  }
  if (!Array.isArray(te.commands) || te.commands.length === 0) {
    fail('invalid_field', 'project testsExecution.commands must be a non-empty array.');
  }
  for (const cmd of te.commands) {
    validateProjectCommand(cmd);
  }
  if (te.environmentAllowlist !== undefined) {
    if (!Array.isArray(te.environmentAllowlist) || !te.environmentAllowlist.every((v) => typeof v === 'string' && v.length >= 1 && v.length <= 256)) {
      fail('invalid_field', 'environmentAllowlist must be an array of non-empty strings (<=256 chars).');
    }
  }
  if (te.artifacts !== undefined) {
    if (!Array.isArray(te.artifacts) || !te.artifacts.every((v) => typeof v === 'string' && v.length >= 1 && v.length <= 1024)) {
      fail('invalid_field', 'artifacts must be an array of non-empty strings (<=1024 chars).');
    }
  }
}

function validateProjectCommand(cmd) {
  if (!isPlainObject(cmd)) {
    fail('invalid_field', 'each command must be an object.');
  }
  const allowed = new Set(['id', 'argv', 'cwd', 'timeoutSeconds']);
  for (const key of Object.keys(cmd)) {
    if (!allowed.has(key)) {
      fail('unknown_field', `Unknown command field: ${key}.`);
    }
  }
  for (const required of ['id', 'argv', 'cwd']) {
    if (!Object.prototype.hasOwnProperty.call(cmd, required)) {
      fail('missing_field', `command missing ${required}.`);
    }
  }
  if (typeof cmd.id !== 'string' || cmd.id.length < 1 || cmd.id.length > 128) {
    fail('invalid_field', 'command.id must be 1..128 chars.');
  }
  if (!Array.isArray(cmd.argv) || cmd.argv.length === 0 || !cmd.argv.every((v) => typeof v === 'string' && v.length >= 1)) {
    fail('invalid_field', 'command.argv must be a non-empty array of non-empty strings.');
  }
  if (typeof cmd.cwd !== 'string' || cmd.cwd.length < 1 || cmd.cwd.length > 4096) {
    fail('invalid_field', 'command.cwd must be 1..4096 chars.');
  }
  if (cmd.timeoutSeconds !== undefined) {
    validateIntegerRange(cmd.timeoutSeconds, 'command.timeoutSeconds', 1, 3600);
  }
}

function loadProjectConfig(repoRoot, { fsImpl = fs } = {}) {
  const target = resolveProjectConfigPath(repoRoot);
  let rawText;
  try {
    rawText = fsImpl.readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw new ConfigError('read_failed', `Failed to read project config: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new ConfigError('invalid_json', `Project config is not valid JSON: ${error.message}`);
  }
  validateProjectConfig(parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// Read + write user config.
// ---------------------------------------------------------------------------

function loadUserConfig({ env = process.env, platform = process.platform, home = os.homedir(), fsImpl = fs } = {}) {
  const resolved = resolveUserConfigPath({ env, platform, home });
  let rawText;
  try {
    rawText = fsImpl.readFileSync(resolved.path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        configured: false,
        mode: 'legacy-unconfigured',
        config: null,
        path: resolved.path,
        pathSource: resolved.source,
      };
    }
    throw new ConfigError('read_failed', `Failed to read user config at ${resolved.path}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new ConfigError('invalid_json', `User config at ${resolved.path} is not valid JSON: ${error.message}`);
  }
  validateUserConfig(parsed);
  classifyRoleMapping(parsed.roles);
  return {
    configured: true,
    mode: 'configured',
    config: parsed,
    path: resolved.path,
    pathSource: resolved.source,
  };
}

function ensureParentDir(target, fsImpl) {
  const dir = path.dirname(target);
  fsImpl.mkdirSync(dir, { recursive: true });
}

function applyUserRestrictions(tempPath, home) {
  // Best-effort user-only permissions. Failure is non-fatal on Windows ACLs;
  // we still try chmod on POSIX and ignore errors where unsupported.
  if (process.platform === 'win32') {
    return;
  }
  try {
    fs.chmodSync(tempPath, 0o600);
  } catch {
    // File systems that do not support chmod still get the file; the parent
    // directory's umask governs.
  }
}

/**
 * Persist a new user config (plan 6.5):
 *  - temp file in same dir, fsync, atomic rename
 *  - .bak of the previous file
 *  - createdAt preserved from existing config (or set to now for first write)
 *  - updatedAt set to now
 *  - best-effort 0600 on POSIX
 */
function writeUserConfig(nextConfig, { env = process.env, platform = process.platform, home = os.homedir(), fsImpl = fs, now = nowIso } = {}) {
  if (!isPlainObject(nextConfig)) {
    throw new ConfigError('invalid_shape', 'nextConfig must be an object.');
  }
  const resolved = resolveUserConfigPath({ env, platform, home });

  // Preserve createdAt from an existing valid config if present.
  let createdAt = now();
  let previousRaw = null;
  try {
    previousRaw = fsImpl.readFileSync(resolved.path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new ConfigError('read_failed', `Cannot stage write: ${error.message}`);
    }
  }
  if (previousRaw !== null) {
    try {
      const previous = JSON.parse(previousRaw);
      if (isPlainObject(previous) && typeof previous.createdAt === 'string') {
        createdAt = previous.createdAt;
      }
    } catch {
      // A corrupt previous config: do not let its createdAt leak into the new
      // file. Leave createdAt at `now`.
    }
  }

  const draft = {
    schemaVersion: SCHEMA_VERSION,
    roles: { ...nextConfig.roles },
    testsExecution: { ...nextConfig.testsExecution },
    createdAt,
    updatedAt: now(),
  };
  validateUserConfig(draft);
  classifyRoleMapping(draft.roles);

  ensureParentDir(resolved.path, fsImpl);

  const serialized = JSON.stringify(draft, null, 2) + '\n';
  const tempPath = `${resolved.path}.tmp.${process.pid}.${Date.now()}`;
  // Write + fsync + rename.
  const handle = fsImpl.openSync(tempPath, 'w');
  try {
    fsImpl.writeSync(handle, serialized, 0, 'utf8');
    try {
      fsImpl.fsyncSync(handle);
    } catch {
      // fsync may be unavailable on some network/ram filesystems; the atomic
      // rename still guards against partial-content reads.
    }
  } finally {
    fsImpl.closeSync(handle);
  }
  applyUserRestrictions(tempPath, home);

  // Backup previous file (if any) before the rename clobbers it.
  if (previousRaw !== null) {
    try {
      fsImpl.copyFileSync(resolved.path, `${resolved.path}.bak`);
    } catch {
      // Backup is best-effort; the atomic rename still proceeds.
    }
  }

  try {
    fsImpl.renameSync(tempPath, resolved.path);
  } catch (error) {
    try {
      fsImpl.unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw new ConfigError('write_failed', `Atomic rename failed: ${error.message}`);
  }

  return { path: resolved.path, config: draft, pathSource: resolved.source };
}

function defaultUserConfig({ roles, testsExecutionEnabled = false, now = nowIso } = {}) {
  if (!isPlainObject(roles)) {
    throw new ConfigError('invalid_shape', 'roles must be an object.');
  }
  classifyRoleMapping(roles);
  return {
    schemaVersion: SCHEMA_VERSION,
    roles: { ...roles },
    testsExecution: {
      enabled: Boolean(testsExecutionEnabled),
      mode: 'host-bounded',
      defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    },
    createdAt: now(),
    updatedAt: now(),
  };
}

module.exports = {
  ConfigError,
  ROLES,
  STABLE_HARNESS_IDS,
  SCHEMA_VERSION,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_MAX_OUTPUT_BYTES,
  classifyRoleMapping,
  resolveUserConfigPath,
  resolveProjectConfigPath,
  validateUserConfig,
  validateProjectConfig,
  loadUserConfig,
  loadProjectConfig,
  writeUserConfig,
  defaultUserConfig,
};
