'use strict';

/**
 * PR-4: Plan task policy.
 *
 * Plan section 9.1: the plan audit may read code but has no Shell, write,
 * network or MCP permission. Output must include plan conclusions, the
 * requirement list and real file/symbol evidence.
 *
 * The policy is a pure description object the audit orchestrator consults; it
 * never executes anything itself.
 */

const PLAN_POLICY = Object.freeze({
  task: 'plan',
  role: 'plan',
  requiresPlanFile: true,
  requiresScopeSnapshot: false,
  allowedCapabilities: ['repoRead', 'structuredOutput', 'writeRestriction'],
  forbiddenCapabilities: ['shellExecution', 'networkAccess', 'writeAccess', 'mcp'],
});

module.exports = {
  PLAN_POLICY,
};
