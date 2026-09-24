# Layer loading and cache tuning

## Problem

A scene with several I3S building layers, most of them hidden behind a layer-picker UI until the user turns them on, consumes far more GPU memory than the layers actually being shown account for — one building layer measured at roughly 393 MB of GPU memory on its own. A user who never shows most of the layer list still pays for all of them.

Separately, tall buildings loaded at `I3SDataProvider`'s default tileset options resolve to visibly low-poly, faceted cylinders instead of round ones.

## Cause

Two independent causes, addressed by two independent changes:

- **Loading every configured layer regardless of visibility.** The straightforward way to build a togglable layer list — create every `I3SDataProvider`, add every one to `viewer.scene.primitives`, and toggle `.show` — fetches, Draco-decodes, and uploads every layer's geometry to the GPU whether or not it is ever shown. `.show = false` stops Cesium from *drawing* a tileset; it does not stop that tileset from occupying GPU memory once loaded.
- **`I3SDataProvider`'s default `maximumScreenSpaceError` (16) is tuned for terrain and general meshes, not tall thin building geometry.** At the default, a cylindrical column (a support pillar, a rounded tower corner) selects a coarser LOD than at a lower SSE, and renders with visibly fewer facets.

## Fix

**`i3sTilesetDefaults`** (`src/tuning/index.ts`) — a small set of `Cesium3DTileset` constructor options to spread into `cesium3dTilesetOptions` when calling `I3SDataProvider.fromUrl`:

```ts
export const i3sTilesetDefaults = Object.freeze({
  maximumScreenSpaceError: 8,
  cacheBytes: 768 * 1024 * 1024,
  maximumCacheOverflowBytes: 512 * 1024 * 1024,
});
```

- `maximumScreenSpaceError: 8` (half the I3S default of 16) fixes the faceted-cylinder appearance. Measured on a roughly 100-node layer, 8 vs 16 produced byte-identical GPU memory — the extra geometric detail was free there. Raise it further only with your own measurement on a genuinely large layer; this default does not claim to generalise to every layer size.
- `cacheBytes` / `maximumCacheOverflowBytes` are set generously (768 MB / 512 MB). See the measurement below for why these are set *high*, not low.

**`createVisibilityLoader`** (`src/tuning/index.ts`) — the change that actually addresses the memory problem. It wraps a set of layer definitions (`{ id, visible, load(), setShown(handle, shown) }`) and:

- loads only the layers whose `visible` starts `true` (or is left undefined) on `init()`;
- loads a hidden layer the first time it's shown, not before;
- tracks per-layer status (`'deferred' | 'loading' | 'loaded' | 'failed'`) so callers can render a loading/error state instead of guessing;
- normalises a `load()` that throws synchronously into the same rejection path as one that returns a rejected promise, so a caller's `.catch` or `onStatus` handler sees every failure the same way;
- leaves a layer that failed to load at `'failed'` rather than retrying it on every subsequent `setVisible` call — a caller that wants a retry removes the layer (`remove(id)`) and re-adds it.

Layers the user never shows are never fetched, decoded, or uploaded at all — the 393 MB per hidden layer in the Cause section is memory this loader simply never spends.

## What did not help — measured, not assumed

Before landing on "don't load hidden layers," several other tuning knobs were tried against the same layers and measured, not just reasoned about:

| Change tried | Measured result |
|---|---|
| Raising `cacheBytes` / `maximumCacheOverflowBytes` | No reduction in steady-state memory. These bound the tileset's *own* geometry cache, which was never the source of the extra memory — the extra memory was whole hidden layers being loaded at all. |
| Raising `maximumScreenSpaceError` (coarser LOD) beyond the default | No reduction in steady-state memory on the layers measured, at the cost of visibly worse geometry (the faceted-cylinder problem this doc's `maximumScreenSpaceError: 8` default fixes in the *other* direction). |
| **Capping `cacheBytes` *below* the layer's working set** | **Harmful.** Capping it at 128 MB against a roughly 193 MB steady-state working set made the tileset evict and refetch continuously: redundant geometry fetches rose from roughly 17× to roughly **185×**, each refetch re-paying a full Draco decode. A cache cap that undershoots the working set does not save memory — it converts a memory problem into a request-storm and CPU-decode problem, and makes both worse than doing nothing. |
| `skipLevelOfDetail` | No memory or triangle-count reduction measured; more request churn. Removed. |
| `progressiveResolutionHeightFraction` | Same as above — no measured benefit, more request churn. Removed. |

The plain conclusion: `cacheBytes` and screen-space-error knobs tune *how a single loaded layer's tiles are cached and refined*. They cannot reduce memory spent on layers that shouldn't have been loaded in the first place, and pushing them the wrong way (capping the cache below the working set) actively hurts. The fix that measured a real reduction was not loading hidden layers at all, which is what `createVisibilityLoader` does.

## Limits

- `i3sTilesetDefaults`'s numbers were measured against building-scale I3S layers (tens to low hundreds of nodes, individual buildings and small clusters). They are a documented starting point, not a universal answer — re-measure before assuming they hold for a very large layer (city-scale, thousands of nodes) or a non-building I3S layer (terrain, meshes), where the I3S team's own defaults may already be closer to correct.
- `createVisibilityLoader` holds one `handle` per layer in memory for the life of the loader (until `remove(id)` is called); it does not itself evict a *loaded* layer's GPU memory when hidden — that's the caller's `setShown` to implement, if wanted (the demo's `unloadPlace` in `demo/main.ts` shows one way, destroying and reloading a whole place rather than hiding it, because it holds more than one layer resident at once).
- Status tracking is per layer id, not per node or per tile — it answers "is this layer usable yet," not "how much of this layer has streamed in."
