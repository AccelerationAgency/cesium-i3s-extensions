#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
// Fails a consumer's build when the served decodeI3S worker is not the patched one.
import fs from 'node:fs';
const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error(`cesium-i3s-verify-worker: no worker at ${file}`); process.exit(1); }
const src = fs.readFileSync(file, 'utf8');
const MARKERS = [
  ['patch banner', /cesium-i3s-extensions patched decodeI3S/],
  ['_UV_REGION_0 attribute emission', /_UV_REGION_0/],
  ['projected-layer marker read', /__projectedWkid/],
];
const missing = MARKERS.filter(([, re]) => !re.test(src)).map(([l]) => l);
if (missing.length) {
  console.error(`cesium-i3s-verify-worker: ${file} is not the patched worker. Missing: ${missing.join(', ')}.\n` +
    `Run: npx cesium-i3s-build-worker --out <your CESIUM_BASE_URL>/Workers`);
  process.exit(1);
}
console.log(`cesium-i3s-verify-worker: ${file} OK`);
