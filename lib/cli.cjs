'use strict';

const PACKAGE = require('../package.json');

const config = require('./core/config.cjs');
const discovery = require('./core/discovery.cjs');
const router = require('./core/role-router.cjs');
const audit = require('./core/audit.cjs');

const USAGE = `Usage: cross-harness-review <command> [options]

0.2.0 development commands:
  --help, -h        Show this help text.
  --version         Show the package version.
  config path       Print the resolved user config file path.
  config show       Print the active user config (or legacy-unconfigured mode).
  detect [--json]   Discover installed harnesses and probe their versions.
  doctor [--json]   Offline health check of Node, Git and resolved config.
  roles [--json]    Print the active role routing (configured or legacy).

  audit plan     --plan-file <path> --repo <path>
  audit code     --plan-file <path> --repo <path> --scope <scope>
  audit security --repo <path> --scope <scope>
                 [--reviewer claude|codex]   (one-shot override, never persists)

The setup wizard, the tests audit, and the opencode/antigravity/cursor
adapters are enabled by later 0.2.0 delivery slices. This executable is
intentionally the only business logic entrypoint; PowerShell and POSIX scripts
only forward to it.`;

function write(stream, text) {
  stream.write(`${text}\n`);
}

function parseJsonFlag(argv) {
  return argv.includes('--json');
}

function failWith(stream, message, code = 2) {
  write(stream, message);
  return code;
}

/**
 * Minimal long-option parser for the audit command. Supports both the plan-5
 * subcommand shape (`audit plan --plan-file ... --repo ...`) and the legacy
 * bridge shape (`--reviewer <id> --task <task> ...`). Returns an options map.
 *
 * Throws on unknown options or missing values. We intentionally do NOT support
 * `--flag=value` shorthand; the audit command surface is small and
 * explicitness aids review.
 */
function parseAuditArgs(argv) {
  const options = { positionals: [] };
  const known = new Set(['--plan-file', '--repo', '--scope', '--reviewer', '--task', '--json', '--extra-instructions']);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (!token.startsWith('--')) {
      options.positionals.push(token);
      continue;
    }
    if (!known.has(token)) {
      throw new Error(`Unknown audit option: ${token}`);
    }
    const value = argv[i + 1];
    if (typeof value !== 'string' || value.startsWith('--')) {
      throw new Error(`Option ${token} requires a value.`);
    }
    const key = token.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    options[key] = value;
    i += 1;
  }
  return options;
}

async function runAuditCommand(rest, io) {
  let options;
  try {
    options = parseAuditArgs(rest);
  } catch (error) {
    return failWith(io.stderr, `cross-harness-review audit: ${error.message}`);
  }

  // Task resolution: plan-5 subcommand (`audit plan ...`) wins; legacy --task
  // is accepted for the 0.1.0 bridge parity shape.
  const task = options.positionals[0] || options.task;
  if (!['plan', 'code', 'security', 'tests'].includes(task)) {
    return failWith(io.stderr, `cross-harness-review audit: task must be one of plan|code|security|tests. Got: ${task || '(missing)'}`);
  }
  if (task === 'tests') {
    return failWith(io.stderr, 'cross-harness-review audit tests ships in PR-5.');
  }

  const repo = options.repo;
  if (typeof repo !== 'string' || repo.length === 0) {
    return failWith(io.stderr, 'cross-harness-review audit: --repo <path> is required.');
  }

  try {
    const result = await audit.runAudit({
      task,
      repoRoot: repo,
      planFile: options.planFile,
      scopeSelector: options.scope,
      explicitReviewer: options.reviewer,
      extraInstructions: options.extraInstructions,
    });
    if (options.json) {
      write(io.stdout, JSON.stringify(result, null, 2));
    } else {
      write(io.stdout, `cross-harness-review audit ${task}: ${result.aggregateStatus} (reason: ${result.reason})`);
      if (result.unavailable.length > 0) {
        write(io.stdout, `  unavailable reviewers: ${result.unavailable.join(', ')}`);
      }
      for (const env of result.envelopes) {
        write(io.stdout, `  ${env.reviewer.padEnd(10)} ${env.status}`);
        if (env.summary) {
          write(io.stdout, `             ${env.summary}`);
        }
      }
      write(io.stdout, '  Pass --json for the full v2 envelopes.');
    }
    // Fail-closed exit code: only an all-success aggregate exits 0. Any
    // unavailable reviewer, transport failure, invalid output, timeout or
    // capability mismatch produces a non-zero exit so CI gates treat it as a
    // failed audit rather than silently green.
    if (result.aggregateStatus === 'all_success') {
      return 0;
    }
    return result.aggregateStatus === 'unavailable' ? 3 : 1;
  } catch (error) {
    return failWith(io.stderr, `cross-harness-review audit: ${error.message}`);
  }
}

async function runDetect(argv, io) {
  const asJson = parseJsonFlag(argv);
  const ids = Object.keys(discovery.HARNESS_REGISTRY);
  const results = [];
  for (const id of ids) {
    results.push(await discovery.detectHarness(id));
  }
  if (asJson) {
    write(io.stdout, JSON.stringify({ harnesses: results }, null, 2));
  } else {
    write(io.stdout, 'Detected harnesses:');
    for (const r of results) {
      const status = r.available
        ? `available (${r.version || 'unknown version'} at ${r.candidate.path})`
        : `unavailable (${r.reason})`;
      write(io.stdout, `  ${r.harnessId.padEnd(12)} ${status}`);
    }
  }
  return 0;
}

