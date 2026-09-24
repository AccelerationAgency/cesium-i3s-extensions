# Upstream PR draft: Web Mercator I3S scene layers

- **Branch:** `i3s-web-mercator` (local clone, branched from tag `1.138`, two commits; squash on release day if preferred)
- **Target:** `CesiumGS/cesium` `main` (rebase onto `main` on release day)
- **Requires CLA signature:** yes. Sign the Cesium Contributor License Agreement (individual, or corporate for the company) before opening the PR.

## Title

Support Web Mercator I3S scene layers

## Description

### Problem

`I3SDataProvider` cannot load an I3S scene layer whose spatial reference is Web Mercator (Esri wkid 102100, EPSG 3857, and the aliases 102113 / 900913). `I3SLayer.prototype.load` rejects it straight away:

```
RuntimeError: Unsupported spatial reference: 102100
```

Removing that guard on its own does not help. The I3S code path assumes WGS84 degree offsets from end to end and never projects anything:

1. `I3SLayer.prototype.load` has the wkid guard.
2. `I3SLayer.prototype._computeExtent` builds the layer extent with `Rectangle.fromDegrees` from `fullExtent` / `store.extent`. The `I3SLayer` constructor calls it before `load` runs, and `I3SDataProvider.fromUrl` combines the layer extents into `provider.extent` before it loads any layer.
3. For a Building Scene Layer, `I3SDataProvider` builds the extent from `fullExtent` with `Rectangle.fromDegrees` directly. That path never reaches `I3SLayer._computeExtent`.
4. `I3SNode.prototype._create3DTileDefinition` and `I3SDecoder.decode` both read `obb.center` / `mbs` as longitude and latitude in degrees.
5. The decode worker places every vertex at `center + toRadians(scale_x * x)`, `center + toRadians(scale_y * y)`, which treats the offsets as degrees.

In a Web Mercator layer, all five of these values can be in meters.

### Fix

- `I3SLayer` recognizes Web Mercator from `spatialReference.wkid` or `latestWkid`, and records it in the constructor (`_isWebMercator`), before `_computeExtent` runs. `load` accepts both 4326 and Web Mercator.
- A shared helper, `I3SLayer._extentToRectangle`, unprojects a Web Mercator extent with `WebMercatorProjection` (WGS84). `I3SLayer._computeExtent` uses it for `fullExtent` (honoring `fullExtent.spatialReference` when it is present) and for `store.extent`. `I3SDataProvider` uses the same helper for the Building Scene Layer `fullExtent`. As a result, `provider.extent` is correct for both layer types.
- `I3SNode.load` unprojects `obb.center` and `mbs` in place for Web Mercator layers, before the tile definition is built and before any decode request. That one change covers both the tile bounding volume and the worker's `cartographicCenter`.
- `I3SDecoder` sends `isWebMercator` in the worker payload. The worker then multiplies `scale_x` by `1/R` and `scale_y` by `cos(latitude)/R` (both converted to degrees). `scale_x` and `scale_y` are already applied to every vertex, so no other part of the decode path changes.

Why a per-node constant works: Web Mercator is conformal, so its inverse is effectively linear over one node.

```
X = R·λ                   ⇒  dλ/dX = 1/R
Y = R·ln(tan(π/4 + φ/2))  ⇒  dφ/dY = cos(φ)/R
```

The `cos(φ)` factor also cancels Web Mercator's `1/cos(φ)` scale distortion. A ground distance `d` is stored as `d/cos(φ)` projected meters, and `cos(φ)/R · d/cos(φ) = d/R`, which is the correct ground angle.

### Safety and scope

- Behavior changes only when a layer declares a Web Mercator wkid. Layers in 4326 follow exactly the same code path as before. The existing spec that expected wkid 3857 to be rejected now uses a projected CRS that remains unsupported (NZTM, 2193).
- Extents and node volumes are converted only when their values cannot be degrees (`|x| > 180` or `|y| > 90`). The I3S specification says node bounding volumes are WGS84 even for projected layers, but publishers do not all follow that. The range check makes the conversion idempotent, and it leaves spec-compliant layers alone.
- The range check misreads a Web Mercator coordinate within about 180 m (x) or 90 m (y) of (0°, 0°) as degrees, so it is not converted. Scene layers in that area of the Gulf of Guinea are not realistic, so this is negligible.
- The OBB `halfSize` and MBS radius keep their stored values. In a Web Mercator layer that stores volumes in meters, they are in projected meters, which overstates the ground size by `1/cos(φ)`. That makes the bounding volume larger than it needs to be, never smaller. It is conservative, but not tight.

### How tested

Locally, on the `1.138` base. The results are for the branch head, after the spec coordinate update:

- `npm run test -- --browsers ChromeHeadless --includeName "Scene/I3S" --webglStub --failTaskOnError --suppressPassed`: 136/136 pass (121 existing plus 15 new).
- The same specs with real WebGL (`--browsers ChromeHeadlessGL`, headless Chrome with SwiftShader through a local, uncommitted Karma launcher, because plain `ChromeHeadless` could not initialize WebGL on the test machine): 136/136 pass.
- With the source changes stashed and only the new specs kept (first commit), 13 of the new specs fail, so the specs do exercise the change.
- `npx prettier --check` on all 9 changed files: "All matched files use Prettier code style!". `npx eslint` on the same 9 files: exit 0.
- `npm run build` and `npm run build-ts` both succeed. Cesium's pre-commit hook (lint-staged, `tsc`) passed on both commits.

New specs:

- `I3SLayerSpec`: wkid recognition, including via `latestWkid`, and rejection of 4326, 2193, strings and `undefined`. Extent unprojection from a projected Wellington point (174.78°, −41.33°), with the result checked against an independent forward projection. A Web Mercator extent that is already in degrees is left as is. In-place node position unprojection runs once and is idempotent. Layer and provider extent come from a Web Mercator `fullExtent` and from `store.extent`; the extent values are those of the public Southgate 3D Buildings layer (Wellington, wkid 102100). An end-to-end load of a Web Mercator layer unprojects the root OBB centre. A WGS84 layer is not flagged.
- `I3SNodeSpec`: a Web Mercator child node's `mbs` stored in meters is unprojected, and the tile's bounding sphere center lands at the expected longitude and latitude. Volumes already in degrees are unchanged. A WGS84 layer's out-of-range values are left alone.
- `I3SDataProviderSpec`: a Building Scene Layer with a Web Mercator `fullExtent` produces a WGS84 `provider.extent`.
- `I3SDecoderSpec` (runs the real decode worker): 1000 projected meters at 60° latitude decode to about 500 m on the ground, both east-west and north-south. The same geometry on a non-Web Mercator layer is still treated as degrees.

No before/after image: stock CesiumJS draws nothing for these layers.

### Applies to current `main`?

Yes. `git merge-tree --write-tree origin/main i3s-web-mercator` merges cleanly (checked 2026-09-23; `main` was at the 1.146 release cycle). The specs have not been run on `main`.

This branch and `i3s-atlas-uv-region` both add specs to `I3SDecoderSpec.js` at the same place, so whichever lands second will get a trivial conflict there. The source files merge cleanly.

### CHANGES.md (add on release day, under the current release's `@cesium/engine` Additions)

```
- Added support for I3S scene layers in a Web Mercator spatial reference (wkid 102100, 3857). [#XXXXX](https://github.com/CesiumGS/cesium/pull/XXXXX)
```

CHANGES.md is left out of the commit because it would conflict with every release that happens before the PR is opened.
