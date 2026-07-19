'use strict';

const PACKAGE = require('../package.json');

const USAGE = `Usage: cross-harness-review <command> [options]

0.2.0 development commands:
  --help, -h       Show this help text.
  --version         Show the package version.

The review, setup, discovery, and adapter commands are enabled by later
0.2.0 delivery slices. This executable is intentionally the only business
logic entrypoint; PowerShell and POSIX scripts only forward to it.`;

function write(stream, text) {
  stream.write(`${text}\n`);
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

  write(io.stderr, `Unsupported command in the PR-2 Node core: ${argv[0]}`);
  write(io.stderr, 'Run cross-harness-review --help for the currently available commands.');
  return 2;
}

module.exports = {
  USAGE,
  main,
};
