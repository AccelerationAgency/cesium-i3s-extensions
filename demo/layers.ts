// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
// Public ArcGIS Online scene layers; provenance and terms in SOURCES.md.

/**
 * How a place uses the split:
 * - 'split': loaded twice, stock crop on the left and the fix on the right.
 * - 'right': loaded once, on the right only; stock CesiumJS cannot load it at all.
 * - 'full':  loaded once, full width; its UVs stay in [0,1], so both modes match.
 */
export type SplitUse = 'split' | 'right' | 'full';

export interface DemoLayer {
  id: string;
  /** Short place name, used in the panel and the status line. */
  label: string;
  note: string;
  /** Optional second note line, for what the demo changes about this layer. */
  caveat?: string;
  /** Panel line under the title while this place is shown. */
  lede: string;
  url: string;
  visible: boolean;
  credit: string;
  split: SplitUse;
  /** Left-half label while this place is shown. */
  leftLabel: string;
  /**
   * Overrides `i3sTilesetDefaults.maximumScreenSpaceError` for this place.
   * Set it when the default asks for more geometry than `cacheBytes` can hold.
   */
  screenSpaceError?: number;
  /**
   * Oblique framing, heading and pitch in degrees. With `target` (lon, lat,
   * ellipsoid height) the camera looks at that point from `range` metres;
   * without it, at the layer's bounding sphere from `range` x its radius.
   */
  view: { heading: number; pitch: number; range: number; target?: [number, number, number] };
}

export const DEMO_LAYERS: DemoLayer[] = [
  {
    id: 'boston',
    label: 'Boston, Dot Ave',
    note: 'Tiling facade textures. Stock CesiumJS samples the wrong atlas slot.',
    caveat: 'Both halves skip this layer’s normal and roughness maps, which CesiumJS can’t load.',
    lede: 'Drag the line to compare. Both halves load the same scene layer.',
    url: 'https://tiles.arcgis.com/tiles/cFEFS0EWrhfDeVw9/arcgis/rest/services/Boston_DotAve_CE_Example_WSL1/SceneServer',
    visible: true,
    credit: 'Boston Dot Ave CityEngine example © Esri R&D Center Zurich',
    split: 'split',
    // Not "Stock CesiumJS": stock CesiumJS draws nothing on this layer (see caveat).
    leftLabel: 'Stock atlas handling',
    // The library default of 8 does not fit this close view. On a 1440×757
    // canvas, SSE 8 and 48 both fill the 768 MB cache; Cesium then raises
    // memoryAdjustedScreenSpaceError and oscillates it, and the second copy
    // pushes the tab over the edge. SSE 64 holds a steady 581 MB per copy.
    screenSpaceError: 64,
    view: { heading: 20, pitch: -15, range: 430, target: [-71.0578, 42.3372, 25] },  // the tower cluster on Dorchester Ave
  },
  {
    id: 'wellington',
    label: 'Wellington, Southgate',
    note: 'Web Mercator layer. Stock CesiumJS refuses to load it.',
    lede: 'Drag the line to compare. Stock CesiumJS can’t load this Web Mercator layer, so its half stays empty.',
    url: 'https://tiles.arcgis.com/tiles/CPYspmTk3abe6d7i/arcgis/rest/services/Southgate_3D_Buildings/SceneServer',
    visible: false,
    credit: 'Southgate 3D Buildings © Wellington City Council, AAM Ltd — CC BY 4.0',
    split: 'right',
    leftLabel: 'Stock CesiumJS: can’t load wkid 102100',
    view: { heading: 0, pitch: -35, range: 1100, target: [174.7825, -41.3345, 120] },  // Southgate's houses, centred on the line
  },
  {
    id: 'sf',
    label: 'San Francisco',
    note: 'Textures stay in range, so both halves match. The fix changes nothing here.',
    lede: 'This layer’s textures stay in range, so the fix leaves it unchanged.',
    url: 'https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/SanFrancisco_Bldgs/SceneServer',
    visible: false,
    credit: 'San Francisco 3D Buildings: Esri sample content; source data © Precision Light Works (PLW)',
    split: 'full',
    leftLabel: 'Stock CesiumJS',
    view: { heading: 0, pitch: -35, range: 0.6 },
  },
];
