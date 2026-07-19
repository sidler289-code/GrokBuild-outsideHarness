'use strict';

/**
 * PR-5: Direct test execution policy.
 *
 * Tests are not a read-only review.  An adapter may receive this role only
 * when it can both restrict execution to the persisted command allowlist and
 * emit command-completion events that the host can verify independently.
 */

const TESTS_POLICY = Object.freeze({
  task: 'tests',
  role: 'tests',
  requiresPlanFile: false,
  requiresScopeSnapshot: false,
  allowedCapabilities: [
    'repoRead',
    'structuredOutput',
    'structuredToolEvents',
    'approvedCommandRestriction',
    'directTestExecution',
  ],
  forbiddenCapabilities: ['networkAccess', 'writeAccess', 'mcp'],
});

const LEGACY_TESTS_POLICY = Object.freeze({
  task: 'tests',
  role: 'tests',
  requiresPlanFile: false,
  requiresScopeSnapshot: false,
  allowedCapabilities: ['repoRead', 'structuredOutput', 'writeRestriction'],
  forbiddenCapabilities: ['shell', 'networkAccess', 'writeAccess', 'mcp'],
});


module.exports = {
  TESTS_POLICY,
  LEGACY_TESTS_POLICY,
};
