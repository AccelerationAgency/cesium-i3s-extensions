// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Cesium from 'cesium';
import {
  isWebMercatorWkid,
  webMercatorToDegrees,
  degPerMetreY,
  looksProjected,
  installProjectedI3SSupport,
  __resetProjectedI3SForTests,
  DEG_PER_METRE_X,
  WEB_MERCATOR_RADIUS,
} from '../../src/projected';
import { setLogger } from '../../src/log';

beforeEach(() => {
  __resetProjectedI3SForTests();
  vi.restoreAllMocks();
  // Silence the module's own logger (prefixed to console by default) so test
  // output stays clean; still spyable via these fakes if a test wants to
  // assert on a call.
  setLogger({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
});

afterEach(() => {
  setLogger(null);
});

describe('wkid recognition', () => {
  it('accepts every Web Mercator spelling Esri and EPSG use', () => {
    for (const wkid of [102100, 3857, 102113, 900913]) {
      expect(isWebMercatorWkid(wkid)).toBe(true);
    }
  });

  it('rejects WGS84 and non-numeric values', () => {
    expect(isWebMercatorWkid(4326)).toBe(false);
    expect(isWebMercatorWkid(4490)).toBe(false);
    expect(isWebMercatorWkid('102100')).toBe(false);
    expect(isWebMercatorWkid(undefined)).toBe(false);
  });
});

describe('webMercatorToDegrees', () => {
  it('maps the origin and the antimeridian exactly', () => {
    expect(webMercatorToDegrees(0, 0)[0]).toBeCloseTo(0, 10);
    expect(webMercatorToDegrees(0, 0)[1]).toBeCloseTo(0, 10);
    // x = R·π is exactly 180° of longitude.
    expect(webMercatorToDegrees(WEB_MERCATOR_RADIUS * Math.PI, 0)[0]).toBeCloseTo(180, 9);
  });

  it('round-trips a Wellington point through the forward projection', () => {
    const lon = 174.78;
    const lat = -41.33;
    // Forward Web Mercator, computed independently of the module.
    const x = WEB_MERCATOR_RADIUS * (lon * Math.PI) / 180;
    const y =
      WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2));

    const [gotLon, gotLat] = webMercatorToDegrees(x, y);
    expect(gotLon).toBeCloseTo(lon, 9);
    expect(gotLat).toBeCloseTo(lat, 9);
  });

  it('produces coordinates a wkid-4326 consumer would accept', () => {
    // The whole point: values that tripped `looksProjected` must come out in range.
    const [lon, lat] = webMercatorToDegrees(19456000, -5062000);
    expect(Math.abs(lon)).toBeLessThanOrEqual(180);
    expect(Math.abs(lat)).toBeLessThanOrEqual(90);
  });
});

describe('vertex scale factors', () => {
  it('uses a latitude-independent longitude scale', () => {
    // dλ/dX = 1/R, so the X factor cannot depend on latitude.
    expect(DEG_PER_METRE_X).toBeCloseTo(180 / (Math.PI * WEB_MERCATOR_RADIUS), 15);
  });

  it('shrinks the latitude scale by cos(phi)', () => {
    expect(degPerMetreY(0)).toBeCloseTo(DEG_PER_METRE_X, 15);
    expect(degPerMetreY(60)).toBeCloseTo(DEG_PER_METRE_X * 0.5, 12);
    expect(degPerMetreY(-41.33)).toBeLessThan(DEG_PER_METRE_X);
  });

  it('cancels Web Mercator scale distortion so ground distance survives', () => {
    // A 100 m ground offset is stored as 100/cos(phi) projected metres.
    // Applying degPerMetreY must recover the true ground angle 100/R radians.
    const latDeg = -41.33;
    const groundMetres = 100;
    const projectedMetres = groundMetres / Math.cos((latDeg * Math.PI) / 180);

    const deltaLatDeg = degPerMetreY(latDeg) * projectedMetres;
    const deltaLatRad = (deltaLatDeg * Math.PI) / 180;

    expect(deltaLatRad * WEB_MERCATOR_RADIUS).toBeCloseTo(groundMetres, 6);
  });

  it('recovers east-west ground distance too', () => {
    const latDeg = -41.33;
    const groundMetres = 100;
    const projectedMetres = groundMetres / Math.cos((latDeg * Math.PI) / 180);

    const deltaLonRad = ((DEG_PER_METRE_X * projectedMetres) * Math.PI) / 180;
    const eastWestGround =
      WEB_MERCATOR_RADIUS * Math.cos((latDeg * Math.PI) / 180) * deltaLonRad;

    expect(eastWestGround).toBeCloseTo(groundMetres, 6);
  });
});

