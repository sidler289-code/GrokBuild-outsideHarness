'use strict';

/**
 * PR-4: Code task policy.
 *
 * Plan section 9.2: code audit requires a plan file and runs in an isolated
 * harness session. Output marks each plan requirement as
 * implemented/partial/missing/deviated/not_verifiable with file evidence that
 * must pass the scope gate.
 *
 * If the same harness carries plan and code, the two tasks still use
 * independent sessions; the audit orchestrator enforces that.
 */

const CODE_POLICY = Object.freeze({
  task: 'code',
  role: 'code',
  requiresPlanFile: true,
  requiresScopeSnapshot: true,
  allowedCapabilities: ['repoRead', 'structuredOutput', 'writeRestriction'],
  forbiddenCapabilities: ['shellExecution', 'networkAccess', 'writeAccess', 'mcp'],
});

module.exports = {
  CODE_POLICY,
};
