// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'i3sw-'));

describe('build-worker', () => {
  it('bundles a self-contained patched worker that verify-worker accepts', () => {
    execFileSync('node', ['worker/build-worker.mjs', '--out', out], { stdio: 'pipe' });
    const file = path.join(out, 'decodeI3S.js');
    const src = fs.readFileSync(file, 'utf8');
    expect(src).not.toMatch(/from\s*"\.\/chunk-/);           // no Cesium build chunks
    expect(src).toContain('_UV_REGION_0');
    expect(() => execFileSync('node', ['worker/verify-worker.mjs', file], { stdio: 'pipe' })).not.toThrow();
  }, 60_000);

  it('verify-worker rejects the stock Cesium worker', () => {
    const stock = 'node_modules/cesium/Build/Cesium/Workers/decodeI3S.js';
    expect(() => execFileSync('node', ['worker/verify-worker.mjs', stock], { stdio: 'pipe' })).toThrow();
  });

  it('build-worker refuses an unsupported engine version', () => {
    expect(() => execFileSync('node', ['worker/build-worker.mjs', '--out', out], {
      stdio: 'pipe', env: { ...process.env, CESIUM_I3S_ENGINE_VERSION_OVERRIDE: '99.0.0' },
    })).toThrow(/26\.3\.0/);
  });

  it('build-worker exits 2 with a usage message when --out has no value', () => {
    for (const args of [['--out'], ['--out', '--verbose'], []]) {
      let status = 0; let stderr = '';
      try { execFileSync('node', ['worker/build-worker.mjs', ...args], { stdio: 'pipe' }); }
      catch (e) { const err = e as { status: number; stderr: Buffer }; status = err.status; stderr = err.stderr.toString(); }
      expect(status, args.join(' ')).toBe(2);
      expect(stderr).toMatch(/usage: cesium-i3s-build-worker --out/);
    }
  });

  it('sizes _UV_REGION_0 to the POSITION accessor, not vertexCount (indexed geometry)', () => {
    // generateGltfBuffer reassigns vertexCount = indices.length when indices survive
    // (draco, or normals already present); the other attribute buffers clamp via subarray.
    const src = fs.readFileSync('worker/patched/decodeI3S.js', 'utf8');
    expect(src).toMatch(/uvRegionsToFloat\(\s*uvRegions,\s*meshPositions\.length \/ 3,?\s*\)/);
  });
});

