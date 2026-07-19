'use strict';

/**
 * PR-4: Adapter registry and shared contract helpers.
 *
 * Each built-in adapter (plan section 8) implements the same shape:
 *
 *   id, displayName, binaryNames
 *   discoverCandidates(context)
 *   probeVersion(candidate)
 *   probeCapabilities(candidate)         // PR-6/7 add real probes; PR-4 returns
 *                                        // the verified read-side capability set
 *   buildInvocation(taskContext)         // { program, args, env, input, cwd }
 *   parseEvents(stream)                  // adapter-specific (unused by PR-4 audits)
 *   normalizeFinalResult(raw)            // delegate to core/normalize-result
 *   cleanup(runContext)                  // bounded cleanup of temp files
 *
 * Adapters share the Node bounded-process runner, event recorder and result
 * normalizer. They never read user config, never implement their own timeouts,
 * and never parse provider output beyond emitting structured events.
 */

const claude = require('./claude.cjs');
const codex = require('./codex.cjs');
const opencode = require('./opencode.cjs');
const cursor = require('./cursor.cjs');

const REGISTRY = Object.freeze({
  claude,
  codex,
  opencode,
  cursor,
});

function getAdapter(harnessId) {
  const adapter = REGISTRY[harnessId];
  if (!adapter) {
    const error = new Error(`No adapter registered for harness id: ${harnessId}`);
    error.code = 'unknown_adapter';
    throw error;
  }
  return adapter;
}

function listAdapterIds() {
  return Object.keys(REGISTRY);
}

module.exports = {
  REGISTRY,
  getAdapter,
  listAdapterIds,
};
