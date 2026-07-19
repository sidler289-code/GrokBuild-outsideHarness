#!/usr/bin/env node
'use strict';

const { main } = require('../lib/cli.cjs');

main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    process.stderr.write(`cross-harness-review: ${error.message}\n`);
    process.exitCode = 1;
  }
);
