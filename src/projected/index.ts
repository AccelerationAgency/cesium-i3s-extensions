// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC

/**
 * Web Mercator I3S support for Cesium.
 *
 * ## The problem
 *
 * `I3SLayer.prototype.load` hard-rejects any layer whose
 * `spatialReference.wkid !== 4326`:
 *
 *   Unsupported spatial reference: 102100
 *
 * That guard is load-bearing, not conservative. Cesium's I3S pipeline assumes
 * a WGS84 degree-offset encoding end to end, with no projection step anywhere:
 *
 *   1. `I3SLayer.load`            — the wkid guard itself.
 *   2. `I3SNode._create3DTileDefinition` — node centres via
 *      `Cartographic.fromDegrees(mbs[0], mbs[1], mbs[2])`.
 *   3. `I3SDecoder.decode`        — builds the worker's `cartographicCenter`
 *      from the same `mbs` / `obb.center`.
 *   4. the decode worker          — **every vertex** as
 *      `longitude + toRadians(scale_x * pos[x])`,
 *      `latitude  + toRadians(scale_y * pos[y])`.
 *
 * For a Web Mercator service those quantities are metres, so simply removing
 * the guard yields garbage geometry rather than a working layer.
 *
 * ## The fix
 *
 * Two coupled halves, both required (mirroring the atlas-UV workaround):
 *
 * **(a) This module** — a runtime monkey-patch, no Cesium source edits. It
 * relaxes the guard, reprojects node bounding volumes in place (which fixes
 * #2 and #3 at once, since both read the same `mbs` / `obb.center`), stamps a
 * `__projectedWkid` marker onto the layer's `store.defaultGeometrySchema`,
 * and reprojects the layer's own extent (`store.extent` / `fullExtent`).
 * That last piece has to run from `I3SLayer.prototype._computeExtent`, not
 * `load` — Cesium calls `_computeExtent` synchronously from the `I3SLayer`
 * constructor (`I3SLayer.js:65`), before `load` is ever invoked, and caches
 * the result on `this._extent`. `I3SDataProvider.fromUrl` then unions every
 * layer's `_extent` into `provider._extent` (`I3SDataProvider.js:563`)
 * before calling `load` on any layer (`I3SDataProvider.js:567-571`), so a
 * reprojection that only happens inside `load` is always one step too late —
 * `provider.extent` (and the internal `I3SLayer._extent` that feeds it)
 * would stay in projected metres even though the geometry itself renders
 * correctly.
 *
 * **(b)** the patched decode worker (`worker/patched/decodeI3S.js`) — reads
 * that marker off `payload.schema` and folds a degrees-per-metre factor into
 * `scale_x` / `scale_y`, which is exactly the knob the worker already applies
 * to every vertex. Guarded at build time by `cesium-i3s-verify-worker`.
 *
 * The marker rides on `defaultGeometrySchema` because that object is parsed
 * from the layer JSON (so we own it here) and Cesium forwards it to the worker
 * verbatim as `payload.schema` — the only field that crosses that boundary
 * under our control.
 *
 * ## Why the scale factor is a per-node constant
 *
 * Web Mercator is conformal, so its inverse linearises cleanly over one node:
 *
 *   X = R·λ                     ⇒  dλ/dX = 1/R          (latitude-independent)
 *   Y = R·ln(tan(π/4 + φ/2))    ⇒  dφ/dY = cos(φ)/R
 *
 * So `degPerMetreX = 180/(π·R)` and `degPerMetreY = cos(φ)·180/(π·R)`. This
 * also cancels Web Mercator's 1/cos(φ) scale distortion automatically: a
 * ground distance `d` is stored as `d/cos(φ)` projected metres, and
 * `dφ/dY · d/cos(φ) = d/R` — the correct ground angle. Linearisation error
 * across a single node (a building, a city block) is far below vertex
 * precision.
 *
 * ## Safety
 *
 * Every behaviour here is gated on a layer declaring a Web Mercator wkid, so
 * layers that work today are untouched. The bounding-volume reprojection is
 * additionally gated on the values being *impossible* as degrees
 * (|lon| > 180 or |lat| > 90) — the I3S spec says node volumes are WGS84 even
 * for a projected layer, and publishers disagree in practice, so we only
 * convert coordinates that cannot already be geographic.
 */

import { log } from '../log.js';

/** Semi-major axis used by Web Mercator (EPSG:3857 and its Esri aliases). */
export const WEB_MERCATOR_RADIUS = 6378137;

/** Degrees of longitude per metre of Web Mercator X. Latitude-independent. */
export const DEG_PER_METRE_X = 180 / (Math.PI * WEB_MERCATOR_RADIUS);