describe('looksProjected', () => {
  it('flags coordinates that cannot be degrees', () => {
    expect(looksProjected(19456000, -5062000)).toBe(true);
    expect(looksProjected(0, 4000000)).toBe(true);
    expect(looksProjected(20037508, 0)).toBe(true);
  });

  it('leaves plausible geographic coordinates alone', () => {
    expect(looksProjected(174.78, -41.33)).toBe(false);
    expect(looksProjected(180, 90)).toBe(false);
    expect(looksProjected(0, 0)).toBe(false);
  });
});

// --- Runtime patch ---------------------------------------------------------

/** Minimal stand-in for the Cesium internals the patch wraps. */
function fakeCesium() {
  const calls = { layerLoad: 0, tileDefinition: 0 };
  class I3SLayer {
    _data: unknown;
    constructor(data: unknown) {
      this._data = data;
      // Mirrors Cesium 1.145: `_computeExtent` runs synchronously from the
      // constructor, before `load` is ever called.
      this._computeExtent();
    }
    _computeExtent() {
      // The fake doesn't need to model the actual Rectangle math — only that
      // it runs, and runs before `load`, matching the real ordering bug.
    }
    async load() {
      calls.layerLoad++;
      const wkid = (this._data as any)?.spatialReference?.wkid;
      // Mirrors Cesium 1.145's real guard.
      if (wkid !== 4326) throw new Error(`Unsupported spatial reference: ${wkid}`);
      return 'loaded';
    }
  }
  class I3SNode {
    _data: unknown;
    _layer: unknown;
    constructor(data: unknown, layer: unknown) {
      this._data = data;
      this._layer = layer;
    }
    _create3DTileDefinition() {
      calls.tileDefinition++;
      return { boundingVolume: {} };
    }
  }
  return { Cesium: { I3SLayer, I3SNode }, calls };
}

const mercatorLayerData = () => ({
  spatialReference: { wkid: 102100, latestWkid: 3857 },
  store: { defaultGeometrySchema: { ordering: ['position'] }, extent: [19450000, -5070000, 19460000, -5060000] },
  fullExtent: { xmin: 19450000, ymin: -5070000, xmax: 19460000, ymax: -5060000 },
});

