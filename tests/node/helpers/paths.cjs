'use strict';

const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function repoPath(...segments) {
  return path.join(REPO_ROOT, ...segments);
}

module.exports = {
  REPO_ROOT,
  repoPath,
};
