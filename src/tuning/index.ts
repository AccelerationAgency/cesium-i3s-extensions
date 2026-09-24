// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
import { log } from '../log.js';

/**
 * Tileset options for I3S building layers, with the measurements behind them.
 *
 * - maximumScreenSpaceError 8: I3SDataProvider's default 16 is tuned for
 *   terrain/meshes; at 16 tall buildings resolve to low-poly cylinders. On a
 *   ~100-node layer, 16 vs 8 measured byte-identical GPU memory, so 8 costs
 *   nothing there; raise it only with a measurement for genuinely large layers.
 * - cacheBytes must EXCEED the layer's steady-state working set. Capping it at
 *   128 MB against a ~193 MB working set made the tileset evict continuously and
 *   raised redundant geometry fetches from ~17x to ~185x, each re-paying a Draco
 *   decode. A cache cap turns a memory problem into a thrash problem.
 * - skipLevelOfDetail and progressiveResolutionHeightFraction were tried and
 *   removed: no memory or triangle reduction, more request churn.
 *
 * The lever that actually cut memory across many layers is not loading hidden
 * layers at all — see createVisibilityLoader.
 */
export const i3sTilesetDefaults = Object.freeze({
  maximumScreenSpaceError: 8,
  cacheBytes: 768 * 1024 * 1024,
  maximumCacheOverflowBytes: 512 * 1024 * 1024,
});

export type LayerStatus = 'deferred' | 'loading' | 'loaded' | 'failed';
export interface LayerDef<H> {
  id: string;
  visible?: boolean;
  load(): Promise<H>;
  setShown(handle: H, shown: boolean): void;
}
export interface VisibilityLoader {
  init(): Promise<void>;
  /**
   * Show or hide a layer, loading it on first show. A layer whose load has
   * already failed (`status(id) === 'failed'`) is not retried — this call
   * only changes `want` and, for a loaded layer, toggles visibility; a
   * failed layer stays 'failed' until the caller removes and re-adds it.
   */
  setVisible(id: string, visible: boolean): Promise<void>;
  remove(id: string): void;
  status(id: string): LayerStatus | undefined;
}

interface Entry<H> { def: LayerDef<H>; status: LayerStatus; want: boolean; handle?: H; inflight?: Promise<void>; }

/**
 * Load only visible layers; load a hidden one the first time it is shown.
 * Previously every layer was fetched, decoded and uploaded to the GPU, then
 * merely hidden — one building layer cost ~393 MB of GPU memory.
 *
 * A layer that fails to load settles at status 'failed' and is not retried;
 * subsequent `setVisible` calls for that id are no-ops with respect to
 * loading (see `VisibilityLoader.setVisible`).
 */
export function createVisibilityLoader<H>(
  defs: LayerDef<H>[],
  opts: { onStatus?(id: string, s: LayerStatus, err?: unknown): void } = {},
): VisibilityLoader {
  const entries = new Map<string, Entry<H>>(defs.map((d) => [d.id, { def: d, status: 'deferred', want: d.visible !== false }]));

  const setStatus = (e: Entry<H>, s: LayerStatus, err?: unknown) => { e.status = s; opts.onStatus?.(e.def.id, s, err); };

  function ensureLoaded(e: Entry<H>): Promise<void> {
    if (e.status === 'loaded' || e.status === 'failed') return Promise.resolve();
    if (e.inflight) return e.inflight;
    setStatus(e, 'loading');
    // Promise.resolve().then(...) normalises a load() that throws
    // synchronously (rather than returning a rejected promise) into the
    // same rejection path below, instead of letting it escape as a thrown
    // exception from this function.
    e.inflight = Promise.resolve().then(() => e.def.load()).then(
      (h) => {
        if (entries.get(e.def.id) !== e) return;          // removed while loading
        e.handle = h;
        setStatus(e, 'loaded');
        e.def.setShown(h, e.want);                          // last toggle wins
      },
      (err) => {
        log.warn(`layer "${e.def.id}" failed to load`, err);
        if (entries.get(e.def.id) !== e) return;           // removed while loading
        setStatus(e, 'failed', err);
      },
    ).finally(() => { e.inflight = undefined; });
    return e.inflight;
  }

  return {
    async init() {
      await Promise.all([...entries.values()].filter((e) => e.want).map(ensureLoaded));
    },
    async setVisible(id, visible) {
      const e = entries.get(id);
      if (!e) return;
      e.want = visible;
      if (e.status === 'loaded') { e.def.setShown(e.handle as H, visible); return; }
      if (visible || e.inflight) await ensureLoaded(e);
    },
    remove(id) { entries.delete(id); },
    status(id) { return entries.get(id)?.status; },
  };
}