describe('installProjectedI3SSupport', () => {
  it('lets a wkid-102100 layer load instead of throwing', async () => {
    const { Cesium } = fakeCesium();
    installProjectedI3SSupport(Cesium);

    const layer = new Cesium.I3SLayer(mercatorLayerData());
    await expect(layer.load()).resolves.toBe('loaded');
  });

  it('rewrites the declared spatial reference to WGS84', async () => {
    const { Cesium } = fakeCesium();
    installProjectedI3SSupport(Cesium);

    const data = mercatorLayerData();
    await new Cesium.I3SLayer(data).load();

    expect(data.spatialReference.wkid).toBe(4326);
    expect(data.spatialReference.latestWkid).toBe(4326);
  });

  it('stamps the worker marker onto the geometry schema', async () => {
    const { Cesium } = fakeCesium();
    installProjectedI3SSupport(Cesium);

    const data = mercatorLayerData();
    await new Cesium.I3SLayer(data).load();

    // The decode worker reads this off `payload.schema` to rescale vertices.
    expect((data.store.defaultGeometrySchema as any).__projectedWkid).toBe(102100);
  });

  it('reprojects the layer extent into degrees', async () => {
    const { Cesium } = fakeCesium();
    installProjectedI3SSupport(Cesium);

    const data = mercatorLayerData();
    await new Cesium.I3SLayer(data).load();

    expect(data.store.extent[0]).toBeCloseTo(174.72, 1);
    expect(data.store.extent[1]).toBeCloseTo(-41.39, 1);
    expect(data.store.extent[2]).toBeCloseTo(174.81, 1);
    expect(data.fullExtent.xmin).toBeCloseTo(174.72, 1);
    expect(data.fullExtent.ymax).toBeCloseTo(-41.32, 1);
  });

  it('refuses to relax the guard when there is no schema to signal the worker', async () => {
    // Relaxing the guard without the worker half renders garbage geometry,
    // which is strictly worse than a clear failure.
    const { Cesium } = fakeCesium();
    installProjectedI3SSupport(Cesium);

    const data = { spatialReference: { wkid: 102100 }, store: {} };
    await expect(new Cesium.I3SLayer(data).load()).rejects.toThrow(
      'Unsupported spatial reference: 102100'
    );
    expect(data.spatialReference.wkid).toBe(102100);
  });

  it('leaves a WGS84 layer completely untouched', async () => {
    const { Cesium } = fakeCesium();
    installProjectedI3SSupport(Cesium);

    const data = {
      spatialReference: { wkid: 4326 },
      store: { defaultGeometrySchema: { ordering: ['position'] }, extent: [174.7, -41.4, 174.8, -41.3] },
    };
    await expect(new Cesium.I3SLayer(data).load()).resolves.toBe('loaded');

    expect((data.store.defaultGeometrySchema as any).__projectedWkid).toBeUndefined();
    expect(data.store.extent).toEqual([174.7, -41.4, 174.8, -41.3]);
  });

  it('reprojects node bounding volumes for a projected layer', async () => {
    const { Cesium } = fakeCesium();
    installProjectedI3SSupport(Cesium);

    const layerData = mercatorLayerData();
    const layer = new Cesium.I3SLayer(layerData);
    await layer.load();

    const nodeData = {
      mbs: [19456000, -5062000, 12, 250],
      obb: { center: [19456000, -5062000, 12] },
    };
    new Cesium.I3SNode(nodeData, layer)._create3DTileDefinition();

    expect(nodeData.mbs[0]).toBeCloseTo(174.78, 1);
    expect(nodeData.mbs[1]).toBeCloseTo(-41.34, 1);
    expect(nodeData.mbs[3]).toBe(250); // radius stays in metres
    expect(nodeData.obb.center[0]).toBeCloseTo(174.78, 1);
    expect(nodeData.obb.center[2]).toBe(12); // height untouched
  });

  it('reprojects a node volume exactly once even across repeated loads', async () => {
    const { Cesium } = fakeCesium();
    installProjectedI3SSupport(Cesium);

    const layer = new Cesium.I3SLayer(mercatorLayerData());
    await layer.load();

    const nodeData = { mbs: [19456000, -5062000, 12, 250] };
    const node = new Cesium.I3SNode(nodeData, layer);
    node._create3DTileDefinition();
    const afterFirst = [...nodeData.mbs];
    node._create3DTileDefinition();

    expect(nodeData.mbs).toEqual(afterFirst);
  });

  it('leaves already-geographic node volumes alone (spec-compliant publishers)', async () => {
    // The I3S spec says node volumes are WGS84 even in a projected layer.
    // Those must pass through untouched.
    const { Cesium } = fakeCesium();
    installProjectedI3SSupport(Cesium);

    const layer = new Cesium.I3SLayer(mercatorLayerData());
    await layer.load();

    const nodeData = { mbs: [174.78, -41.34, 12, 250] };
    new Cesium.I3SNode(nodeData, layer)._create3DTileDefinition();

    expect(nodeData.mbs).toEqual([174.78, -41.34, 12, 250]);
  });

  it('does not touch node volumes for a non-projected layer', async () => {
    const { Cesium } = fakeCesium();
    installProjectedI3SSupport(Cesium);

    const layer = new Cesium.I3SLayer({
      spatialReference: { wkid: 4326 },
      store: { defaultGeometrySchema: {} },
    });
    await layer.load();

    // Deliberately out-of-range values: without the projected marker the patch
    // must not "helpfully" convert them.
    const nodeData = { mbs: [19456000, -5062000, 12, 250] };
    new Cesium.I3SNode(nodeData, layer)._create3DTileDefinition();

    expect(nodeData.mbs).toEqual([19456000, -5062000, 12, 250]);
  });

  it('is idempotent and survives missing internals', () => {
    const { Cesium, calls } = fakeCesium();
    installProjectedI3SSupport(Cesium);
    installProjectedI3SSupport(Cesium);
    expect(calls.layerLoad).toBe(0);

    // A Cesium upgrade that renames internals must degrade, not throw.
    expect(() => installProjectedI3SSupport({})).not.toThrow();
  });
});

