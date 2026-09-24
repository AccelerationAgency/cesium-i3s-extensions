#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
// Regenerates worker/decodeI3S.patch (reviewable diff vs stock engine source).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const r = spawnSync('diff', ['-u', '--label', 'a/packages/engine/Source/Workers/decodeI3S.js', '--label', 'b/packages/engine/Source/Workers/decodeI3S.js',
  'node_modules/@cesium/engine/Source/Workers/decodeI3S.js', 'worker/patched/decodeI3S.js'], { encoding: 'utf8' });
if (r.status > 1) { console.error(r.stderr); process.exit(1); }
fs.writeFileSync('worker/decodeI3S.patch', r.stdout);
console.log(`wrote worker/decodeI3S.patch (${r.stdout.split('\n').length} lines)`);
