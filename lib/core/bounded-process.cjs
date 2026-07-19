'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const KILL_GRACE_MS = 250;

function isUnsafeWindowsWrapper(program) {
  return process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(program);
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
}

function assertProcessOptions(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('process options must be an object.');
  }
  if (typeof options.program !== 'string' || options.program.length === 0) {
    throw new TypeError('program must be a non-empty string.');
  }
  if (!Array.isArray(options.args) || options.args.some((argument) => typeof argument !== 'string')) {
    throw new TypeError('args must be an array of strings.');
  }
  if (options.cwd !== undefined && (typeof options.cwd !== 'string' || options.cwd.length === 0)) {
    throw new TypeError('cwd must be a non-empty string when supplied.');
  }
}

function appendCapped(target, chunk, cap) {
  if (target.totalBytes >= cap) {
    target.truncated = true;
    return true;
  }

  const remaining = cap - target.totalBytes;
  if (chunk.length > remaining) {
    target.parts.push(chunk.subarray(0, remaining));
    target.totalBytes += remaining;
    target.truncated = true;
    return true;
  }

  target.parts.push(chunk);
  target.totalBytes += chunk.length;
  return false;
}

function capturedText(target) {
  return Buffer.concat(target.parts, target.totalBytes).toString('utf8');
}

function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    const fallBackToDirectKill = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // The child may have exited between the status check and the signal.
      }
    };
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    });
    killer.once('error', () => {
      fallBackToDirectKill();
    });
    killer.once('close', (exitCode) => {
      if (exitCode !== 0) {
        fallBackToDirectKill();
      }
    });
    setTimeout(fallBackToDirectKill, KILL_GRACE_MS).unref();
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // The child may have exited between the check and signal delivery.
    }
  }

  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // Nothing further can be done if the process exited concurrently.
      }
    }
  }, KILL_GRACE_MS).unref();
}

/**
 * Spawn an argv-only child process with stdin-only input, bounded output, and
 * process-tree cleanup. No call site can opt into a shell through this API.
 */
function runBoundedProcess(options) {
  assertProcessOptions(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  assertPositiveInteger(timeoutMs, 'timeoutMs');
  assertPositiveInteger(maxOutputBytes, 'maxOutputBytes');

  const input = options.input ?? '';
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) {
    throw new TypeError('input must be a string or Buffer.');
  }

  // Node cannot execute these wrappers with shell:false on Windows. Using
  // shell:true would concatenate argv into a command string (DEP0190), which
  // destroys the argv-only safety boundary. Fail closed until discovery
  // resolves a native executable instead.
  if (isUnsafeWindowsWrapper(options.program)) {
    return Promise.resolve({
      exitCode: null,
      signal: null,
      startError: 'Windows shell wrappers (.cmd/.bat/.ps1) are not accepted by the argv-only runner; configure a native executable override.',
      timedOut: false,
      outputLimited: false,
      terminationReason: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 0,
    });
  }

  const recorder = options.eventRecorder;
  const startedAt = process.hrtime.bigint();
  const stdout = { parts: [], totalBytes: 0, truncated: false };
  const stderr = { parts: [], totalBytes: 0, truncated: false };

  return new Promise((resolve) => {
    let child;
    let settled = false;
    let terminationReason = null;
    let timer = null;

    function durationMs() {
      return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    }

    function settle(result) {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      resolve(result);
    }

    function requestTermination(reason) {
      if (terminationReason !== null) {
        return;
      }
      terminationReason = reason;
      recorder?.record('process_termination_requested', { reason });
      terminateProcessTree(child);
    }

    try {
      child = spawn(options.program, options.args, {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      settle({
        exitCode: null,
        signal: null,
        startError: error.message,
        timedOut: false,
        outputLimited: false,
        terminationReason: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: durationMs(),
      });
      return;
    }

    recorder?.record('process_started', {
      program: options.program,
      argumentCount: options.args.length,
      cwd: options.cwd ?? null,
    });

    child.once('error', (error) => {
      settle({
        exitCode: null,
        signal: null,
        startError: error.message,
        timedOut: false,
        outputLimited: false,
        terminationReason: null,
        stdout: capturedText(stdout),
        stderr: capturedText(stderr),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: durationMs(),
      });
    });

    child.stdout.on('data', (chunk) => {
      if (appendCapped(stdout, chunk, maxOutputBytes)) {
        requestTermination('output_limit');
      }
    });
    child.stderr.on('data', (chunk) => {
      if (appendCapped(stderr, chunk, maxOutputBytes)) {
        requestTermination('output_limit');
      }
    });

    child.once('close', (exitCode, signal) => {
      const result = {
        exitCode,
        signal,
        startError: null,
        timedOut: terminationReason === 'timeout',
        outputLimited: terminationReason === 'output_limit',
        terminationReason,
        stdout: capturedText(stdout),
        stderr: capturedText(stderr),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: durationMs(),
      };
      recorder?.record('process_closed', {
        exitCode,
        signal,
        durationMs: result.durationMs,
        terminationReason,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
      });
      settle(result);
    });

    timer = setTimeout(() => requestTermination('timeout'), timeoutMs);
    child.stdin.once('error', () => {
      // A quick child exit can close stdin before the prompt write completes.
    });
    child.stdin.end(input);
  });
}

module.exports = {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  isUnsafeWindowsWrapper,
  runBoundedProcess,
};
