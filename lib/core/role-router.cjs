'use strict';

/**
 * PR-3: Role routing state machine.
 *
 * Single owner (plan 4.1) of:
 *  - configured mode: read roles from a validated user config and apply the
 *    capability gate per role (plan 7.3).
 *  - legacy-unconfigured mode (plan 2.4): no user config -> fan out to the
 *    available Claude/Codex reviewers exactly like 0.1.0, never implicitly
 *    calling opencode/antigravity/cursor.
 *
 * The router does not execute harnesses. It returns the set of (role,
 * reviewer) calls the audit layer (PR-4+) should make, plus the public
 * `roles --json` shape described in plan 2.4.
 */

const { ROLES } = require('./config.cjs');
const { detectLegacyReviewers, LEGACY_REVIEWERS } = require('./discovery.cjs');

const ROLE_CAPABILITY_REQUIREMENTS = Object.freeze({
  // Plan 7.3 capability model.
  plan: ['repoRead', 'structuredOutput', 'writeRestriction'],
  code: ['repoRead', 'structuredOutput', 'writeRestriction'], // file-evidence scope gate is applied at audit time.
  tests: ['structuredToolEvents', 'approvedCommandRestriction', 'directTestExecution'],
});

class RoleRouterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoleRouterError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Given a capabilities map { harnessId -> { capability: 'verified'|'failed'|'unknown' } }
 * and a role, return true iff every required capability for that role is
 * 'verified'. `unknown` and `failed` both fail-closed (plan 7.3).
 */
function harnessPassesRoleGate(capabilities, harnessId, role) {
  const required = ROLE_CAPABILITY_REQUIREMENTS[role];
  if (!required) {
    throw new RoleRouterError('unknown_role', `Unknown role: ${role}`);
  }
  const caps = isPlainObject(capabilities) ? capabilities[harnessId] : null;
  if (!isPlainObject(caps)) {
    return false;
  }
  return required.every((capability) => caps[capability] === 'verified');
}

/**
 * Verify that an explicit role mapping is internally consistent AND that
 * every mapped harness passes the corresponding role gate. Throws on any
 * mismatch.
 */
function assertRoleMappingPassesGates(roles, capabilities) {
  for (const role of ROLES) {
    const harnessId = roles[role];
    if (!harnessPassesRoleGate(capabilities, harnessId, role)) {
      throw new RoleRouterError(
        'capability_mismatch',
        `Harness "${harnessId}" does not pass the capability gate for role "${role}".`
      );
    }
  }
}

/**
 * Configured-mode routing (plan 2.4): roles come from user config. With a
 * single configured reviewer we still call it once per role (the audit layer
 * decides session isolation). Returns a deterministic ordered list of
 * (role, reviewer) tuples.
 */
function routeConfigured(roles, capabilities) {
  assertRoleMappingPassesGates(roles, capabilities);
  // Deterministic order: plan, code, tests. `security` follows `code` per
  // plan 2.1 and is appended by the audit layer, not stored in config.
  return [
    { role: 'plan', reviewer: roles.plan },
    { role: 'code', reviewer: roles.code },
    { role: 'tests', reviewer: roles.tests },
  ];
}

/**
 * Build the public `roles --json` payload (plan 2.4) for the configured case.
 */
function configuredRolesReport({ roles, capabilities, pathSource, configPath }) {
  return {
    configured: true,
    mode: 'configured',
    roles,
    selectedHarnesses: [...new Set(Object.values(roles))],
    capabilities,
    configPath: configPath ?? null,
    pathSource: pathSource ?? null,
  };
}

/**
 * Build the public `roles --json` payload for the legacy-unconfigured case.
 * Plan 2.4: configured:false, mode:'legacy-unconfigured', current legacy
 * reviewers listed, roles:null (we do NOT fabricate a persistent role map).
 *
 * `legacyReviewers` is the list of detection summaries for claude/codex.
 */
function legacyRolesReport({ legacyReviewers }) {
  const available = legacyReviewers
    .filter((entry) => entry.available)
    .map((entry) => ({ harnessId: entry.harnessId, version: entry.version, path: entry.candidate ? entry.candidate.path : null }));
  return {
    configured: false,
    mode: 'legacy-unconfigured',
    legacyReviewers: available,
    roles: null,
  };
}

/**
 * Plan 2.4 legacy fan-out: with no user config, plan/code/tests/security all
 * fan out to the available Claude+Codex reviewers. The single-reviewer
 * degradation rule is preserved: if only one is available, we still call it
 * and the audit layer reports the degradation.
 *
 * Returns { reviewers, unavailable } where reviewers is a non-empty array of
 * { harnessId, version, path } and unavailable is the list of missing legacy
 * harnesses. If both are unavailable, reviewers is empty (the audit layer
 * turns this into `unavailable`).
 */
function routeLegacy({ legacyReviewers }) {
  const reviewers = legacyReviewers
    .filter((entry) => entry.available)
    .map((entry) => ({
      harnessId: entry.harnessId,
      version: entry.version,
      path: entry.candidate ? entry.candidate.path : null,
    }));
  const unavailable = legacyReviewers
    .filter((entry) => !entry.available)
    .map((entry) => entry.harnessId);
  return { reviewers, unavailable };
}

/**
 * Public entrypoint for the `roles` command. Reads user config (already
 * validated), detects, and returns the appropriate report. Capabilities are
 * supplied by the caller; in PR-3 they default to all-verified for the
 * configured case so the router is testable without adapters. Real capability
 * probing arrives with PR-4/6/7.
 *
 * Options:
 *  - userConfig: result of loadUserConfig (configured/legacy-unconfigured).
 *  - capabilities: optional map; defaults to permissive for legacy callers
 *    but must be explicit (and pass) for configured mode.
 *  - detectImpl: injectable legacy detector for tests.
 */
async function computeRolesReport({ userConfig, capabilities = null, detectImpl = detectLegacyReviewers } = {}) {
  if (!isPlainObject(userConfig)) {
    throw new RoleRouterError('invalid_input', 'userConfig is required.');
  }

  if (!userConfig.configured) {
    const legacyReviewers = await detectImpl();
    return legacyRolesReport({ legacyReviewers });
  }

  const caps = capabilities;
  if (!isPlainObject(caps)) {
    throw new RoleRouterError(
      'capability_mismatch',
      'Configured mode requires a capabilities map for every selected harness.'
    );
  }
  // Validate that every selected harness has a full capability entry.
  const selected = new Set(Object.values(userConfig.config.roles));
  for (const id of selected) {
    if (!isPlainObject(caps[id])) {
      throw new RoleRouterError('capability_mismatch', `Missing capabilities for harness "${id}".`);
    }
  }
  assertRoleMappingPassesGates(userConfig.config.roles, caps);
  return configuredRolesReport({
    roles: userConfig.config.roles,
    capabilities: caps,
    pathSource: userConfig.pathSource,
    configPath: userConfig.path,
  });
}

module.exports = {
  ROLE_CAPABILITY_REQUIREMENTS,
  RoleRouterError,
  harnessPassesRoleGate,
  assertRoleMappingPassesGates,
  routeConfigured,
  routeLegacy,
  configuredRolesReport,
  legacyRolesReport,
  computeRolesReport,
};
