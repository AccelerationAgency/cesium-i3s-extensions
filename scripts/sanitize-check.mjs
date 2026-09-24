#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { scanText } from './sanitize-lib.mjs';
import { loadDenylist, DENYLIST_FILE } from './load-denylist.mjs';

const BINARY_OK = /^(docs\/img\/|test\/fixtures\/)/;
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter(Boolean);

const problems = [];
const list = loadDenylist();
if (!list) {
  if (process.env.CI === 'true' && process.env.GITHUB_REF === 'refs/heads/main') {
    problems.push('private denylist not configured (SANITIZE_DENYLIST secret missing) — required on main');
  } else {
    console.warn('sanitize: WARNING: private denylist not configured; running gitleaks only');
  }
}

for (const f of files) {
  if (f === DENYLIST_FILE || f === 'LICENSE' || !fs.existsSync(f)) continue;
  const buf = fs.readFileSync(f);
  if (buf.includes(0)) { if (!BINARY_OK.test(f)) problems.push(`${f}: binary file outside docs/img or test/fixtures`); continue; }
  if (list) problems.push(...scanText(f, buf.toString('utf8'), list));
}
try { execFileSync('gitleaks', ['detect', '--no-banner', '--redact', '-s', '.'], { stdio: 'inherit' }); }
catch (e) { problems.push(e.code === 'ENOENT' ? 'gitleaks not installed (brew install gitleaks)' : 'gitleaks found secrets'); }

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`sanitize: ${files.length} files ${list ? 'clean' : 'checked (gitleaks only)'}`);
