'use strict';

/**
 * PR-3 config tests.
 *
 * Pins the four responsibilities of lib/core/config.cjs against the plan
 * (revised plan, section 6):
 *  - 6.2 path priority across Windows / POSIX / explicit override
 *  - 6.3 schema validation (required roles, testsExecution boundaries,
 *    additionalProperties:false, ISO 8601 timestamps)
 *  - 6.5 atomic write (createdAt preserved, updatedAt now, .bak, temp file)
 *  - 6.6 legacy-unconfigured detection when no file exists
 *  - 2.2 role allocation state machine (1/2/3 distinct harnesses)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ConfigError,
  SCHEMA_VERSION,
  resolveUserConfigPath,
  validateUserConfig,
  validateProjectConfig,
  classifyRoleMapping,
  loadUserConfig,
  writeUserConfig,
  defaultUserConfig,
  loadProjectConfig,
} = require('../../lib/core/config.cjs');

// ---------------------------------------------------------------------------
// In-memory filesystem for write/load tests. Avoids touching the real user
// home and lets us assert exact file layouts.
// ---------------------------------------------------------------------------

function createMemFs(initial = {}) {
  const files = new Map();
  for (const [p, contents] of Object.entries(initial)) {
    files.set(path.resolve(p), contents);
  }
  const memFs = {
    files,
    readFileSync(target) {
      const resolved = path.resolve(target);
      if (!files.has(resolved)) {
        const error = new Error(`ENOENT: ${target}`);
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(resolved);
    },
    writeFileSync(target, data) {
      files.set(path.resolve(target), data);
    },
    openSync(target) {
      // Minimal handle that satisfies writeSync/closeSync/fsyncSync usage.
      const handle = { target: path.resolve(target), data: '', closed: false };
      handles.set(handle, true);
      return handle;
    },
    writeSync(handle, data) {
      if (handle.closed) {
        throw new Error('write after close');
      }
      handle.data += data;
      return Buffer.byteLength(data, 'utf8');
    },
    closeSync(handle) {
      handle.closed = true;
      files.set(handle.target, handle.data);
    },
    fsyncSync() {},
    renameSync(from, to) {
      const fromResolved = path.resolve(from);
      const toResolved = path.resolve(to);
      if (!files.has(fromResolved)) {
        const error = new Error(`ENOENT rename: ${from}`);
        error.code = 'ENOENT';
        throw error;
      }
      files.set(toResolved, files.get(fromResolved));
      files.delete(fromResolved);
    },
    copyFileSync(from, to) {
      const fromResolved = path.resolve(from);
      if (!files.has(fromResolved)) {
        const error = new Error(`ENOENT copy: ${from}`);
        error.code = 'ENOENT';
        throw error;
      }
      files.set(path.resolve(to), files.get(fromResolved));
    },
    unlinkSync(target) {
      files.delete(path.resolve(target));
    },
    mkdirSync() {},
  };
  const handles = new Map();
  return memFs;
}

function roleMap(plan, code, tests) {
  return { plan, code, tests };
}

// ---------------------------------------------------------------------------
// 6.2 Path resolution.
// ---------------------------------------------------------------------------

test('6.2: CROSS_HARNESS_CONFIG absolute override wins everywhere', () => {
  const cases = [
    { platform: 'win32', abs: 'C:\\cfg\\cross-harness.json' },
    { platform: 'linux', abs: '/etc/cross-harness.json' },
  ];
  for (const { platform, abs } of cases) {
    const resolved = resolveUserConfigPath({
      env: { CROSS_HARNESS_CONFIG: abs },
      platform,
      home: '/home/u',
    });
    assert.equal(resolved.source, 'CROSS_HARNESS_CONFIG');
    assert.equal(resolved.path, abs);
  }
});

test('6.2: a Windows drive-letter override is not absolute on POSIX', () => {
  // The host-platform contract: an override must be absolute for the platform
  // the Node core is running on. A drive-letter path is Windows-only and is
  // correctly rejected under a POSIX platform parameter.
  assert.throws(
    () => resolveUserConfigPath({ env: { CROSS_HARNESS_CONFIG: 'C:\\etc\\x.json' }, platform: 'linux', home: '/h' }),
    (err) => err instanceof ConfigError && err.code === 'invalid_override'
  );
});

test('6.2: relative CROSS_HARNESS_CONFIG is rejected (fail-closed)', () => {
  assert.throws(
    () => resolveUserConfigPath({ env: { CROSS_HARNESS_CONFIG: 'relative/path.json' }, platform: 'linux', home: '/h' }),
    (err) => err instanceof ConfigError && err.code === 'invalid_override'
  );
});

test('6.2: Windows uses LOCALAPPDATA when present', () => {
  const resolved = resolveUserConfigPath({
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    platform: 'win32',
    home: 'C:\\Users\\u',
  });
  assert.equal(resolved.source, 'LOCALAPPDATA');
  assert.equal(resolved.path, path.join('C:\\Users\\u\\AppData\\Local', 'cross-harness-review', 'config.json'));
});

test('6.2: Windows falls back to USERPROFILE\\AppData\\Local when LOCALAPPDATA missing', () => {
  const resolved = resolveUserConfigPath({
    env: { USERPROFILE: 'C:\\Users\\u' },
    platform: 'win32',
    home: 'C:\\Users\\u',
  });
  assert.equal(resolved.source, 'USERPROFILE');
  assert.match(resolved.path, /AppData[\\/]Local[\\/]cross-harness-review[\\/]config\.json/);
});

test('6.2: POSIX uses absolute XDG_CONFIG_HOME', () => {
  const resolved = resolveUserConfigPath({
    env: { XDG_CONFIG_HOME: '/custom/xdg' },
    platform: 'linux',
    home: '/home/u',
  });
  assert.equal(resolved.source, 'XDG_CONFIG_HOME');
  assert.equal(resolved.path, '/custom/xdg/cross-harness-review/config.json');
});

test('6.2: POSIX ignores relative XDG_CONFIG_HOME and falls back to ~/.config', () => {
  const resolved = resolveUserConfigPath({
    env: { XDG_CONFIG_HOME: 'relative/xdg' },
    platform: 'linux',
    home: '/home/u',
  });
  assert.equal(resolved.source, 'home');
  assert.equal(resolved.path, '/home/u/.config/cross-harness-review/config.json');
});

test('6.2: POSIX default uses ~/.config when XDG unset', () => {
  const resolved = resolveUserConfigPath({ env: {}, platform: 'linux', home: '/home/u' });
  assert.equal(resolved.path, '/home/u/.config/cross-harness-review/config.json');
});

test('6.2: Windows fails when neither LOCALAPPDATA nor USERPROFILE is set', () => {
  assert.throws(
    () => resolveUserConfigPath({ env: {}, platform: 'win32', home: 'C:\\Users\\u' }),
    (err) => err instanceof ConfigError && err.code === 'no_home'
  );
});

// ---------------------------------------------------------------------------
// 6.3 Schema validation.
// ---------------------------------------------------------------------------

function validConfig(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    roles: roleMap('claude', 'claude', 'opencode'),
    testsExecution: {
      enabled: true,
      mode: 'host-bounded',
      defaultTimeoutSeconds: 600,
      maxOutputBytes: 1_048_576,
    },
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

test('6.3: valid config passes', () => {
  assert.doesNotThrow(() => validateUserConfig(validConfig()));
});

test('6.3: future schemaVersion fails closed', () => {
  for (const bad of [0, 2, 99, '1', null]) {
    assert.throws(
      () => validateUserConfig(validConfig({ schemaVersion: bad })),
      (err) => err instanceof ConfigError && err.code === 'unsupported_schema'
    );
  }
});

test('6.3: rejects selectedHarnesses / preferences / lastVerified / planContext drift', () => {
  for (const field of ['selectedHarnesses', 'preferences', 'lastVerified', 'planContext']) {
    assert.throws(
      () => validateUserConfig(validConfig({ [field]: { x: 1 } })),
      (err) => err instanceof ConfigError && err.code === 'unknown_field' && err.message.includes(field)
    );
  }
});

test('6.3: roles plan/code/tests all required', () => {
  for (const role of ['plan', 'code', 'tests']) {
    const stripped = validConfig();
    delete stripped.roles[role];
    assert.throws(
      () => validateUserConfig(stripped),
      (err) => err instanceof ConfigError && err.code === 'missing_field'
    );
  }
});

test('6.3: rejects unknown role key', () => {
  const cfg = validConfig();
  cfg.roles.security = 'claude';
  assert.throws(
    () => validateUserConfig(cfg),
    (err) => err instanceof ConfigError && err.code === 'unknown_field'
  );
});

test('6.3: rejects unknown role value', () => {
  assert.throws(
    () => validateUserConfig(validConfig({ roles: roleMap('gemini', 'claude', 'opencode') })),
    (err) => err instanceof ConfigError && err.code === 'invalid_field'
  );
});

test('6.3: testsExecution boundaries enforced', () => {
  for (const bad of [0, -1, 3601, 100000]) {
    assert.throws(
      () =>
        validateUserConfig(
          validConfig({ testsExecution: { ...validConfig().testsExecution, defaultTimeoutSeconds: bad } })
        ),
      (err) => err instanceof ConfigError && err.code === 'invalid_field'
    );
  }
  for (const bad of [0, 65535, 16777217]) {
    assert.throws(
      () =>
        validateUserConfig(validConfig({ testsExecution: { ...validConfig().testsExecution, maxOutputBytes: bad } })),
      (err) => err instanceof ConfigError && err.code === 'invalid_field'
    );
  }
  assert.throws(
    () => validateUserConfig(validConfig({ testsExecution: { ...validConfig().testsExecution, mode: 'isolated' } })),
    (err) => err instanceof ConfigError && err.code === 'invalid_field'
  );
});

test('6.3: createdAt / updatedAt must be ISO 8601', () => {
  for (const bad of ['yesterday', '2026-07-18', 'not-a-date']) {
    assert.throws(
      () => validateUserConfig(validConfig({ createdAt: bad })),
      (err) => err instanceof ConfigError && err.code === 'invalid_field'
    );
  }
});

// ---------------------------------------------------------------------------
// 2.2 Role allocation state machine.
// ---------------------------------------------------------------------------

test('2.2: 1 distinct harness is valid', () => {
  const r = classifyRoleMapping(roleMap('claude', 'claude', 'claude'));
  assert.equal(r.count, 1);
});

test('2.2: 2 harnesses requires plan==code, tests is the other', () => {
  assert.doesNotThrow(() => classifyRoleMapping(roleMap('claude', 'claude', 'codex')));
  // Invalid: plan and tests same, code different
  assert.throws(
    () => classifyRoleMapping(roleMap('claude', 'codex', 'claude')),
    (err) => err instanceof ConfigError && err.code === 'invalid_allocation'
  );
});

test('2.2: 3 harnesses requires every role distinct', () => {
  assert.doesNotThrow(() => classifyRoleMapping(roleMap('claude', 'codex', 'opencode')));
  // 3-distinct required: only two distinct harnesses is fine *only* when
  // plan==code and tests is the other one. A mapping where plan and tests
  // share a harness but code differs has count==2 yet plan!=code, which the
  // 2-harness branch must reject.
  assert.throws(
    () => classifyRoleMapping(roleMap('claude', 'codex', 'claude')),
    (err) => err instanceof ConfigError && err.code === 'invalid_allocation'
  );
});

test('2.2: zero or four distinct not possible with three roles', () => {
  // Three roles can only yield 1/2/3 distinct; the classifier handles all cases.
  // Sanity: the valid allocations all pass.
  assert.doesNotThrow(() => classifyRoleMapping(roleMap('claude', 'claude', 'claude')));
});

// ---------------------------------------------------------------------------
// 6.5 Atomic write + migration.
// ---------------------------------------------------------------------------

test('6.5: writeUserConfig creates a fresh file with createdAt == updatedAt', () => {
  const memFs = createMemFs();
  const target = process.platform === 'win32' ? 'C:\\home\\config.json' : '/home/u/config.json';
  const fixedNow = '2026-07-18T12:00:00.000Z';
  const result = writeUserConfig(
    { roles: roleMap('claude', 'claude', 'opencode'), testsExecution: { enabled: true, mode: 'host-bounded', defaultTimeoutSeconds: 600, maxOutputBytes: 1_048_576 } },
    {
      env: { CROSS_HARNESS_CONFIG: target },
      platform: process.platform,
      home: '/home/u',
      fsImpl: memFs,
      now: () => fixedNow,
    }
  );
  assert.equal(result.path, target);
  const written = JSON.parse(memFs.readFileSync(target));
  assert.equal(written.createdAt, fixedNow);
  assert.equal(written.updatedAt, fixedNow);
  assert.equal(written.schemaVersion, SCHEMA_VERSION);
  assert.equal(written.roles.tests, 'opencode');
  // No temp file left behind.
  const leftovers = [...memFs.files.keys()].filter((p) => p.includes('.tmp.'));
  assert.equal(leftovers.length, 0);
});

test('6.5: createdAt is preserved across rewrites, updatedAt advances', () => {
  const memFs = createMemFs();
  const target = '/home/u/config.json';
  const first = '2026-07-18T00:00:00.000Z';
  const second = '2026-07-18T23:59:59.000Z';

  writeUserConfig(
    { roles: roleMap('claude', 'claude', 'claude'), testsExecution: { enabled: false, mode: 'host-bounded', defaultTimeoutSeconds: 600, maxOutputBytes: 1_048_576 } },
    { env: { CROSS_HARNESS_CONFIG: target }, platform: 'linux', home: '/home/u', fsImpl: memFs, now: () => first }
  );

  writeUserConfig(
    { roles: roleMap('claude', 'claude', 'codex'), testsExecution: { enabled: true, mode: 'host-bounded', defaultTimeoutSeconds: 600, maxOutputBytes: 1_048_576 } },
    { env: { CROSS_HARNESS_CONFIG: target }, platform: 'linux', home: '/home/u', fsImpl: memFs, now: () => second }
  );

  const written = JSON.parse(memFs.readFileSync(target));
  assert.equal(written.createdAt, first, 'createdAt preserved');
  assert.equal(written.updatedAt, second, 'updatedAt advances');
  assert.equal(written.roles.tests, 'codex');

  // .bak must contain the previous version.
  const bak = JSON.parse(memFs.readFileSync(`${target}.bak`));
  assert.equal(bak.roles.tests, 'claude');
});

test('6.5: invalid role mapping is rejected before touching the file', () => {
  const memFs = createMemFs();
  const target = '/home/u/config.json';
  assert.throws(
    () =>
      writeUserConfig(
        { roles: roleMap('claude', 'codex', 'claude'), testsExecution: { enabled: false, mode: 'host-bounded', defaultTimeoutSeconds: 600, maxOutputBytes: 1_048_576 } },
        { env: { CROSS_HARNESS_CONFIG: target }, platform: 'linux', home: '/home/u', fsImpl: memFs, now: () => '2026-07-18T00:00:00.000Z' }
      ),
    (err) => err instanceof ConfigError && err.code === 'invalid_allocation'
  );
  assert.ok(!memFs.files.has(path.resolve(target)), 'no file created on invalid input');
});

// ---------------------------------------------------------------------------
// 6.6 legacy-unconfigured detection.
// ---------------------------------------------------------------------------

test('6.6: missing config file yields legacy-unconfigured mode', () => {
  const memFs = createMemFs(); // empty
  const loaded = loadUserConfig({
    env: { CROSS_HARNESS_CONFIG: '/home/u/config.json' },
    platform: 'linux',
    home: '/home/u',
    fsImpl: memFs,
  });
  assert.equal(loaded.configured, false);
  assert.equal(loaded.mode, 'legacy-unconfigured');
  assert.equal(loaded.config, null);
});

test('6.6: present valid config yields configured mode', () => {
  const memFs = createMemFs({
    '/home/u/config.json': JSON.stringify(validConfig()),
  });
  const loaded = loadUserConfig({
    env: { CROSS_HARNESS_CONFIG: '/home/u/config.json' },
    platform: 'linux',
    home: '/home/u',
    fsImpl: memFs,
  });
  assert.equal(loaded.configured, true);
  assert.equal(loaded.mode, 'configured');
  assert.equal(loaded.config.roles.tests, 'opencode');
});

test('6.6: corrupt config JSON throws, not silently legacy', () => {
  const memFs = createMemFs({ '/home/u/config.json': '{ not json' });
  assert.throws(
    () =>
      loadUserConfig({
        env: { CROSS_HARNESS_CONFIG: '/home/u/config.json' },
        platform: 'linux',
        home: '/home/u',
        fsImpl: memFs,
      }),
    (err) => err instanceof ConfigError && err.code === 'invalid_json'
  );
});

// ---------------------------------------------------------------------------
// 6.4 Project config.
// ---------------------------------------------------------------------------

const validProject = {
  schemaVersion: 1,
  testsExecution: {
    commands: [{ id: 'unit', argv: ['npm', 'test'], cwd: '.' }],
    environmentAllowlist: ['CI'],
    artifacts: ['coverage/**'],
  },
};

test('6.4: valid project config passes', () => {
  assert.doesNotThrow(() => validateProjectConfig(validProject));
});

test('6.4: empty commands list rejected', () => {
  const bad = JSON.parse(JSON.stringify(validProject));
  bad.testsExecution.commands = [];
  assert.throws(() => validateProjectConfig(bad), (err) => err instanceof ConfigError);
});

test('6.4: command cwd must be 1..4096 chars', () => {
  const bad = JSON.parse(JSON.stringify(validProject));
  bad.testsExecution.commands[0].cwd = '';
  assert.throws(() => validateProjectConfig(bad), (err) => err instanceof ConfigError && err.code === 'invalid_field');
});

test('6.4: loadProjectConfig returns null when repo has no config file', () => {
  const memFs = createMemFs();
  assert.equal(
    loadProjectConfig('/repo', { fsImpl: memFs }),
    null
  );
});

test('6.4: defaultUserConfig sets host-bounded mode and default timeout', () => {
  const cfg = defaultUserConfig({ roles: roleMap('claude', 'claude', 'claude') });
  assert.equal(cfg.testsExecution.mode, 'host-bounded');
  assert.equal(cfg.testsExecution.defaultTimeoutSeconds, 600);
  assert.equal(cfg.testsExecution.maxOutputBytes, 1_048_576);
  assert.equal(cfg.testsExecution.enabled, false);
});
