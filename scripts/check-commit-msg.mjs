#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scanText } from './sanitize-lib.mjs';
import { loadDenylist } from './load-denylist.mjs';

/**
 * Returns a list of problems with a commit message; empty means OK.
 * @param {string} message
 * @param {import('./load-denylist.mjs').Denylist | null} list
 * @returns {string[]}
 */
export function checkCommitMessage(message, list) {
  // Ignore git's comment lines (the commit template).
  const body = message.split('\n').filter((l) => !l.startsWith('#')).join('\n');
  const problems = [];
  if (/^co-authored-by:/im.test(body)) problems.push('commit message must not carry a Co-Authored-By trailer');
  if (list) {
    for (const hit of scanText('COMMIT_MSG', body, { deny: list.deny })) {
      problems.push(`commit message contains a denylisted term (${hit.replace(/^COMMIT_MSG:/, 'line ')})`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const file = process.argv[2];
  if (!file) { console.error('usage: check-commit-msg.mjs <commit-msg-file>'); process.exit(2); }
  const problems = checkCommitMessage(fs.readFileSync(file, 'utf8'), loadDenylist());
  if (problems.length) { console.error(`commit-msg: ${problems.join('\ncommit-msg: ')}`); process.exit(1); }
}
