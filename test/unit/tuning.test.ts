// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
import { createVisibilityLoader, i3sTilesetDefaults, type LayerDef } from '../../src/tuning';
import { setLogger } from '../../src/log';

setLogger(null);

function def(id: string, visible?: boolean, fail = false) {
  const shown: boolean[] = [];
  let resolve!: () => void;
  const gate = new Promise<void>((r) => (resolve = r));
  const d: LayerDef<{ id: string }> & { calls: number; shown: boolean[]; release(): void; manual: boolean } = {
    id, visible, calls: 0, shown, manual: false,
    release: () => resolve(),
    async load() { d.calls++; if (d.manual) await gate; if (fail) throw new Error('boom'); return { id }; },
    setShown(_h, s) { shown.push(s); },
  };
  return d;
}

describe('createVisibilityLoader', () => {
  it('loads visible layers and skips hidden ones; absent visible means visible', async () => {
    const a = def('a', true), b = def('b', false), c = def('c');
    const l = createVisibilityLoader([a, b, c]);
    await l.init();
    expect([a.calls, b.calls, c.calls]).toEqual([1, 0, 1]);
    expect(l.status('b')).toBe('deferred');
  });
  it('loads a deferred layer on first show, shown=true, and never twice', async () => {
    const b = def('b', false);
    const l = createVisibilityLoader([b]);
    await l.init();
    await l.setVisible('b', true);
    await l.setVisible('b', true);
    expect(b.calls).toBe(1);
    expect(b.shown.at(-1)).toBe(true);
  });
  it('does not load when switched OFF', async () => {
    const b = def('b', false);
    const l = createVisibilityLoader([b]);
    await l.init();
    await l.setVisible('b', false);
    expect(b.calls).toBe(0);
  });
  it('dedupes concurrent shows and honours a hide issued mid-load', async () => {
    const b = def('b', false); b.manual = true;
    const l = createVisibilityLoader([b]);
    await l.init();
    const p1 = l.setVisible('b', true);
    const p2 = l.setVisible('b', true);
    const p3 = l.setVisible('b', false);
    b.release();
    await Promise.all([p1, p2, p3]);
    expect(b.calls).toBe(1);
    expect(b.shown.at(-1)).toBe(false);
  });
  it('reports failure as status, not a throw', async () => {
    const f = def('f', true, true);
    const seen: string[] = [];
    const l = createVisibilityLoader([f], { onStatus: (id, s) => seen.push(`${id}:${s}`) });
    await expect(l.init()).resolves.toBeUndefined();
    expect(l.status('f')).toBe('failed');
    expect(seen).toEqual(['f:loading', 'f:failed']);
  });
  it('does not resurrect a removed layer', async () => {
    const b = def('b', false);
    const l = createVisibilityLoader([b]);
    await l.init();
    l.remove('b');
    await l.setVisible('b', true);
    expect(b.calls).toBe(0);
  });
  it('routes a synchronous throw from load() to the failure path, not an escaping rejection', async () => {
    const seen: string[] = [];
    const throwsSync: LayerDef<{ id: string }> = {
      id: 'x',
      visible: true,
      load(): Promise<{ id: string }> {
        throw new Error('boom-sync');
      },
      setShown() {},
    };
    const l = createVisibilityLoader([throwsSync], { onStatus: (id, s) => seen.push(`${id}:${s}`) });
    await expect(l.init()).resolves.toBeUndefined();
    expect(l.status('x')).toBe('failed');
    expect(seen).toEqual(['x:loading', 'x:failed']);
  });
  it('does not fire onStatus for a layer removed before its rejected load settles', async () => {
    const b = def('b', true, true);
    b.manual = true;
    const seen: string[] = [];
    const l = createVisibilityLoader([b], { onStatus: (id, s) => seen.push(`${id}:${s}`) });
    const p = l.init();
    l.remove('b');
    b.release();
    await expect(p).resolves.toBeUndefined();
    expect(seen).not.toContain('b:failed');
    expect(l.status('b')).toBeUndefined();
  });
});

describe('i3sTilesetDefaults', () => {
  it('keeps cacheBytes above the measured steady-state working set', () => {
    expect(i3sTilesetDefaults.cacheBytes).toBeGreaterThanOrEqual(512 * 1024 * 1024);
    expect(Object.isFrozen(i3sTilesetDefaults)).toBe(true);
  });
});
