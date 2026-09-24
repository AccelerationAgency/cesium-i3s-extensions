// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
import * as Cesium from 'cesium';
import { log } from '../log.js';

/** 0 = stock Cesium crop (cross-region bleed), 1 = patched worker, no remap (atlas smear), 2 = fixed. */
export type AtlasMode = 0 | 1 | 2;

const FRAGMENT = /* glsl */ `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
#ifdef HAS_BASE_COLOR_TEXTURE
  // Esri 3DObject I3S layers with atlas-packed textures author per-face UVs that
  // may exceed [0,1] (designed for tiling). uv_region_0 (VEC4 in [0,1] atlas
  // space, emitted by the patched decode worker) says where the face's tile lives.
  vec2 rawUV = fsInput.attributes.texCoord_0;
  vec4 region = fsInput.attributes.uv_region_0;
  vec2 regionSize = region.zw - region.xy;

  vec2 atlasUV;
  vec2 gradScale;
  if (u_atlasMode < 0.5) {
    atlasUV = region.xy + rawUV * regionSize;        // stock crop -> cross-region bleed
    gradScale = regionSize;
  } else if (u_atlasMode < 1.5) {
    atlasUV = rawUV;                                  // worker only -> atlas smear
    gradScale = vec2(1.0);
  } else {
    atlasUV = region.xy + fract(rawUV) * regionSize;  // fixed
    gradScale = regionSize;
  }

  // Derivatives come from the PRE-wrap UV, deliberately. texture() would derive
  // its mip level from dFdx/dFdy of atlasUV, and fract() is discontinuous at
  // every tile boundary: the derivative spikes, the GPU picks the coarsest mip,
  // and a dark seam appears once per tile period. Pinning the mip level to 0
  // instead avoids seams but aliases into moire on minified surfaces such as
  // large flat roofs seen obliquely. Scaling the raw UV's derivative into
  // atlas space gives the true, continuous footprint.
  vec2 ddx = dFdx(rawUV) * gradScale;
  vec2 ddy = dFdy(rawUV) * gradScale;

  // material.diffuse is linear; MaterialStageFS samples base colour through
  // czm_srgbToLinear, so we must too or atlas primitives look gamma-lifted.
  material.diffuse = czm_srgbToLinear(textureGrad(u_baseColorTexture, atlasUV, ddx, ddy)).rgb;
#endif
  // A primitive can carry uv_region_0 with no base-colour texture (an untextured
  // material in an atlas layer). u_baseColorTexture is only declared when
  // MaterialStageFS defines HAS_BASE_COLOR_TEXTURE; referencing it otherwise
  // fails the program compile, and CesiumJS stops rendering the whole scene.
  // Such primitives keep their default material.
}
`;

export function createAtlasUvShader(opts: { mode?: AtlasMode } = {}): Cesium.CustomShader {
  return new Cesium.CustomShader({
    uniforms: { u_atlasMode: { type: Cesium.UniformType.FLOAT, value: opts.mode ?? 2 } },
    fragmentShaderText: FRAGMENT,
  });
}

let shared: Cesium.CustomShader | undefined;
let currentMode: AtlasMode = 2;
function sharedShader(): Cesium.CustomShader {
  return (shared ??= createAtlasUvShader({ mode: currentMode }));
}

/**
 * Attach the atlas shader to every sublayer tileset, unconditionally.
 *
 * Required on EVERY I3SDataProvider once the patched worker is served: the
 * worker no longer crops atlas UVs, so an atlas layer without this shader
 * samples the whole atlas texture.
 *
 * Unless `shader` is passed, the first call lazily creates one CustomShader
 * that all later calls share (so setAtlasDemoMode can switch them together).
 *
 * Safe on mixed layers: Cesium gates a CustomShader PER PRIMITIVE. For a
 * primitive without `uv_region_0`, CustomShaderPipelineStage finds no inferred
 * default for that attribute and disables the custom fragment shader, so the
 * primitive keeps its default material and stays visible. Gating per tileset
 * instead strips the shader from the atlas primitives too. Untextured
 * primitives are safe as well: the remap is compiled only under
 * HAS_BASE_COLOR_TEXTURE, so they keep their ordinary material.
 */
export function attachAtlasShader(provider: Cesium.I3SDataProvider, shader: Cesium.CustomShader = sharedShader()): number {
  const layers = (provider as unknown as { layers?: Array<{ tileset?: Cesium.Cesium3DTileset }> }).layers ?? [];
  let n = 0;
  for (const layer of layers) {
    if (layer.tileset) { layer.tileset.customShader = shader; n++; }
  }
  log.info(`atlas shader attached to ${n} tileset(s)`);
  return n;
}

/** Switch every tileset using the shared shader; call scene.requestRender() after. */
export function setAtlasDemoMode(mode: AtlasMode): void {
  currentMode = mode;
  sharedShader().setUniform('u_atlasMode', mode);
}
export function getAtlasDemoMode(): AtlasMode { return currentMode; }
