# Gradient-correct mip selection

## Problem

Once atlas UVs are remapped per fragment (see [02-atlas-uv.md](02-atlas-uv.md)), a naive implementation that just calls `texture(u_baseColorTexture, atlasUV)` with the wrapped, per-tile `atlasUV` produces one of two visible failures depending on how mip selection is handled, both worse than either extreme they're trading off against:

- A **dark seam** appears once per tile period across tiling geometry (repeating window rows on a facade, for example) — a grid of faint-to-visible dark lines exactly where the atlas UV wraps.
- Or, if mip selection is disabled instead, large flat surfaces seen at a distance or at a shallow angle (a roof, a long facade in the distance) show **moiré** — shimmering, aliased texture noise that changes as the camera moves, instead of settling into a smooth minified texture.

## Cause

`texture()` in GLSL doesn't take an explicit mip level; the GPU derives one automatically from the screen-space derivative of the UV coordinate passed in, computed per 2×2 fragment quad via `dFdx`/`dFdy`. `atlasUV` is built from `fract(rawUV) * regionSize + region.xy` — and `fract()` is discontinuous at every integer boundary of `rawUV`, i.e. at every tile edge. Where a 2×2 fragment quad straddles that discontinuity, `dFdx(atlasUV)` (computed automatically from the wrapped value) spikes to roughly the width of the whole atlas region in one fragment step. The GPU reads that as "this texture is extremely minified here" and picks the coarsest available mip level — hence the dark, blurry line exactly at tile boundaries, and nowhere else.

Pinning the mip level instead (`textureLod(u_baseColorTexture, atlasUV, 0.0)`) removes the derivative-spike problem — there's no automatic derivative to spike — but throws away mipmapping altogether. A minified surface (a roof plane viewed obliquely, or any facade far from the camera) then samples the full-resolution mip 0 texture with no anti-aliasing, which is exactly the moiré failure.

Neither extreme is usable on typical building geometry, which has both tiling facades (fine mip granularity needed at the tile edges) and large minified surfaces (correct mip selection needed away from any edge).

## Fix

The custom fragment shader (`src/atlas/index.ts`) computes its own derivatives from the **pre-wrap** UV — `rawUV`, before `fract()` — and scales them into atlas space explicitly, then supplies them to `textureGrad` instead of `texture`:

```glsl
vec2 ddx = dFdx(rawUV) * gradScale;   // gradScale = regionSize
vec2 ddy = dFdy(rawUV) * gradScale;
material.diffuse = czm_srgbToLinear(textureGrad(u_baseColorTexture, atlasUV, ddx, ddy)).rgb;
```

`dFdx(rawUV)`/`dFdy(rawUV)` are continuous across a tile boundary — `rawUV` itself doesn't wrap, only `atlasUV` does — so they carry the texture's true, continuous footprint on screen: how much of the texture one screen pixel actually covers, independent of which tile the fragment happens to land in. Multiplying by `regionSize` (the size of one atlas tile in atlas-UV space) rescales that footprint into the same space `atlasUV` lives in, which is what `textureGrad` needs to pick a correct mip level. `textureGrad` then uses these explicit, correct gradients instead of deriving (wrong) ones from the discontinuous `atlasUV` itself — eliminating both failure modes at once: no derivative spike at tile edges (there's no discontinuity in the gradients supplied), and no lost mipmapping on minified surfaces (the gradients still reflect true minification).

The shader also runs `czm_srgbToLinear` on the sampled colour explicitly. Cesium's own `MaterialStageFS` samples the base-colour texture through `czm_srgbToLinear` before this custom fragment stage would otherwise run; bypassing the normal sampling path (`textureGrad` instead of the material system's own call) means this shader has to replicate that conversion itself, or atlas-textured primitives would render visibly too bright ("gamma-lifted") relative to every other primitive in the scene.

## Limits

- This only changes mip *selection*, not which texel is sampled — see [02-atlas-uv.md](02-atlas-uv.md) for the remap itself. A layer whose atlas UVs never leave `[0,1]` (Cause: no tiling authored) is unaffected by either doc — `fract()` never triggers on such data, and the mip-selection fix, while always active, then has nothing but a continuous UV to compute correct derivatives from, same as stock Cesium.
- `textureGrad` requires GLSL derivative support (`dFdx`/`dFdy`), which WebGL2 (Cesium's minimum target) provides unconditionally; there's no fallback path for a hypothetical WebGL1-only context.
- Anisotropic filtering beyond what the sampler's own min/mag filter and the supplied gradients produce is not modelled separately — this fix picks a correct mip level and lets normal texture filtering handle the rest, it does not implement its own anisotropic sampling.
