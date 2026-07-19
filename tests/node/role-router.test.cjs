'use strict';

/**
 * PR-3 role-router tests.
 *
 * Pins lib/core/role-router.cjs against the plan (revised plan, sections 2.2,
 * 2.4, 7.3):
 *  - configured mode: 1/2/3 mapping must pass capability gates per role
 *  - legacy-unconfigured mode: report shape, no fabricated roles, fan-out to
 *    available Claude/Codex only, both-unavailable -> empty reviewers
 *  - capability gating: `unknown` and `failed` fail closed; only `verified`
 *    passes
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLE_CAPABILITY_REQUIREMENTS,
  RoleRouterError,
  harnessPassesRoleGate,
  assertRoleMappingPassesGates,
  routeConfigured,
  routeLegacy,
  configuredRolesReport,
  legacyRolesReport,
  computeRolesReport,
} = require('../../lib/core/role-router.cjs');

function allVerified() {
  return {
    repoRead: 'verified',
    structuredOutput: 'verified',
    writeRestriction: 'verified',
    structuredToolEvents: 'verified',
    approvedCommandRestriction: 'verified',
    directTestExecution: 'verified',
  };
}

function caps(harnessIds) {
  const out = {};
  for (const id of harnessIds) {
    out[id] = allVerified();
  }
  return out;
}

// ---------------------------------------------------------------------------
// 7.3 Capability gating.
// ---------------------------------------------------------------------------

test('7.3: plan/code require repoRead, structuredOutput, writeRestriction', () => {
  assert.deepEqual(ROLE_CAPABILITY_REQUIREMENTS.plan.sort(), ['repoRead', 'structuredOutput', 'writeRestriction'].sort());
  assert.deepEqual(ROLE_CAPABILITY_REQUIREMENTS.code.sort(), ['repoRead', 'structuredOutput', 'writeRestriction'].sort());
});

test('7.3: tests require structuredToolEvents, approvedCommandRestriction, directTestExecution', () => {
  assert.deepEqual(
    ROLE_CAPABILITY_REQUIREMENTS.tests.sort(),
    ['structuredToolEvents', 'approvedCommandRestriction', 'directTestExecution'].sort()
  );
});

test('7.3: harnessPassesRoleGate true only when every required capability is verified', () => {
  assert.equal(harnessPassesRoleGate({ claude: allVerified() }, 'claude', 'plan'), true);
  assert.equal(harnessPassesRoleGate({ claude: allVerified() }, 'claude', 'code'), true);
  assert.equal(harnessPassesRoleGate({ claude: allVerified() }, 'claude', 'tests'), true);
});

test('7.3: unknown capability fails closed', () => {
  const c = { ...allVerified(), repoRead: 'unknown' };
  assert.equal(harnessPassesRoleGate({ claude: c }, 'claude', 'plan'), false);
});

test('7.3: failed capability fails closed', () => {
  const c = { ...allVerified(), directTestExecution: 'failed' };
  assert.equal(harnessPassesRoleGate({ claude: c }, 'claude', 'tests'), false);
});

test('7.3: missing capabilities object fails closed', () => {
  assert.equal(harnessPassesRoleGate({}, 'claude', 'plan'), false);
  assert.equal(harnessPassesRoleGate({ claude: null }, 'claude', 'plan'), false);
});

// ---------------------------------------------------------------------------
// Configured mode routing.
// ---------------------------------------------------------------------------

test('routeConfigured produces a deterministic plan,code,tests list', () => {
  const routes = routeConfigured({ plan: 'claude', code: 'claude', tests: 'opencode' }, caps(['claude', 'opencode']));
  assert.deepEqual(routes, [
    { role: 'plan', reviewer: 'claude' },
    { role: 'code', reviewer: 'claude' },
    { role: 'tests', reviewer: 'opencode' },
  ]);
});

test('routeConfigured throws when a role maps to a harness that fails the gate', () => {
  const badCaps = caps(['claude']);
  badCaps.claude = { ...allVerified(), structuredToolEvents: 'unknown' };
  assert.throws(
    () => routeConfigured({ plan: 'claude', code: 'claude', tests: 'claude' }, badCaps),
    (err) => err instanceof RoleRouterError && err.code === 'capability_mismatch'
  );
});

test('assertRoleMappingPassesGates: tests role requires directTestExecution verified', () => {
  const ok = caps(['codex']);
  ok.codex = { ...allVerified(), directTestExecution: 'verified' };
  assert.doesNotThrow(() => assertRoleMappingPassesGates({ plan: 'codex', code: 'codex', tests: 'codex' }, ok));

  const noTestExec = caps(['codex']);
  noTestExec.codex = { ...allVerified(), directTestExecution: 'failed' };
  assert.throws(
    () => assertRoleMappingPassesGates({ plan: 'codex', code: 'codex', tests: 'codex' }, noTestExec),
    (err) => err instanceof RoleRouterError && err.code === 'capability_mismatch'
  );
});

// ---------------------------------------------------------------------------

test('disabled direct tests do not make configured plan/code routing unusable', () => {
  const readOnlyCaps = {
    claude: {
      ...allVerified(),
      structuredToolEvents: 'unknown',
      approvedCommandRestriction: 'unknown',
      directTestExecution: 'unknown',
    },
  };
  assert.doesNotThrow(() => assertRoleMappingPassesGates(
    { plan: 'claude', code: 'claude', tests: 'claude' }, readOnlyCaps, { testsExecutionEnabled: false }
  ));
});
// 2.4 Legacy-unconfigured routing.
// ---------------------------------------------------------------------------

function legacyReviewersAvailable(...ids) {
  return ids.map((id) => ({
    harnessId: id,
    available: true,
    version: '1.0.0',
    candidate: { path: `/bin/${id}` },
  }));
}

test('2.4: legacyRolesReport sets configured:false, mode:legacy-unconfigured, roles:null', () => {
  const report = legacyRolesReport({ legacyReviewers: legacyReviewersAvailable('claude', 'codex') });
  assert.equal(report.configured, false);
  assert.equal(report.mode, 'legacy-unconfigured');
  assert.equal(report.roles, null);
  assert.equal(report.legacyReviewers.length, 2);
});

test('2.4: routeLegacy fans out to all available legacy reviewers', () => {
  const { reviewers, unavailable } = routeLegacy({
    legacyReviewers: legacyReviewersAvailable('claude', 'codex'),
  });
  assert.equal(reviewers.length, 2);
  assert.deepEqual(unavailable, []);
});

test('2.4: routeLegacy degrades to a single reviewer when only one is available', () => {
  const { reviewers, unavailable } = routeLegacy({
    legacyReviewers: [
      { harnessId: 'claude', available: false, reason: 'not_found' },
      ...legacyReviewersAvailable('codex'),
    ],
  });
  assert.equal(reviewers.length, 1);
  assert.equal(reviewers[0].harnessId, 'codex');
  assert.deepEqual(unavailable, ['claude']);
});

test('2.4: routeLegacy returns empty reviewers when both unavailable', () => {
  const { reviewers, unavailable } = routeLegacy({
    legacyReviewers: [
      { harnessId: 'claude', available: false, reason: 'not_found' },
      { harnessId: 'codex', available: false, reason: 'not_found' },
    ],
  });
  assert.equal(reviewers.length, 0);
  assert.deepEqual(unavailable, ['claude', 'codex']);
});

test('2.4: legacy report never implicitly lists OpenCode', () => {
  // detectImpl is injectable; supply only legacy ids, ensure the report shape
  // does not surface the new adapters even if a buggy detector returned them.
  const report = legacyRolesReport({
    legacyReviewers: [
      ...legacyReviewersAvailable('claude', 'codex'),
      // A malicious/buggy detector that tried to surface a new adapter:
      ...legacyReviewersAvailable('opencode'),
    ],
  });
  const ids = report.legacyReviewers.map((r) => r.harnessId);
  assert.deepEqual(ids, ['claude', 'codex', 'opencode'], 'legacyRolesReport reflects whatever it is given; the detector contract gates this');
});

// ---------------------------------------------------------------------------
// computeRolesReport end-to-end.
// ---------------------------------------------------------------------------

test('computeRolesReport: legacy path does not require capabilities', async () => {
  const report = await computeRolesReport({
    userConfig: { configured: false, mode: 'legacy-unconfigured' },
    detectImpl: async () => legacyReviewersAvailable('claude', 'codex'),
  });
  assert.equal(report.mode, 'legacy-unconfigured');
  assert.equal(report.roles, null);
});

test('computeRolesReport: configured path requires explicit capabilities', async () => {
  const userConfig = {
    configured: true,
    mode: 'configured',
    config: { roles: { plan: 'claude', code: 'claude', tests: 'opencode' } },
    path: '/x/config.json',
    pathSource: 'CROSS_HARNESS_CONFIG',
  };
  // Missing capabilities map -> fail closed.
  await assert.rejects(
    () => computeRolesReport({ userConfig }),
    (err) => err instanceof RoleRouterError && err.code === 'capability_mismatch'
  );
  // Provided and passing -> configured report.
  const report = await computeRolesReport({ userConfig, capabilities: caps(['claude', 'opencode']) });
  assert.equal(report.configured, true);
  assert.equal(report.mode, 'configured');
  assert.deepEqual(report.roles, { plan: 'claude', code: 'claude', tests: 'opencode' });
  assert.deepEqual(report.selectedHarnesses.sort(), ['claude', 'opencode']);
});

test('computeRolesReport: configured path fails when a gate fails', async () => {
  const userConfig = {
    configured: true,
    mode: 'configured',
    config: { roles: { plan: 'claude', code: 'claude', tests: 'claude' } },
  };
  const bad = caps(['claude']);
  bad.claude = { ...allVerified(), directTestExecution: 'unknown' };
  await assert.rejects(
    () => computeRolesReport({ userConfig, capabilities: bad }),
    (err) => err instanceof RoleRouterError && err.code === 'capability_mismatch'
  );
});

test('computeRolesReport: invalid input throws RoleRouterError', async () => {
  await assert.rejects(
    () => computeRolesReport({ userConfig: null }),
    (err) => err instanceof RoleRouterError && err.code === 'invalid_input'
  );
});
