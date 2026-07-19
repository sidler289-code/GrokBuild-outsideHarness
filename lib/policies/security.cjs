'use strict';

/**
 * PR-4: Security task policy.
 *
 * Plan section 2.1: `security` follows the `code` role in 0.2.0 and does not
 * add a fourth allocation slot. It shares code's capability envelope (read +
 * Git scope, no write/shell/network/MCP).
 */

const SECURITY_POLICY = Object.freeze({
  task: 'security',
  role: 'security',
  requiresPlanFile: false, // optional; security may run without a plan file
  requiresScopeSnapshot: true,
  allowedCapabilities: ['repoRead', 'structuredOutput', 'writeRestriction'],
  forbiddenCapabilities: ['shellExecution', 'networkAccess', 'writeAccess', 'mcp'],
});

module.exports = {
  SECURITY_POLICY,
};
