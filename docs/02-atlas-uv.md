# Atlas UV remap

## Problem

On an I3S 3DObject scene layer whose materials use a texture atlas with tiling per-face UVs — Esri's authoring tools (CityEngine, ArcGIS Pro) can produce these — building facades render with visible seams, texture bleed across atlas tile boundaries, or the wrong atlas tile entirely. The symptom looks like a texture-packing bug in the source data; it is not — the same layer packs and atlases correctly in Esri clients.

## Cause

The atlas mechanism: each face's `uv0` may run outside `[0,1]` (deliberately — the source geometry was authored to tile a texture), and a separate per-vertex `uv-region` attribute (4 × `UInt16`, `[0,1]` atlas space) says which sub-rectangle of the shared atlas texture that face's tile lives in.

Stock `decodeI3S.js` handles this with `cropUVs` (`decodeI3S.js:186-202`), called from `decodeAndCreateGltf` (`decodeI3S.js:1552`): for every vertex it scales and offsets `uv0` by that vertex's `uv-region` once, in the worker, and bakes the result into the glTF's `uv0` accessor. `uv-region` itself is then discarded — nothing carries it forward to the main thread.

That bake has two problems:

1. **It's a linear scale, not a wrap.** `cropUVs` computes `region.min + uv0 * regionSize`, which is only correct for `uv0` in `[0,1]`. A tiling face's `uv0` of, say, `3.4` lands 3.4 region-widths from the region's origin — inside a neighbouring atlas tile. That is the cross-region bleed stock CesiumJS shows on these layers (`AtlasMode` 0 in `src/atlas/index.ts`).
2. **The repeat count can't be recovered downstream.** Once the scaled result is baked into the vertex buffer, the fact that the face was authored to tile its region is gone. The naive alternative — skip `cropUVs`, keep raw `uv0`, and sample the texture directly — ignores the region entirely and samples across the whole atlas texture instead of one tile: the atlas smear of `AtlasMode` 1. That is also what the patched worker below produces on its own, if the shader is not attached.

## Fix

Two coupled halves, both required — same shape as the Web Mercator fix in [01-web-mercator-i3s.md](01-web-mercator-i3s.md).

