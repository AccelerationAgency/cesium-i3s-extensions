// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
// Pure helpers bundled into the patched decodeI3S worker. Kept separate so they
// are unit-testable; the upstream Cesium PR inlines them.

const WEB_MERCATOR_RADIUS = 6378137;
const DEG_PER_METRE = 180 / (Math.PI * WEB_MERCATOR_RADIUS);

/**
 * Web Mercator is conformal, so its inverse linearises over one node:
 * dλ/dX = 1/R, dφ/dY = cos(φ)/R. Folding that into scale_x/scale_y turns the
 * worker's degree-offset vertex math into a metre-offset one.
 */
export function projectedScale(schema, latitudeRad) {
  if (!schema || !schema.__projectedWkid) return null;
  return { kx: DEG_PER_METRE, ky: DEG_PER_METRE * Math.cos(latitudeRad) };
}

/** Mirror of generateNormals' uv0 de-indexing, for 4-component uv-region data. */
export function expandUvRegions(uvRegions, indices) {
  const out = new Uint16Array(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    const s = indices[i] * 4;
    out[i * 4] = uvRegions[s];
    out[i * 4 + 1] = uvRegions[s + 1];
    out[i * 4 + 2] = uvRegions[s + 2];
    out[i * 4 + 3] = uvRegions[s + 3];
  }
  return out;
}

/** u16 [0,65535] regions -> Float32 [0,1], exactly vertexCount*4 long. */
export function uvRegionsToFloat(uvRegions, vertexCount) {
  const n = vertexCount * 4;
  if (uvRegions.length < n) {
    throw new Error(`uv-region has ${uvRegions.length / 4} entries for ${vertexCount} vertices`);
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = uvRegions[i] / 65535;
  return out;
}
