#!/usr/bin/env node
'use strict';

/**
 * Points every link in this project at your GitHub repository.
 *
 *   node scripts/set-repo.js your-github-name/portly
 *
 * The project ships with a placeholder owner name in its links. This replaces it in the
 * README, docs page, package.json and the release workflow. Safe to run more than once.
 */

const fs = require('node:fs');
const path = require('node:path');

// Built from pieces so this script does not rewrite itself.
const FROM = process.argv[3] || ['dng-web-solutions', 'portly'].join('/');
const TO = process.argv[2];

if (!TO || !/^[\w.-]+\/[\w.-]+$/.test(TO)) {
  console.error('Usage: node scripts/set-repo.js <github-owner>/<repo>   e.g. node scripts/set-repo.js dngwebsolutions/portly');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', '.git', 'data', 'logs', 'configs', 'crash-reports']);
const EXT = /\.(md|json|html|js|yml|txt)$/i;
let changed = 0;

(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      continue;
    }
    if (!EXT.test(entry.name) || entry.name === 'package-lock.json' || entry.name.endsWith('.portly.json')) continue;
    const file = path.join(dir, entry.name);
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(FROM)) continue;
    fs.writeFileSync(file, text.split(FROM).join(TO));
    console.log('updated', path.relative(ROOT, file));
    changed++;
  }
})(ROOT);

console.log(changed ? `Done. ${changed} file(s) now point to https://github.com/${TO}` : 'Nothing to change.');