/**
 * Esri and EPSG spellings of Web Mercator that appear in the wild:
 *   102100 — Esri's WKID for WGS84 Web Mercator (Auxiliary Sphere)
 *   3857   — the EPSG code Esri reports as `latestWkid`
 *   102113 — the older Esri "Web Mercator" (major auxiliary sphere)
 *   900913 — the OSGeo/community code
 */
export const WEB_MERCATOR_WKIDS: ReadonlySet<number> = new Set([102100, 3857, 102113, 900913]);

/** True when `wkid` denotes a Web Mercator variant this module can reproject. */
export function isWebMercatorWkid(wkid: unknown): boolean {
  return typeof wkid === 'number' && WEB_MERCATOR_WKIDS.has(wkid);
}

/**
 * Degrees of latitude per metre of Web Mercator Y at a given latitude.
 *
 * @param latitudeDegrees Latitude of the node, in degrees.
 */
export function degPerMetreY(latitudeDegrees: number): number {
  return Math.cos((latitudeDegrees * Math.PI) / 180) * DEG_PER_METRE_X;
}

/**
 * Inverse Web Mercator: projected metres → geographic degrees.
 *
 * @returns `[longitudeDegrees, latitudeDegrees]`
 */
export function webMercatorToDegrees(x: number, y: number): [number, number] {
  const lon = (x / WEB_MERCATOR_RADIUS) * (180 / Math.PI);
  const lat =
    (2 * Math.atan(Math.exp(y / WEB_MERCATOR_RADIUS)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

/**
 * True when an (x, y) pair cannot possibly be geographic degrees.
 *
 * Used to decide whether a node bounding volume or layer extent still needs
 * reprojecting. This is a hard range impossibility, not a heuristic:
 * longitude is bounded by ±180 and latitude by ±90 by definition.
 */
export function looksProjected(x: number, y: number): boolean {
  return Math.abs(x) > 180 || Math.abs(y) > 90;
}

// ---------------------------------------------------------------------------
// Runtime patch
// ---------------------------------------------------------------------------

/** Marker key stamped onto `store.defaultGeometrySchema`; read by the worker. */
const SCHEMA_MARKER = '__projectedWkid';

/** Per-object guard so repeated node loads reproject exactly once. */
const REPROJECTED = new WeakSet<object>();

let installed = false;

interface MutableSpatialReference {
  wkid?: number;
  latestWkid?: number;
}

interface I3SLayerData {
  spatialReference?: MutableSpatialReference;
  store?: {
    defaultGeometrySchema?: Record<string, unknown>;
    extent?: number[];
  };
  fullExtent?: { xmin?: number; ymin?: number; xmax?: number; ymax?: number };
}

interface I3SNodeData {
  mbs?: number[];
  obb?: { center?: number[] };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Install Web Mercator I3S support onto a Cesium namespace.
 *
 * Idempotent, and a no-op if the expected internals are absent (a Cesium
 * upgrade that renames them degrades to today's behaviour — a clear
 * `Unsupported spatial reference` error — rather than breaking the build).
 *
 * @param Cesium The bundled Cesium namespace (`import * as Cesium from 'cesium'`).
 */
export function installProjectedI3SSupport(Cesium: any): void {
  if (installed) return;

  const layerProto = Cesium?.I3SLayer?.prototype;
  const nodeProto = Cesium?.I3SNode?.prototype;

  if (!layerProto?.load || !layerProto?._computeExtent || !nodeProto?._create3DTileDefinition) {
    log.warn(
      'I3S projected support: expected Cesium internals not found (I3SLayer.load / I3SLayer._computeExtent / I3SNode._create3DTileDefinition) — Web Mercator scene layers will keep failing with "Unsupported spatial reference"'
    );
    return;
  }

  // Cesium computes `this._extent` synchronously in the I3SLayer constructor
  // (which runs before `load`), so the extent must be reprojected here, not
  // just in the `load` wrap below. `prepareLayer` is idempotent — once this
  // runs, `data.spatialReference.wkid` is already 4326, so the duplicate
  // call from the `load` wrap below is a no-op.
  const originalComputeExtent = layerProto._computeExtent;
  layerProto._computeExtent = function patchedComputeExtent(this: any, ...args: unknown[]) {
    try {
      prepareLayer(this._data as I3SLayerData);
    } catch (err) {
      // Never let the adaptation break a layer that would otherwise load.
      log.warn('I3S projected support: layer preparation failed', err);
    }
    return originalComputeExtent.apply(this, args);
  };

  const originalLayerLoad = layerProto.load;
  layerProto.load = async function patchedLoad(this: any, ...args: unknown[]) {
    try {
      prepareLayer(this._data as I3SLayerData);
    } catch (err) {
      // Never let the adaptation break a layer that would otherwise load.
      log.warn('I3S projected support: layer preparation failed', err);
    }
    return originalLayerLoad.apply(this, args);
  };

  const originalTileDefinition = nodeProto._create3DTileDefinition;
  nodeProto._create3DTileDefinition = function patchedTileDefinition(this: any, ...args: unknown[]) {
    try {
      if (isProjectedLayer(this._layer)) {
        reprojectNodeVolume(this._data as I3SNodeData);
      }
    } catch (err) {
      log.warn('I3S projected support: node reprojection failed', err);
    }
    return originalTileDefinition.apply(this, args);
  };

  installed = true;
  log.info(
    `I3S projected support installed — Web Mercator scene layers (wkid ${[...WEB_MERCATOR_WKIDS].join(', ')}) will be reprojected to WGS84 on load`
  );
}

/** True when this layer was adapted by {@link prepareLayer}. */
function isProjectedLayer(layer: unknown): boolean {
  const schema = (layer as any)?._data?.store?.defaultGeometrySchema;
  return isWebMercatorWkid(schema?.[SCHEMA_MARKER]);
}

/**
 * Relax the wkid guard, flag the geometry schema for the worker, and convert
 * any layer-level extent that is still in projected metres.
 */
function prepareLayer(data: I3SLayerData | undefined): void {
  const wkid = data?.spatialReference?.wkid;
  if (!data || !isWebMercatorWkid(wkid)) return;

  const schema = data.store?.defaultGeometrySchema;
  if (!schema) {
    // Without the schema we cannot signal the worker, and relaxing the guard
    // alone would render garbage. Leave the layer to fail loudly instead.
    log.error(
      `I3S projected support: layer declares wkid ${wkid} but has no store.defaultGeometrySchema to carry the marker — refusing to relax the guard (garbage geometry is worse than a clear failure)`
    );
    return;
  }

  schema[SCHEMA_MARKER] = wkid;

  if (Array.isArray(data.store?.extent) && data.store.extent.length >= 4) {
    reprojectExtentArray(data.store.extent);
  }
  const fe = data.fullExtent;
  if (fe && typeof fe.xmin === 'number' && typeof fe.ymin === 'number' &&
      typeof fe.xmax === 'number' && typeof fe.ymax === 'number' &&
      (looksProjected(fe.xmin, fe.ymin) || looksProjected(fe.xmax, fe.ymax))) {
    const [west, south] = webMercatorToDegrees(fe.xmin, fe.ymin);
    const [east, north] = webMercatorToDegrees(fe.xmax, fe.ymax);
    fe.xmin = west;
    fe.ymin = south;
    fe.xmax = east;
    fe.ymax = north;
  }

  // Cesium checks `wkid`; keep `latestWkid` consistent so anything else
  // reading the SR sees a coherent WGS84 declaration.
  if (data.spatialReference) {
    data.spatialReference.wkid = 4326;
    data.spatialReference.latestWkid = 4326;
  }

  log.info(
    `I3S projected support: adapted a wkid-${wkid} scene layer to WGS84 (vertex offsets rescaled in the decode worker)`
  );
}

/** In-place `[xmin, ymin, xmax, ymax]` reprojection, when still projected. */
function reprojectExtentArray(extent: number[]): void {
  const [xmin, ymin, xmax, ymax] = extent as [number, number, number, number];
  if (!looksProjected(xmin, ymin) && !looksProjected(xmax, ymax)) return;
  const [west, south] = webMercatorToDegrees(xmin, ymin);
  const [east, north] = webMercatorToDegrees(xmax, ymax);
  extent[0] = west;
  extent[1] = south;
  extent[2] = east;
  extent[3] = north;
}

/**
 * Convert a node's `mbs` / `obb.center` from projected metres to degrees.
 *
 * The I3S spec says node bounding volumes are WGS84 even in a projected
 * layer, but publishers disagree, so this only touches values that cannot be
 * degrees. Idempotent — a node's data object is converted at most once.
 */
function reprojectNodeVolume(data: I3SNodeData | undefined): void {
  if (!data) return;

  const mbs = data.mbs;
  if (Array.isArray(mbs) && mbs.length >= 3 && !REPROJECTED.has(mbs)) {
    const [x, y] = mbs as [number, number];
    if (looksProjected(x, y)) {
      const [lon, lat] = webMercatorToDegrees(x, y);
      mbs[0] = lon;
      mbs[1] = lat;
      // mbs[3] (radius) stays in metres — Cesium builds the bounding sphere
      // from the cartesian centre, so a metre radius is already correct.
    }
    REPROJECTED.add(mbs);
  }

  const center = data.obb?.center;
  if (Array.isArray(center) && center.length >= 3 && !REPROJECTED.has(center)) {
    const [x, y] = center as [number, number];
    if (looksProjected(x, y)) {
      const [lon, lat] = webMercatorToDegrees(x, y);
      center[0] = lon;
      center[1] = lat;
    }
    REPROJECTED.add(center);
  }
}

/** Test seam: forget that the patch was installed. */
export function __resetProjectedI3SForTests(): void {
  installed = false;
}