**Worker half** (`worker/patched/decodeI3S.js`): removes the `cropUVs` call and instead forwards `uv-region` alongside `uv0` all the way to the glTF the worker builds, as a new vertex attribute `_UV_REGION_0` (`VEC4`, `Float32`, values in `[0,1]`, `worker/src/workerMath.js`'s `uvRegionsToFloat`). `uv0` itself is left raw — un-cropped, still potentially outside `[0,1]`.

- **De-indexing fix.** `generateNormals` (`decodeI3S.js:551`) can de-index the mesh — expanding indexed `positions`/`uv0`/`colors` into a flat, unindexed vertex stream when it needs to split vertices for hard-edge normals. Before this package, `uv-region` had no equivalent de-indexing step, so if `generateNormals` ran, the (unmodified) `uv-region` array and the (expanded) `uv0`/`positions` arrays would go out of sync — wrong regions for wrong vertices. `worker/src/workerMath.js`'s `expandUvRegions` mirrors the exact index-driven expansion `generateNormals` applies to `uv0`, so `uv-region` survives de-indexing in step with the rest of the vertex data. The naive approach — feed the original `uv-region` straight through regardless of whether de-indexing ran — is a correctness bug, not a simplification: it silently mismatches attribute and vertex on any node that triggers `generateNormals`, without any error.
- **Count matching.** `generateGltfBuffer` (`decodeI3S.js:626`) sizes the `_UV_REGION_0` accessor to `meshPositions.length / 3` — the `POSITION` accessor's vertex count — not the raw `vertexCount` parameter, because after de-indexing the effective vertex count is `indices.length`, not the original count. Sizing `_UV_REGION_0` to anything else produces an accessor whose `count` disagrees with `POSITION`'s, which Cesium's glTF validation rejects.

**Main-thread half** (`attachAtlasShader`, `src/atlas/index.ts`): a `CustomShader` fragment stage that reads `texCoord_0` (raw `uv0`) and `uv_region_0` (the `_UV_REGION_0` attribute, as Cesium exposes custom vertex attributes to a `CustomShader`) and remaps per **fragment**, not per vertex:

```glsl
atlasUV = region.xy + fract(rawUV) * regionSize;
```

`fract()` on the raw, un-cropped `uv0` reproduces the tiling the source data was authored for, and because the wrap happens per fragment, every fragment's UV lands inside its face's region, whatever the face's `uv0` range.

**Both halves are mandatory together, in both directions.** Once the patched worker is served, every `I3SDataProvider` must get `attachAtlasShader` — the worker no longer crops UVs, so an atlas layer without the shader samples the whole atlas texture, even a layer whose `uv0` are all inside `[0,1]` (those still needed mapping into their region). Conversely, `attachAtlasShader` against a stock worker finds no `uv_region_0` attribute and changes nothing.

`attachAtlasShader` attaches the shader **unconditionally** to every sublayer tileset. This is deliberate, not sloppy: Cesium's `CustomShaderPipelineStage` gates a shader's use of a given vertex attribute *per primitive*. A primitive with no `_UV_REGION_0` attribute — every primitive from a non-atlas layer, and any primitive within an atlas layer that happens to carry no atlas UVs — finds no inferred default for that attribute, so Cesium disables the shader's use of it for that primitive and it renders with its ordinary material, unaffected. Gating the shader at the tileset level instead would also strip it from the atlas primitives that do need it, for no benefit.

The fragment stage is further guarded with `#ifdef HAS_BASE_COLOR_TEXTURE` (only defined by `MaterialStageFS` when the primitive's material has a base-colour texture). A primitive can carry `uv_region_0` — because it belongs to an atlas layer — with no base-colour texture of its own (an untextured material sharing the layer). Without the guard, referencing `u_baseColorTexture` on such a primitive would fail shader compilation and stop CesiumJS rendering the *entire* scene, not just that primitive.

## Honest scope

The remap only changes pixels on primitives that both carry `uv_region_0` *and* have per-face `uv0` outside `[0,1]`. Measured directly (`scripts/find-tiling-uv-layers.mjs`, methodology in `demo/SOURCES.md`) against the three layers the demo compares:

| Layer | Atlas-textured, tiling UVs | Effect of this fix |
|---|---|---|
| Boston Dot Ave (CityEngine example) | ~57–63% of sampled atlas vertices have `uv0` outside `[0,1]` (62.6% of 204,030 sampled vertices across 3 nodes; ~57% with a duplicate-counted node corrected) | Visibly different: fixes the cross-region bleed shown in the README's before/after |
| San Francisco 3D Buildings | 0% | No-op — renders identically with and without this fix |
| Southgate 3D Buildings (Wellington) | 0% | No-op — renders identically with and without this fix |

The San Francisco and Southgate results aren't a gap in the fix; they show it doesn't regress layers that don't need it — both declare `textureSetDefinitions[].atlas: true` and carry `uv-region` data, so the shader is attached and running on them, it just has nothing to remap because every sampled `uv0` was already inside `[0,1]`.

## Limits

- The fix requires the worker half from this package — see [README.md § Worker setup](../README.md#worker-setup). Without it, `uv_region_0` never reaches the primitive and the shader does nothing (guarded by Cesium's per-primitive attribute gating, described above — it does not break rendering, it just has no effect).
- Mip selection for `atlasUV` is a separate concern, covered in [03-mip-shimmer.md](03-mip-shimmer.md) — this document is about *which* texel is sampled, not which mip level.
- Only `_UV_REGION_0` (texture coordinate set 0) is handled. I3S's `uv-region` mechanism is defined per material's base-colour UV set; this package does not extend it to other texture slots.
