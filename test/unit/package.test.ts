// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Builds dist/ once, then checks that the ESM output loads in plain Node and
// that the packed tarball contains it alongside the worker CLI inputs.
describe('published package', () => {
  beforeAll(() => {
    execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { stdio: 'pipe' });
  }, 120_000);

  it('dist/index.js imports in Node as ESM (relative imports carry extensions)', () => {
    const url = pathToFileURL(path.resolve('dist/index.js')).href;
    const code = `import(${JSON.stringify(url)}).then((m) => { if (typeof m.installProjectedI3SSupport !== 'function' || typeof m.attachAtlasShader !== 'function') process.exit(1); })`;
    execFileSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe' });
  }, 60_000);

  it('ships dist and every file the worker CLIs read', () => {
    const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
    const shipped = new Set<string>(pack.files.map((f: { path: string }) => f.path));
    for (const f of ['LICENSE', 'NOTICE', 'package.json', 'dist/index.js', 'dist/index.d.ts', 'dist/log.js',
      'dist/atlas/index.js', 'dist/projected/index.js', 'dist/tuning/index.js',
      'worker/base.json', 'worker/build-worker.mjs', 'worker/verify-worker.mjs',
      'worker/src/workerMath.js', 'worker/patched/decodeI3S.js']) {
      expect(shipped, f).toContain(f);
    }
    expect(shipped).not.toContain('worker/make-patch.mjs');
    expect([...shipped].some((f) => f.startsWith('scripts/') || f.startsWith('test/') || f.startsWith('src/'))).toBe(false);
  }, 60_000);
});
