# Upstream PR draft: I3S texture atlas regions

- **Branch:** `i3s-atlas-uv-region` (local clone, branched from tag `1.138`, three commits; squash on release day if preferred)
- **Target:** `CesiumGS/cesium` `main` (rebase onto `main` on release day)
- **Requires CLA signature:** yes. Sign the Cesium Contributor License Agreement (individual, or corporate for the company) before opening the PR.
- **Approach:** built into the standard material path (`MaterialPipelineStage` / `MaterialStageFS`). No `CustomShader` is needed.

## Title

Apply I3S texture atlas regions per fragment

## Description

### Problem

Some I3S 3D Object layers pack their textures into atlases. Each vertex carries a `uv-region` (min u, min v, max u, max v, as `UInt16`) that selects its texture within the atlas, and its `uv0` can go outside `[0, 1]` so that the texture repeats within that region, for example across a row of windows. Esri CityEngine exports layers like this.

`decodeI3S.js` handles `uv-region` in `cropUVs`. For each vertex it scales `uv0` into the region once, bakes the result into `TEXCOORD_0`, and then discards the region. That goes wrong in two ways:

1. **The repeat is lost.** A `uv0` of 3.4 means "repeat this region 3.4 times". Once it has been scaled into the region per vertex, it becomes a coordinate outside the region, and the sampler wraps it across the whole atlas.
2. **Interpolation crosses regions.** Interpolating per-vertex atlas coordinates across a triangle whose coordinates span more than one repeat samples the neighboring textures in the atlas.

The result is facades with textures from the wrong part of the atlas, bleed between atlas regions, and misaligned tiling. Before and after, using the same approach through a `CustomShader`:

- Before (stock CesiumJS 1.138): `docs/img/atlas-before.png`
- After: `docs/img/atlas-after.png`
- Side by side: `docs/img/demo-split.png`

(Upload these images to the PR. They show the public Boston Dot Ave CityEngine example layer.)

**Caveat:** these images come from the `CustomShader` version of the same remap. That version writes only `material.diffuse` from the atlas sample, so it ignores texture alpha and `baseColorFactor`. The built-in path in this PR keeps both, so it may look different where a material has a non-white `baseColorFactor` or a texture with alpha. Before opening the PR, check the built-in path live in the `i3s-texture-atlas` Sandcastle with a GPU browser, and replace the images with screenshots of it.

### Fix

**Worker (`decodeI3S.js`)**

- Remove `cropUVs`. `TEXCOORD_0` keeps the raw texture coordinates.
- Emit the regions as an `_I3S_UV_REGION_0` vertex attribute (`VEC4`, float, normalized to `[0, 1]`). This happens only when the geometry has `uv0`.
- `generateNormals` de-indexes positions, `uv0` and colors when it generates flat normals. The regions are now expanded through the same indices, so they stay aligned with their vertices. Without this, a node that goes through `generateNormals` would pair regions with the wrong vertices, and nothing would report an error.
- The `_I3S_UV_REGION_0` accessor count equals the `POSITION` accessor count (`meshPositions.length / 3`), not the incoming `vertexCount`. When indices survive to `generateGltfBuffer`, `vertexCount` is the index count.
- If a node has fewer regions than vertices, the regions are left out rather than paired with the wrong vertices. The worker reports this in its result, and `I3SDecoder` logs a one-time warning on the main thread (`oneTimeWarning("i3s-uv-region-length", ...)`), because `oneTimeWarning` is not available in workers. Without the warning, the texture coordinates would silently render as raw repeating coordinates.

**Material stage**

- `MaterialPipelineStage` adds `HAS_BASE_COLOR_TEXTURE_UV_REGION` only when the primitive has **both** a base color texture on `TEXCOORD_0` **and** an `_I3S_UV_REGION_0` attribute, and textures are not disabled (they are disabled for classification). Primitives without a base color texture keep their current shader. This matters because an atlas layer can contain untextured materials, and those primitives still get `_I3S_UV_REGION_0`.
- `MaterialStageFS` applies the remap per fragment, after `KHR_texture_transform`:

  ```glsl
  vec2 regionSize = uvRegion.zw - uvRegion.xy;
  vec2 atlasTexCoord = uvRegion.xy + fract(texCoord) * regionSize;
  vec2 dx = dFdx(texCoord) * regionSize;
  vec2 dy = dFdy(texCoord) * regionSize;
  return textureGrad(textureSampler, atlasTexCoord, dx, dy);
  ```

  `fract()` is discontinuous wherever the texture repeats, so implicit derivatives of `atlasTexCoord` spike at those edges, the GPU picks the coarsest mip, and a dark seam appears once per repeat. Pinning mip level 0 avoids the seam but causes moiré on minified surfaces such as roofs seen at a shallow angle. Gradients taken from the continuous input coordinates and scaled into the region give the true footprint. On WebGL 1 the stage uses `texture2DGradEXT` when `EXT_shader_texture_lod` is available, and otherwise falls back to `texture()`.

The GLSL varying is `v_i3s_uv_region_0`, which `GeometryPipelineStage` already declares for any custom attribute.

### Behavior changes to call out for review

- I3S geometry that has `uv-region` no longer has pre-cropped `TEXCOORD_0`. Built-in rendering is correct because of the material stage change. A user `CustomShader` that samples `u_baseColorTexture` with `texCoord_0` on such a layer now gets raw, repeating coordinates, and can use `attributes.i3s_uv_region_0` to do the same remap.
- The attribute is named `_I3S_UV_REGION_0`, and only the I3S decoder creates it. The material stage enables the remap only for that name, so ordinary glTF models, including ones with application-specific attributes such as `_UV_REGION_0`, render exactly as before. The worker and the material stage share the name through `MaterialPipelineStage.UV_REGION_ATTRIBUTE_NAME`.

