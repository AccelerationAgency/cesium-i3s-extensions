#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
// Bundles worker/patched/decodeI3S.js against the consumer's installed
// @cesium/engine sources into one self-contained ES-module worker.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(fs.readFileSync(path.join(here, 'base.json'), 'utf8'));
const outIdx = process.argv.indexOf('--out');
const outArg = outIdx === -1 ? undefined : process.argv[outIdx + 1];
if (!outArg || outArg.startsWith('-')) {
  console.error('usage: cesium-i3s-build-worker --out <dir served at CESIUM_BASE_URL>/Workers');
  process.exit(2);
}
const outDir = path.resolve(outArg);

// Resolve @cesium/engine the way `cesium` itself does (from cesium's own
// location), so a nested engine under node_modules/cesium is found; fall back
// to resolving from the project root.
function resolveEnginePkg() {
  const projectReq = createRequire(path.join(process.cwd(), 'package.json'));
  try {
    const cesiumPkg = projectReq.resolve('cesium/package.json');
    return createRequire(cesiumPkg).resolve('@cesium/engine/package.json');
  } catch {
    return projectReq.resolve('@cesium/engine/package.json');
  }
}
const enginePkg = resolveEnginePkg();
const engineDir = path.dirname(enginePkg);
const version = process.env.CESIUM_I3S_ENGINE_VERSION_OVERRIDE ?? JSON.parse(fs.readFileSync(enginePkg, 'utf8')).version;
const stockSrc = fs.readFileSync(path.join(engineDir, 'Source/Workers/decodeI3S.js'));
const sha = crypto.createHash('sha256').update(stockSrc).digest('hex');
if (version !== base.engine || sha !== base.sha256) {
  console.error(`cesium-i3s: @cesium/engine ${version} (decodeI3S sha256 ${sha.slice(0, 12)}…) is not supported; ` +
    `this release patches @cesium/engine ${base.engine} (cesium ${base.cesium}) only.`);
  process.exit(1);
}

await build({
  stdin: {
    contents: fs.readFileSync(path.join(here, 'patched/decodeI3S.js'), 'utf8'),
    resolveDir: path.join(engineDir, 'Source/Workers'),
    sourcefile: 'decodeI3S.js',
    loader: 'js',
  },
  alias: { 'cesium-i3s-worker-math': path.join(here, 'src/workerMath.js') },
  nodePaths: [path.join(engineDir, 'node_modules'), path.join(process.cwd(), 'node_modules')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  external: ['http', 'https', 'url', 'zlib', 'fs', 'path', 'crypto'],
  legalComments: 'inline',
  banner: { js: `/* cesium-i3s-extensions patched decodeI3S for cesium ${base.cesium}. Apache-2.0. Includes CesiumJS (c) Cesium Contributors. */` },
  outfile: path.join(outDir, 'decodeI3S.js'),
});
console.log(`cesium-i3s: wrote ${path.join(outDir, 'decodeI3S.js')}`);
