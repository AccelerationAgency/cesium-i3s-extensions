// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
import * as Cesium from 'cesium';
import { createAtlasUvShader, attachAtlasShader, setAtlasDemoMode, getAtlasDemoMode } from '../../src/atlas';
import { setLogger } from '../../src/log';

beforeEach(() => {
  setLogger({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  setAtlasDemoMode(2);
});

afterEach(() => {
  setLogger(null);
});

describe('createAtlasUvShader', () => {
  it('reads uv_region_0 and samples with textureGrad from pre-wrap derivatives', () => {
    const s = createAtlasUvShader();
    expect(s).toBeInstanceOf(Cesium.CustomShader);
    const src = s.fragmentShaderText!;
    expect(src).toContain('fsInput.attributes.uv_region_0');
    expect(src).toContain('textureGrad(u_baseColorTexture, atlasUV, ddx, ddy)');
    expect(src).toContain('dFdx(rawUV) * gradScale');
    expect(src).toContain('czm_srgbToLinear');
    expect(src).not.toMatch(/textureLod\(/);
  });
  it('only samples u_baseColorTexture when the primitive has one', () => {
    const src = createAtlasUvShader().fragmentShaderText!;
    const guard = src.indexOf('#ifdef HAS_BASE_COLOR_TEXTURE');
    const use = src.indexOf('u_baseColorTexture,');
    const end = src.indexOf('#endif');
    expect(guard).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(guard);
    expect(end).toBeGreaterThan(use);
  });
  it('defaults to mode 2 (fixed)', () => {
    expect(createAtlasUvShader().uniforms.u_atlasMode.value).toBe(2);
    expect(createAtlasUvShader({ mode: 0 }).uniforms.u_atlasMode.value).toBe(0);
  });
});

describe('attachAtlasShader', () => {
  it('attaches to every sublayer tileset unconditionally and skips layers without one', () => {
    const a = {} as any, b = {} as any;
    const provider = { layers: [{ tileset: a }, {}, { tileset: b }] } as any;
    expect(attachAtlasShader(provider)).toBe(2);
    expect(a.customShader).toBeInstanceOf(Cesium.CustomShader);
    expect(b.customShader).toBe(a.customShader);
  });
  it('tolerates a provider with no layers', () => {
    expect(attachAtlasShader({} as any)).toBe(0);
  });
});

describe('demo mode', () => {
  it('round-trips and updates the shared uniform', () => {
    const t = {} as any;
    attachAtlasShader({ layers: [{ tileset: t }] } as any);
    setAtlasDemoMode(0);
    expect(getAtlasDemoMode()).toBe(0);
    expect(t.customShader.uniforms.u_atlasMode.value).toBe(0);
    setAtlasDemoMode(2);
  });
});
