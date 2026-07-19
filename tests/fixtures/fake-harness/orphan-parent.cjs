'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true,
});

fs.writeFileSync(process.env.FAKE_HARNESS_CHILD_PID_FILE, String(child.pid), 'utf8');
setInterval(() => {}, 1000);
