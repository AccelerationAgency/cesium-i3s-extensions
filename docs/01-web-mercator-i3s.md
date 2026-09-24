# Web Mercator I3S scene layers

## Problem

Loading an I3S scene layer whose service declares a Web Mercator spatial reference (Esri `wkid` 102100, or its aliases 3857 / 102113 / 900913) fails immediately:

```
RuntimeError: Unsupported spatial reference: 102100
```

The layer never draws. There is no partial or degraded result — `I3SLayer.load` rejects before any geometry request is made.

## Cause

CesiumJS's I3S pipeline assumes WGS84 degree offsets end to end, with no projection step anywhere in it. Five places in `@cesium/engine` 22.3.0 depend on that assumption:

1. **`I3SLayer.prototype.load`** (`I3SLayer.js:180-183`) — the guard itself: throws unless `this._data.spatialReference.wkid === 4326`.
2. **`I3SLayer.prototype._computeExtent`** (`I3SLayer.js:371`) — called synchronously from the `I3SLayer` constructor (`I3SLayer.js:65`), i.e. before `load` ever runs. `I3SDataProvider.fromUrl` unions every layer's resulting `_extent` into `provider._extent` (`I3SDataProvider.js:469-476`, `798-812`) and calls `provider._computeExtent()` (`I3SDataProvider.js:563`) *before* calling `load` on any layer (`I3SDataProvider.js:566-573`). A fix applied only inside `load` is one step too late for the provider's own `extent` property.
3. **`I3SNode.prototype._create3DTileDefinition`** (`I3SNode.js:439-457`) — builds each node's geographic centre with `Cartographic.fromDegrees(obb.center[0], obb.center[1], obb.center[2])` (or `mbs[0..2]`), treating the stored numbers as longitude/latitude degrees.
4. **`I3SDecoder.decode`** (`I3SDecoder.js:~90-106`) — builds the `cartographicCenter` passed to the decode worker the same way, from the same `mbs` / `obb.center`.
5. **`decodeI3S.js`** (the decode worker) — applies that cartographic center to *every vertex* as `longitude + toRadians(scale_x * pos[x])`, `latitude + toRadians(scale_y * pos[y])`.

For a Web Mercator service, the quantities Cesium reads at every one of those five points are metres, not degrees. Simply deleting the guard in (1) does not produce a working layer — it produces geometry offset by whatever `scale_x`/`scale_y` factor Cesium computes for a degree-sized offset applied to a metre-sized number, which is garbage at any zoom level.

## Fix

Two coupled halves, both required.

**Main-thread half** (`installProjectedI3SSupport`, `src/projected/index.ts`): a runtime monkey-patch, no Cesium source edits.

- Wraps `I3SLayer.prototype._computeExtent` *and* `I3SLayer.prototype.load` to call an idempotent `prepareLayer()` first. `prepareLayer` relaxes the wkid guard (sets `spatialReference.wkid` and `latestWkid` to `4326`), reprojects the layer's own extent (`store.extent`, `fullExtent`) from Web Mercator metres to WGS84 degrees, and stamps a `__projectedWkid` marker onto `store.defaultGeometrySchema`. It has to run from `_computeExtent`, not just `load`, for the reason in Cause item 2 above; `_computeExtent` is idempotent so the duplicate call from the `load` wrap is a no-op once the wkid has already been rewritten to 4326.
- Wraps `I3SNode.prototype._create3DTileDefinition` to reproject that node's `mbs` / `obb.center` in place before the original implementation runs, fixing Cause items 3 and 4 at once (both read the same fields).
- The marker rides on `defaultGeometrySchema` because that object is parsed from the layer JSON — this module owns it — and Cesium forwards it to the decode worker verbatim as `payload.schema`, the only field crossing that boundary under this package's control.

**Worker half** (`worker/patched/decodeI3S.js`, math in `worker/src/workerMath.js`): reads the `__projectedWkid` marker off `payload.schema` and, if present, folds a degrees-per-metre factor into `scale_x` / `scale_y` — the same knob the worker already applies to every vertex offset, so no other part of the decode path changes.

**The patched worker also carries the atlas UV change** ([02-atlas-uv.md](02-atlas-uv.md)) — it is one file, so serving it for Web Mercator support means serving that change too. Once it is served, every `I3SDataProvider` must get `attachAtlasShader`, Web Mercator or not: the worker no longer crops atlas UVs into their region, so without the shader an atlas layer samples the whole atlas texture even when its UVs are in range. (And the other way round: the shader against a stock worker has nothing to read and does nothing.)

### Why the scale factor is a per-node constant

Web Mercator is conformal, so its inverse linearises cleanly over the extent of one node (a building, a city block):

```
X = R·λ                     ⇒  dλ/dX = 1/R          (latitude-independent)
Y = R·ln(tan(π/4 + φ/2))    ⇒  dφ/dY = cos(φ)/R
```

so `degPerMetreX = 180/(π·R)` and `degPerMetreY = cos(φ)·180/(π·R)`, evaluated once per node at that node's cartographic centre latitude `φ`. This also cancels Web Mercator's own `1/cos(φ)` scale distortion automatically: a ground distance `d` is stored as `d/cos(φ)` projected metres, and `dφ/dY · d/cos(φ) = d/R` — the correct ground angle. Linearisation error across a single node is far below vertex precision.

## Limits

- Gated on the layer's `spatialReference.wkid` being one of `102100`, `3857`, `102113`, `900913`. A layer already at 4326 is untouched.
- Node bounding-volume reprojection (`mbs`, `obb.center`) is additionally gated on the stored values being *impossible* as degrees (`|lon| > 180` or `|lat| > 90`). The I3S spec says node bounding volumes are WGS84 even for a projected layer, but publishers disagree in practice, so this only converts values that cannot already be geographic — a layer that follows the spec is left alone.
- If a layer declares a Web Mercator `wkid` but has no `store.defaultGeometrySchema` to carry the marker, the patch refuses to relax the guard and logs an error instead: without the marker there's no way to signal the worker, and rendering garbage geometry silently is worse than the layer continuing to fail loudly.
- **Building Scene Layer path is not covered.** For that path `I3SDataProvider` pushes `fullExtent` directly into `provider._layersExtent` rather than going through `I3SLayer._computeExtent`, so this patch's extent reprojection does not run for it.
- The patch is a no-op — not an error — if a future Cesium release renames `I3SLayer.prototype.load`, `_computeExtent`, or `I3SNode.prototype._create3DTileDefinition`: `installProjectedI3SSupport` checks for all three before installing anything and logs a warning instead of patching a namespace it doesn't recognise. Web Mercator layers keep failing with the original `Unsupported spatial reference` error in that case, exactly as they would without this package.
