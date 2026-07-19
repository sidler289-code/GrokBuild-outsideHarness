'use strict';

/**
 * PR-1 contract tests.
 *
 * Pins the three normative JSON Schemas (user-config, project-config,
 * review-result v2) and the adapter-capabilities schema against the plan
 * examples. Per the PR-1 acceptance criteria, the tests must:
 *
 *  - Validate the three plan examples against the matching schema.
 *  - Reject selectedHarnesses, preferences, lastVerified drift.
 *  - Reject unknown schemaVersion.
 *  - Treat testsExecution, createdAt, updatedAt as required fields.
 *
 * See docs/plans/v0.2.0-node-core-implementation-plan-revised.zh-CN.md
 * section 14 (PR-1 acceptance) and section 6 (configuration contract).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadSchema, validate, ValidationError } = require('./helpers/schema-loader.cjs');
const { repoPath } = require('./helpers/paths.cjs');

const SCHEMA = {
  USER_CONFIG: repoPath('config', 'user-config.schema.json'),
  PROJECT_CONFIG: repoPath('config', 'project-config.schema.json'),
  RESULT_V2: repoPath('skills', 'cross-harness-review', 'schemas', 'review-result-v2.schema.json'),
  CAPABILITIES: repoPath('config', 'adapter-capabilities.schema.json'),
};

const FIXTURE = {
  USER_CONFIG: repoPath('tests', 'fixtures', 'contracts', 'user-config.example.json'),
  PROJECT_CONFIG: repoPath('tests', 'fixtures', 'contracts', 'project-config.example.json'),
  RESULT_V2: repoPath('tests', 'fixtures', 'contracts', 'review-result-v2.example.json'),
};

function loadJson(absPath) {
  return JSON.parse(require('fs').readFileSync(absPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// User config: plan example must validate, drift fields must be rejected.
// ---------------------------------------------------------------------------

test('user-config: plan section 6.3 example validates', () => {
  const schema = loadSchema(SCHEMA.USER_CONFIG);
  const example = loadJson(FIXTURE.USER_CONFIG);
  assert.equal(validate(example, schema), true);
});

test('user-config: roles plan/code/tests are all required', () => {
  const schema = loadSchema(SCHEMA.USER_CONFIG);
  const example = loadJson(FIXTURE.USER_CONFIG);
  for (const role of ['plan', 'code', 'tests']) {
    const missing = Object.assign({}, example, {
      roles: Object.assign({}, example.roles, { [role]: undefined }),
    });
    delete missing.roles[role];
    assert.throws(
      () => validate(missing, schema),
      (err) => err instanceof ValidationError && /missing required property: plan|code|tests/.test(err.message) && err.message.includes(role)
    );
  }
});

test('user-config: schemaVersion must be exactly 1', () => {
  const schema = loadSchema(SCHEMA.USER_CONFIG);
  const example = loadJson(FIXTURE.USER_CONFIG);
  for (const bad of [0, 2, 99, '1', null]) {
    assert.throws(
      () => validate(Object.assign({}, example, { schemaVersion: bad }), schema),
      ValidationError
    );
  }
});

test('user-config: future schemaVersion fails closed', () => {
  const schema = loadSchema(SCHEMA.USER_CONFIG);
  const example = loadJson(FIXTURE.USER_CONFIG);
  assert.throws(
    () => validate(Object.assign({}, example, { schemaVersion: 2 }), schema),
    ValidationError
  );
});

test('user-config: testsExecution is required and all four subfields required', () => {
  const schema = loadSchema(SCHEMA.USER_CONFIG);
  const example = loadJson(FIXTURE.USER_CONFIG);
  assert.throws(
    () => {
      const noTests = Object.assign({}, example);
      delete noTests.testsExecution;
      validate(noTests, schema);
    },
    (err) => err instanceof ValidationError && /missing required property: testsExecution/.test(err.message)
  );
  for (const field of ['enabled', 'mode', 'defaultTimeoutSeconds', 'maxOutputBytes']) {
    const stripped = Object.assign({}, example, {
      testsExecution: Object.assign({}, example.testsExecution, { [field]: undefined }),
    });
    delete stripped.testsExecution[field];
    assert.throws(
      () => validate(stripped, schema),
      (err) => err instanceof ValidationError && err.message.includes(field)
    );
  }
});

test('user-config: testsExecution boundaries', () => {
  const schema = loadSchema(SCHEMA.USER_CONFIG);
  const example = loadJson(FIXTURE.USER_CONFIG);
  // defaultTimeoutSeconds 1-3600
  for (const bad of [0, -1, 3601, 100000]) {
    assert.throws(
      () =>
        validate(
          Object.assign({}, example, {
            testsExecution: Object.assign({}, example.testsExecution, { defaultTimeoutSeconds: bad }),
          }),
          schema
        ),
      ValidationError
    );
  }
  // maxOutputBytes 65536-16777216
  for (const bad of [0, 65535, 16777217]) {
    assert.throws(
      () =>
        validate(
          Object.assign({}, example, {
            testsExecution: Object.assign({}, example.testsExecution, { maxOutputBytes: bad }),
          }),
          schema
        ),
      ValidationError
    );
  }
  // mode restricted
  assert.throws(
    () =>
      validate(
        Object.assign({}, example, {
          testsExecution: Object.assign({}, example.testsExecution, { mode: 'isolated' }),
        }),
        schema
    ),
    ValidationError
  );
});

test('user-config: createdAt and updatedAt are required and ISO 8601', () => {
  const schema = loadSchema(SCHEMA.USER_CONFIG);
  const example = loadJson(FIXTURE.USER_CONFIG);
  for (const field of ['createdAt', 'updatedAt']) {
    const stripped = Object.assign({}, example);
    delete stripped[field];
    assert.throws(
      () => validate(stripped, schema),
      (err) => err instanceof ValidationError && err.message.includes(field)
    );
    assert.throws(
      () => validate(Object.assign({}, example, { [field]: 'yesterday' }), schema),
      ValidationError
    );
    assert.throws(
      () => validate(Object.assign({}, example, { [field]: '2026-07-18' }), schema),
      ValidationError
    );
  }
});

test('user-config: rejects selectedHarnesses drift (plan 6.1)', () => {
  const schema = loadSchema(SCHEMA.USER_CONFIG);
  const example = loadJson(FIXTURE.USER_CONFIG);
  assert.throws(
    () => validate(Object.assign({}, example, { selectedHarnesses: ['claude', 'opencode'] }), schema),
    (err) => err instanceof ValidationError && /additional property not allowed: selectedHarnesses/.test(err.message)
  );
});

test('user-config: rejects preferences drift (plan 6.1)', () => {
  const schema = loadSchema(SCHEMA.USER_CONFIG);
  const example = loadJson(FIXTURE.USER_CONFIG);
  assert.throws(
    () => validate(Object.assign({}, example, { preferences: { timeout: 100 } }), schema),
    (err) => err instanceof ValidationError && /additional property not allowed: preferences/.test(err.message)
  );
});

test('user-config: rejects lastVerified drift (plan 6.1)', () => {
  const schema = loadSchema(SCHEMA.USER_CONFIG);
  const example = loadJson(FIXTURE.USER_CONFIG);
  assert.throws(
    () =>
      validate(
        Object.assign({}, example, {
          lastVerified: { claude: '2026-07-18T00:00:00.000Z' },
        }),
        schema
      ),
    (err) => err instanceof ValidationError && /additional property not allowed: lastVerified/.test(err.message)
  );
});

test('user-config: rejects planContext drift (plan 6.1)', () => {
  const schema = loadSchema(SCHEMA.USER_CONFIG);
  const example = loadJson(FIXTURE.USER_CONFIG);
  assert.throws(
    () => validate(Object.assign({}, example, { planContext: { allowRead: true } }), schema),
    (err) => err instanceof ValidationError && /additional property not allowed: planContext/.test(err.message)
  );
});

test('user-config: rejects unknown role value', () => {
  const schema = loadSchema(SCHEMA.USER_CONFIG);
  const example = loadJson(FIXTURE.USER_CONFIG);
  assert.throws(
    () =>
      validate(
        Object.assign({}, example, { roles: Object.assign({}, example.roles, { plan: 'gemini' }) }),
        schema
      ),
    ValidationError
  );
});

test('user-config: rejects unknown top-level field', () => {
  const schema = loadSchema(SCHEMA.USER_CONFIG);
  const example = loadJson(FIXTURE.USER_CONFIG);
  assert.throws(
    () => validate(Object.assign({}, example, { typoField: 1 }), schema),
    ValidationError
  );
});

// ---------------------------------------------------------------------------
// Project config: plan example must validate, command shape enforced.
// ---------------------------------------------------------------------------

test('project-config: plan section 6.4 example validates', () => {
  const schema = loadSchema(SCHEMA.PROJECT_CONFIG);
  const example = loadJson(FIXTURE.PROJECT_CONFIG);
  assert.equal(validate(example, schema), true);
});

test('project-config: commands list must be non-empty', () => {
  const schema = loadSchema(SCHEMA.PROJECT_CONFIG);
  const example = loadJson(FIXTURE.PROJECT_CONFIG);
  assert.throws(
    () =>
      validate(
        Object.assign({}, example, {
          testsExecution: Object.assign({}, example.testsExecution, { commands: [] }),
        }),
        schema
      ),
    ValidationError
  );
});

test('project-config: command argv must be non-empty array of non-empty strings', () => {
  const schema = loadSchema(SCHEMA.PROJECT_CONFIG);
  const example = loadJson(FIXTURE.PROJECT_CONFIG);
  for (const bad of [[], [''], ['npm', ''], ['npm', 'test', '']]) {
    assert.throws(
      () =>
        validate(
          Object.assign({}, example, {
            testsExecution: Object.assign({}, example.testsExecution, {
              commands: [
                Object.assign({}, example.testsExecution.commands[0], { argv: bad }),
              ],
            }),
          }),
          schema
        ),
      ValidationError
    );
  }
});

test('project-config: command timeoutSeconds bounded by 3600', () => {
  const schema = loadSchema(SCHEMA.PROJECT_CONFIG);
  const example = loadJson(FIXTURE.PROJECT_CONFIG);
  for (const bad of [0, 3601, 100000]) {
    assert.throws(
      () =>
        validate(
          Object.assign({}, example, {
            testsExecution: Object.assign({}, example.testsExecution, {
              commands: [
                Object.assign({}, example.testsExecution.commands[0], { timeoutSeconds: bad }),
              ],
            }),
          }),
          schema
        ),
      ValidationError
    );
  }
});

test('project-config: rejects unknown top-level field', () => {
  const schema = loadSchema(SCHEMA.PROJECT_CONFIG);
  const example = loadJson(FIXTURE.PROJECT_CONFIG);
  assert.throws(
    () => validate(Object.assign({}, example, { harnessHooks: [] }), schema),
    ValidationError
  );
});

// ---------------------------------------------------------------------------
// Review result v2: plan example must validate, transport vs outcome split.
// ---------------------------------------------------------------------------

test('review-result-v2: plan section 11 example validates', () => {
  const schema = loadSchema(SCHEMA.RESULT_V2);
  const example = loadJson(FIXTURE.RESULT_V2);
  assert.equal(validate(example, schema), true);
});

test('review-result-v2: schemaVersion must be exactly 2', () => {
  const schema = loadSchema(SCHEMA.RESULT_V2);
  const example = loadJson(FIXTURE.RESULT_V2);
  for (const bad of [1, 3, '2', null]) {
    assert.throws(
      () => validate(Object.assign({}, example, { schemaVersion: bad }), schema),
      ValidationError
    );
  }
});

test('review-result-v2: transport status enum locked', () => {
  const schema = loadSchema(SCHEMA.RESULT_V2);
  const example = loadJson(FIXTURE.RESULT_V2);
  // valid transport statuses
  for (const s of ['success', 'unavailable', 'invalid_request', 'configuration_required',
    'capability_mismatch', 'process_failed', 'timed_out', 'policy_denied', 'invalid_output']) {
    validate(Object.assign({}, example, { status: s }), schema);
  }
  // invalid transport status
  assert.throws(
    () => validate(Object.assign({}, example, { status: 'quota_exhausted' }), schema),
    ValidationError
  );
  assert.throws(
    () => validate(Object.assign({}, example, { status: 'authentication_failed' }), schema),
    ValidationError
  );
});

test('review-result-v2: testExecution.outcome enum locked (different from transport)', () => {
  const schema = loadSchema(SCHEMA.RESULT_V2);
  const example = loadJson(FIXTURE.RESULT_V2);
  for (const o of ['passed', 'failed', 'inconclusive', 'not_run', 'policy_blocked']) {
    validate(
      Object.assign({}, example, {
        testExecution: Object.assign({}, example.testExecution, { outcome: o }),
      }),
      schema
    );
  }
  // transport status must NOT be valid as outcome
  assert.throws(
    () =>
      validate(
        Object.assign({}, example, {
          testExecution: Object.assign({}, example.testExecution, { outcome: 'success' }),
        }),
        schema
      ),
    ValidationError
  );
});

test('review-result-v2: reviewer must be a known stable harness id', () => {
  const schema = loadSchema(SCHEMA.RESULT_V2);
  const example = loadJson(FIXTURE.RESULT_V2);
  for (const r of ['claude', 'codex', 'opencode', 'antigravity', 'cursor']) {
    validate(Object.assign({}, example, { reviewer: r }), schema);
  }
  assert.throws(
    () => validate(Object.assign({}, example, { reviewer: 'gemini' }), schema),
    ValidationError
  );
});

test('review-result-v2: planDigest must be sha256:hex64 when present', () => {
  const schema = loadSchema(SCHEMA.RESULT_V2);
  const example = loadJson(FIXTURE.RESULT_V2);
  assert.throws(
    () => validate(Object.assign({}, example, { planDigest: 'abc' }), schema),
    ValidationError
  );
  assert.throws(
    () => validate(Object.assign({}, example, { planDigest: 'md5:' + '0'.repeat(32) }), schema),
    ValidationError
  );
});

test('review-result-v2: rejects v1-only fields when additionalProperties false', () => {
  const schema = loadSchema(SCHEMA.RESULT_V2);
  const example = loadJson(FIXTURE.RESULT_V2);
  // The v1 envelope had a top-level `capability` field; v2 must not.
  assert.throws(
    () => validate(Object.assign({}, example, { capability: { version: '1.0.0' } }), schema),
    (err) => err instanceof ValidationError && /additional property not allowed: capability/.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// Adapter capabilities: capability state enum must be locked.
// ---------------------------------------------------------------------------

test('adapter-capabilities: states limited to verified/failed/unknown', () => {
  const schema = loadSchema(SCHEMA.CAPABILITIES);
  const ok = {
    repoRead: 'verified',
    structuredOutput: 'verified',
    writeRestriction: 'verified',
    structuredToolEvents: 'verified',
    approvedCommandRestriction: 'verified',
    directTestExecution: 'verified',
  };
  assert.equal(validate(ok, schema), true);
  // every state accepted
  for (const s of ['verified', 'failed', 'unknown']) {
    const mutated = Object.assign({}, ok, { repoRead: s });
    validate(mutated, schema);
  }
  // none other
  assert.throws(
    () => validate(Object.assign({}, ok, { repoRead: 'maybe' }), schema),
    ValidationError
  );
});

test('adapter-capabilities: all six capability fields required', () => {
  const schema = loadSchema(SCHEMA.CAPABILITIES);
  const ok = {
    repoRead: 'verified',
    structuredOutput: 'verified',
    writeRestriction: 'verified',
    structuredToolEvents: 'verified',
    approvedCommandRestriction: 'verified',
    directTestExecution: 'verified',
  };
  for (const field of Object.keys(ok)) {
    const stripped = Object.assign({}, ok);
    delete stripped[field];
    assert.throws(
      () => validate(stripped, schema),
      (err) => err instanceof ValidationError && err.message.includes(field)
    );
  }
});