### Alternative considered

The same result can be had without touching the material system: ship only the worker change (which exposes the regions as an attribute) and do the remap in a Sandcastle `CustomShader`. That is how the standalone package works today. The built-in approach was chosen because it fixes rendering for every I3S user by default, it only enables the remap where a base color texture and `_I3S_UV_REGION_0` both exist, and the change to the material stage is small (one define and one sampling helper).

### How tested

Locally, on the `1.138` base. `ChromeHeadlessGL` is a local, uncommitted Karma launcher (headless Chrome with SwiftShader), because plain `ChromeHeadless` could not initialize WebGL on the test machine. Results are for the branch head (all three commits) unless noted.

- `npm run test -- --browsers ChromeHeadlessGL --includeName "Scene/I3S" --failTaskOnError --suppressPassed`: 125/125 pass (121 existing plus 4 new).
- `npm run test -- --browsers ChromeHeadlessGL --includeName "Scene/Model/MaterialPipelineStage" --failTaskOnError --suppressPassed`: 34/34 pass on WebGL 2 (28 existing plus 6 new). The render spec passing also confirms that the renamed varying `v_i3s_uv_region_0` matches what `GeometryPipelineStage` declares.
- Checked at the first commit, before the rename:
  - The same MaterialPipelineStage specs with a WebGL 1 context (a throwaway local edit, not committed): all pass, so the WebGL 1 shader path compiles and renders.
  - `--includeName "Scene/Model/"` (1058 specs): 6 failures. The same 6 fail on the unmodified `1.138` tag in this environment (Draco model, `.pnts` styling/normals, distance display condition). No new failures.
  - With the source changes stashed, 4 of the new specs fail: 2 in `I3SDecoderSpec` and 2 in `MaterialPipelineStageSpec` (the define spec and the uv-region render spec).
- `npx prettier --check` on all 9 changed files, including `MaterialStageFS.glsl` and the Sandcastle: "All matched files use Prettier code style!". `npx eslint` on the changed `.js` files: exit 0.
- `npm run build` succeeds. The Sandcastle gallery list builds (`npm run build-gallery`). Cesium's pre-commit hook (lint-staged: `tsc`, eslint, prettier) passed on every commit.

New specs:

- `I3SDecoderSpec` (real decode worker): `TEXCOORD_0` is no longer cropped (`[0, 0, 2.5, 0, 0, 3]` round-trips). `_I3S_UV_REGION_0` is a float `VEC4` normalized from `UInt16`, and its count equals `POSITION`, including when flat normals are generated. Complete regions do not set the incomplete flag.
- `I3SDecoderSpec`: when the worker reports incomplete regions, `I3SDecoder.decode` warns exactly once across two decodes.
- `MaterialPipelineStageSpec`: the define is added only with a base color texture and uv regions. It is not added without uv regions, without a base color texture, or for classification models.
- `MaterialPipelineStageSpec` (render): a glTF of three orthogonal quads, a 2x1 red/green atlas, texture coordinate `(1.25, 0.5)` and region `(0.5, 0, 1, 1)` renders green; stock sampling of the same coordinate renders red.

Not covered by specs:

- The de-indexing expansion inside `generateNormals` only runs for indexed (Draco) geometry, and the specs use uncompressed geometry. The standalone package covers that expansion with a unit test of the same logic.
- Uncompressed geometry cannot produce too few regions, so the warning spec stubs the worker result.
- The built-in path has not yet been checked against a live atlas layer in a browser (see the caveat above).

### Sandcastle

`packages/sandcastle/gallery/i3s-texture-atlas` loads the Boston Dot Ave CityEngine example layer. Its materials also reference normal and metallic-roughness textures that CesiumJS 1.138 does not load: every tile fails in `GltfLoader`, with or without this change. The Sandcastle removes those references before it adds the provider. That failure is a separate issue and should be filed on its own. If it is fixed first, remove the workaround from the Sandcastle.

### Applies to current `main`?

Not cleanly. `git merge-tree --write-tree origin/main i3s-atlas-uv-region` reports one content conflict, in `MaterialStageFS.glsl` (checked 2026-09-23). Since 1.138, `main` has added a constant-LOD branch to `getBaseColorFromTexture`. To resolve it, add the uv-region case to that `#if` chain:

```glsl
vec4 baseColorWithAlpha;
#if defined(HAS_BASE_COLOR_CONSTANT_LOD) && defined(HAS_CONSTANT_LOD)
    ...
#elif defined(HAS_BASE_COLOR_TEXTURE_UV_REGION)
    baseColorWithAlpha = czm_srgbToLinear(sampleTextureInUvRegion(u_baseColorTexture, baseColorTexCoords, v_i3s_uv_region_0));
#else
    baseColorWithAlpha = czm_srgbToLinear(texture(u_baseColorTexture, baseColorTexCoords));
#endif
```

`main` has also renamed `computeTextureTransform` to `czm_computeTextureTransform`. `MaterialPipelineStage.js`, `decodeI3S.js`, `I3SDecoder.js` and the specs merge automatically (rechecked after the rename commit). This branch also conflicts trivially with `i3s-web-mercator` in `I3SDecoderSpec.js`, because both add specs at the same place.

### CHANGES.md (add on release day, under `@cesium/engine` Fixes)

```
- Fixed I3S layers with texture atlases sampling textures from the wrong part of the atlas when texture coordinates repeat within an atlas region. [#XXXXX](https://github.com/CesiumGS/cesium/pull/XXXXX)
```
