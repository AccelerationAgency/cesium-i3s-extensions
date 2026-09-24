// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
import { projectedScale, expandUvRegions, uvRegionsToFloat } from '../../worker/src/workerMath.js';

const K = 180 / (Math.PI * 6378137);

describe('projectedScale', () => {
  it('is null when the layer is not marked projected', () => {
    expect(projectedScale(undefined, 0.5)).toBeNull();
    expect(projectedScale({}, 0.5)).toBeNull();
  });
  it('folds degrees-per-metre with cos(lat) on Y', () => {
    const lat = (28 * Math.PI) / 180;
    const s = projectedScale({ __projectedWkid: 102100 }, lat)!;
    expect(s.kx).toBeCloseTo(K, 15);
    expect(s.ky).toBeCloseTo(K * Math.cos(lat), 15);
  });
});

describe('expandUvRegions (de-indexed geometry)', () => {
  it('expands 4-component regions through the index buffer like generateNormals does for uv0', () => {
    const regions = new Uint16Array([0, 0, 10, 10, 100, 100, 200, 200, 7, 7, 8, 8]);
    const out = expandUvRegions(regions, [2, 0, 1, 1]);
    expect(Array.from(out)).toEqual([7, 7, 8, 8, 0, 0, 10, 10, 100, 100, 200, 200, 100, 100, 200, 200]);
  });
});

describe('uvRegionsToFloat', () => {
  it('normalises u16 to [0,1] and truncates to vertexCount*4', () => {
    const f = uvRegionsToFloat(new Uint16Array([0, 65535, 32767, 65535, 1, 1, 1, 1]), 1);
    expect(f.length).toBe(4);
    expect(f[0]).toBe(0);
    expect(f[1]).toBe(1);
    expect(f[2]).toBeCloseTo(0.5, 4);
  });
  it('throws when regions are shorter than the vertex count (stride bug guard)', () => {
    expect(() => uvRegionsToFloat(new Uint16Array(4), 2)).toThrow(/uv-region/);
  });
});