// --- Layer extent (real Cesium) --------------------------------------------

/**
 * The fields Cesium's `I3SLayer._computeExtent` reads, captured from the
 * live public Southgate 3D Buildings scene layer (wkid 102100, Wellington):
 *   https://tiles.arcgis.com/tiles/CPYspmTk3abe6d7i/arcgis/rest/services/Southgate_3D_Buildings/SceneServer?f=json
 *   https://tiles.arcgis.com/tiles/CPYspmTk3abe6d7i/arcgis/rest/services/Southgate_3D_Buildings/SceneServer/layers/0?f=json
 * Trimmed to only the extent/spatialReference/store fields; no bulk data.
 */
const southgateLayerData = () => ({
  spatialReference: { wkid: 102100, latestWkid: 3857, vcsWkid: 5703, latestVcsWkid: 5703 },
  store: {
    defaultGeometrySchema: { geometryType: 'triangles', ordering: ['position'] },
    extent: [19455984.374663092, -5063307.245719761, 19456968.555803478, -5061144.073070317],
  },
  fullExtent: {
    xmin: 19456021.92244649,
    ymin: -5063302.514633997,
    xmax: 19456940.981278785,
    ymax: -5061148.109068867,
  },
});

describe('I3SLayer extent reprojection (real Cesium)', () => {
  it('leaves Cesium._computeExtent producing a WGS84 Rectangle for Southgate', () => {
    installProjectedI3SSupport(Cesium);

    // Mirrors what the real I3SLayer constructor does: `_computeExtent` is
    // called with only `_data` and `_extent` on `this` (I3SLayer.js:58,65).
    const fakeLayer = { _data: southgateLayerData(), _extent: undefined as unknown };
    (Cesium.I3SLayer.prototype as any)._computeExtent.call(fakeLayer);

    const rect = fakeLayer._extent as Cesium.Rectangle;
    expect(rect).toBeInstanceOf(Cesium.Rectangle);

    const west = Cesium.Math.toDegrees(rect.west);
    const east = Cesium.Math.toDegrees(rect.east);
    const south = Cesium.Math.toDegrees(rect.south);
    const north = Cesium.Math.toDegrees(rect.north);

    expect(west).toBeGreaterThan(174.7);
    expect(west).toBeLessThan(174.8);
    expect(east).toBeGreaterThan(174.7);
    expect(east).toBeLessThan(174.8);
    expect(south).toBeGreaterThan(-41.4);
    expect(south).toBeLessThan(-41.3);
    expect(north).toBeGreaterThan(-41.4);
    expect(north).toBeLessThan(-41.3);
  });

  it('still relaxes the load guard after _computeExtent has already reprojected the data', async () => {
    installProjectedI3SSupport(Cesium);

    const data = southgateLayerData();
    const fakeLayer = { _data: data, _extent: undefined as unknown };
    (Cesium.I3SLayer.prototype as any)._computeExtent.call(fakeLayer);

    // `_computeExtent` already rewrote `spatialReference.wkid` to 4326, so a
    // real `load()` call downstream would not hit the "Unsupported spatial
    // reference" guard.
    expect(data.spatialReference.wkid).toBe(4326);
  });

  it('does not touch a WGS84 layer extent', () => {
    installProjectedI3SSupport(Cesium);

    const fakeLayer = {
      _data: {
        spatialReference: { wkid: 4326 },
        store: { defaultGeometrySchema: {}, extent: [174.7, -41.4, 174.8, -41.3] },
      },
      _extent: undefined as unknown,
    };
    (Cesium.I3SLayer.prototype as any)._computeExtent.call(fakeLayer);

    const rect = fakeLayer._extent as Cesium.Rectangle;
    expect(Cesium.Math.toDegrees(rect.west)).toBeCloseTo(174.7, 5);
    expect(Cesium.Math.toDegrees(rect.east)).toBeCloseTo(174.8, 5);
  });
});

describe('already-geographic node volumes on a Web Mercator layer', () => {
  it('leaves degree-valued mbs untouched', () => {
    expect(looksProjected(174.78, -41.33)).toBe(false);
    expect(looksProjected(19_456_000, -5_062_000)).toBe(true);
  });
});
