# Changelog

## 0.1.0 — unreleased

### Added

- Web Mercator I3S scene-layer support: load a `wkid` 102100/3857/102113/900913 scene layer that stock CesiumJS 1.138 refuses with `Unsupported spatial reference`. See `docs/01-web-mercator-i3s.md`.
- Atlas UV remap: per-pixel remap of tiling atlas facade UVs into their region, replacing the stock per-vertex crop. See `docs/02-atlas-uv.md`.
- Gradient-correct mip selection for atlas-remapped textures, avoiding both tile-boundary seams and moiré on minified surfaces. See `docs/03-mip-shimmer.md`.
- Measured I3S tileset defaults and a visibility-driven layer loader that only loads layers actually shown. See `docs/04-layer-loading-and-cache.md`.
- `cesium-i3s-build-worker` / `cesium-i3s-verify-worker` CLIs: build the patched `decodeI3S.js` against a consumer's installed `@cesium/engine` and verify a served worker file is the patched one, not a silent fallback to stock.
- Local demo (`npm run demo`) comparing stock CesiumJS against this package on three public ArcGIS Online scene layers, with a swipe comparison view. See `demo/SOURCES.md`.

### Fixed

- De-indexing: `uv-region` now survives the vertex expansion `generateNormals` can trigger, mirroring the same index-driven expansion applied to `uv0`/`positions` so the atlas region and vertex stay in sync instead of silently mismatching.
- Extent reprojection now runs at layer construction (`I3SLayer._computeExtent`, called from the constructor before `load`), not just from `load` — `I3SDataProvider.fromUrl` unions extents before calling `load` on any layer, so a fix applied only inside `load` was one step too late for the provider's own `extent`.
- Atlas shader guard: the `_UV_REGION_0` remap is wrapped in `#ifdef HAS_BASE_COLOR_TEXTURE` so an untextured primitive sharing an atlas layer no longer fails shader compilation and takes down the entire scene's rendering.
- A `load()` that throws synchronously is now normalised into the same rejection path as one that returns a rejected promise, so a caller's `.catch` or `onStatus` handler sees every failure the same way.

### Known issues

- Building Scene Layer extent: `I3SDataProvider` pushes `fullExtent` directly into `provider._layersExtent` for this path rather than going through `I3SLayer._computeExtent`, so the extent-reprojection fix does not run for it.
- The Boston demo layer's normal-map and metallic-roughness textures fail to load at all under stock CesiumJS 1.138 (every tile errors in `GltfLoader`), unrelated to anything this package changes; the demo drops both texture references before rendering, on both halves of the comparison.
- Duplicate-engine override needed for `cesium@1.138.0` consumers: `cesium`'s own `package.json` declares a `^14.3.0` range for `@cesium/widgets` that npm can resolve to a version depending on `@cesium/engine@24`, producing two copies of `@cesium/engine` in `node_modules` and a silently blank `Viewer`. Add the `@cesium/widgets: 14.3.0` override/resolution to your own project — this package's own `overrides` field only protects installs inside this repo. See `README.md` § Compatibility.