async function runConfigPath(io) {
  const resolved = config.resolveUserConfigPath();
  write(io.stdout, resolved.path);
  return 0;
}

async function runConfigShow(io) {
  const loaded = config.loadUserConfig();
  write(io.stdout, JSON.stringify(loaded, null, 2));
  return 0;
}

async function runRoles(argv, io) {
  const asJson = parseJsonFlag(argv);
  const userConfig = config.loadUserConfig();

  if (!userConfig.configured) {
    const legacyReviewers = await discovery.detectLegacyReviewers();
    const report = router.legacyRolesReport({ legacyReviewers });
    if (asJson) {
      write(io.stdout, JSON.stringify(report, null, 2));
    } else {
      write(io.stdout, `mode: ${report.mode}`);
      write(io.stdout, `configured: false`);
      write(io.stdout, 'legacy reviewers:');
      for (const r of report.legacyReviewers) {
        write(io.stdout, `  ${r.harnessId} (${r.version || 'unknown version'})`);
      }
      write(
        io.stdout,
        'Run `cross-harness-review setup` to configure opencode/antigravity/cursor and assign roles.'
      );
    }
    return 0;
  }

  // Configured mode requires capability verdicts. Until PR-4/6/7 wire the real
  // capability probes, we cannot truthfully produce a configured roles report.
  // Fail-closed with a clear message rather than fabricating verdicts.
  write(
    io.stderr,
    'Configured-mode role routing requires adapter capability verdicts, which arrive in a later PR. Use --json for the legacy report only before setup completes.'
  );
  return 2;
}

async function runDoctor(argv, io) {
  const asJson = parseJsonFlag(argv);
  const findings = {
    nodeVersion: process.version,
    platform: process.platform,
    packageVersion: PACKAGE.version,
    checks: [],
    configMode: null,
    configPath: null,
  };

  // Node check.
  const nodeMajor = Number.parseInt(process.version.slice(1), 10);
  if (Number.isInteger(nodeMajor) && nodeMajor >= 20) {
    findings.checks.push({ name: 'node', status: 'ok', detail: process.version });
  } else {
    findings.checks.push({ name: 'node', status: 'fail', detail: `Node >=20 required, got ${process.version}` });
  }

  // Git check (best-effort presence on PATH).
  let gitOk = false;
  try {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('git', ['--version'], { windowsHide: true });
    gitOk = result.status === 0;
  } catch {
    gitOk = false;
  }
  findings.checks.push({
    name: 'git',
    status: gitOk ? 'ok' : 'fail',
    detail: gitOk ? 'git found on PATH' : 'git not found on PATH',
  });

  // Config check.
  try {
    const loaded = config.loadUserConfig();
    findings.configMode = loaded.mode;
    findings.configPath = loaded.path;
    findings.checks.push({ name: 'config', status: 'ok', detail: loaded.mode });
  } catch (error) {
    findings.checks.push({ name: 'config', status: 'fail', detail: error.message });
  }

  if (asJson) {
    write(io.stdout, JSON.stringify(findings, null, 2));
  } else {
    write(io.stdout, `cross-harness-review ${PACKAGE.version} doctor`);
    for (const c of findings.checks) {
      if (c.name === 'config') {
        write(io.stdout, `  ${c.name.padEnd(8)} ${c.status.toUpperCase()}  ${findings.configMode || 'unresolved'} (${findings.configPath || 'no path'})`);
      } else {
        write(io.stdout, `  ${c.name.padEnd(8)} ${c.status.toUpperCase()}  ${c.detail}`);
      }
    }
  }
  return 0;
}

async function dispatchCommand(command, rest, io) {
  switch (command) {
    case 'detect':
      return runDetect(rest, io);
    case 'doctor':
      return runDoctor(rest, io);
    case 'roles':
      return runRoles(rest, io);
    case 'config':
      if (rest[0] === 'path') {
        return runConfigPath(io);
      }
      if (rest[0] === 'show') {
        return runConfigShow(io);
      }
      return failWith(io.stderr, `Unknown config subcommand: ${rest[0] || '(none)'}. Use 'config path' or 'config show'.`);
    case 'setup':
      // Interactive setup wizard is PR-8 scope. Refuse non-interactively so
      // users do not see a silent no-op.
      write(
        io.stderr,
        'The interactive setup wizard ships in a later 0.2.0 PR. For now use config show / detect / roles --json.'
      );
      return 2;
    case 'audit':
      return runAuditCommand(rest, io);
    default:
      return failWith(io.stderr, `Unknown command: ${command}. Run --help for the available commands.`);
  }
}

async function main(argv, io = process) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== 'string')) {
    throw new TypeError('argv must be an array of strings.');
  }

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    write(io.stdout, USAGE);
    return 0;
  }

  if (argv.length === 1 && argv[0] === '--version') {
    write(io.stdout, PACKAGE.version);
    return 0;
  }

  const [command, ...rest] = argv;
  return dispatchCommand(command, rest, io);
}

module.exports = {
  USAGE,
  main,
  dispatchCommand,
};
