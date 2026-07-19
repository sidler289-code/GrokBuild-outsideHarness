'use strict';

/**
 * Node-callable fake harness for the 0.2.0 Node core test matrix.
 *
 * The fake harness is spawned directly via `node <abs>/index.cjs [flags]`
 * with the prompt arriving on stdin (never argv). It is a stand-in for any
 * real adapter (claude / codex / opencode / cursor) during
 * Node-only tests that must not touch a real CLI.
 *
 * Mode selection is via the FAKE_HARNESS_MODE environment variable, set
 * explicitly by the test driver. There is no ambient config file.
 */

const FAKE_HARNESS_DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MiB > 1 MiB cap

function main() {
  const mode = process.env.FAKE_HARNESS_MODE || 'success';
  const sleepMs = Number.parseInt(process.env.FAKE_HARNESS_SLEEP_MS || '0', 10);
  const outputBytes =
    Number.parseInt(process.env.FAKE_HARNESS_OUTPUT_BYTES || '0', 10) ||
    FAKE_HARNESS_DEFAULT_OUTPUT_BYTES;
  const exitCode =
    process.env.FAKE_HARNESS_EXIT_CODE !== undefined
      ? Number.parseInt(process.env.FAKE_HARNESS_EXIT_CODE, 10)
      : null;

  // Always drain stdin first so the writer does not get SIGPIPE in fast
  // success mode. We never echo stdin except in the explicit echo-stdin mode.
  let stdinBuffer = '';
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    // Synchronous drain: node:test does not exercise interactive stdin, and
    // the test driver writes a finite prompt then closes the pipe.
    process.stdin.on('data', (chunk) => {
      stdinBuffer += chunk;
    });
  }

  function emitAndExit() {
    const code =
      exitCode !== null
        ? exitCode
        : mode === 'fail' || mode === 'malformed'
          ? 1
          : 0;

    switch (mode) {
      case 'success': {
        // Minimal v2 result envelope, valid against review-result-v2.schema.json.
        const envelope = {
          schemaVersion: 2,
          task: 'code',
          role: 'code',
          reviewer: 'claude',
          status: 'success',
          summary: 'fake harness: success',
          requirements: [],
          findings: [],
          testExecution: {
            attempted: false,
            verifiedByEvents: false,
            outcome: 'not_run',
            commands: [],
            workspaceChanged: false,
          },
          diagnostics: { durationMs: 0 },
        };
        process.stdout.write(JSON.stringify(envelope));
        break;
      }
      case 'fail': {
        process.stderr.write('fake harness: simulated failure\n');
        break;
      }
      case 'timeout': {
        // Sleep past the test timeout; the runner must kill us.
        // Use a busy loop to defeat any timer throttling.
        const target = Date.now() + Math.max(sleepMs, 30000);
        while (Date.now() < target) {
          // spin
        }
        break;
      }
      case 'huge': {
        // Emit many bytes so the runner must enforce the cap.
        const chunk = 'A'.repeat(64 * 1024);
        let remaining = outputBytes;
        while (remaining > 0) {
          process.stdout.write(chunk);
          remaining -= chunk.length;
        }
        break;
      }
      case 'malformed': {
        // Emit non-JSON so the result normalizer classifies invalid_output.
        process.stdout.write('not json: {');
        break;
      }
      case 'echo-argv': {
        // Print the argv (excluding node and the script path) as JSON.
        // Used by tests that assert argv composition.
        process.stdout.write(JSON.stringify(process.argv.slice(2)));
        break;
      }
      case 'echo-stdin': {
        // Print whatever arrived on stdin. Used to prove the prompt is on
        // stdin and NOT in argv.
        process.stdout.write(stdinBuffer);
        break;
      }
      default: {
        process.stderr.write(`fake harness: unknown mode ${mode}\n`);
        process.exit(2);
      }
    }

    process.exit(code);
  }

  if (process.stdin.isTTY) {
    emitAndExit();
  } else {
    process.stdin.on('end', emitAndExit);
    // Safety: never hang forever even if the writer forgets to close stdin.
    setTimeout(() => {
      emitAndExit();
    }, 5000).unref();
  }
}

main();
