// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
import * as Cesium from 'cesium';
import { installProjectedI3SSupport, attachAtlasShader, createAtlasUvShader, createVisibilityLoader, i3sTilesetDefaults, type AtlasMode, type LayerStatus } from '../src';
import { DEMO_LAYERS, type DemoLayer } from './layers';

installProjectedI3SSupport(Cesium);                       // must run before any I3SDataProvider.fromUrl

const viewer = new Cesium.Viewer('v', {
  baseLayer: new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/', maximumLevel: 19 })),
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
});
viewer.scene.globe.depthTestAgainstTerrain = false;
for (const l of DEMO_LAYERS) viewer.creditDisplay.addStaticCredit(new Cesium.Credit(l.credit, true));

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage');
const splitUi = $('split');
const knob = $('knob');
const labelLeft = $('label-left');
const labelRight = $('label-right');
const panel = $('panel');
const statusEl = $('status');
const compare = $<HTMLSelectElement>('compare');
const lede = $('lede');

// ---------- Shaders: one per side ----------
// The left half is the comparison (stock crop by default); the right half is always the fix.
const leftShader = createAtlasUvShader({ mode: Number(compare.value) as AtlasMode });
const rightShader = createAtlasUvShader({ mode: 2 });
// Browsers can restore the select's value after a reload or back/forward navigation; the shader follows what is shown.
const syncCompare = () => { leftShader.setUniform('u_atlasMode', Number(compare.value)); viewer.scene.requestRender(); };

// ---------- Split position ----------
let split = reducedMotion.matches ? 0.5 : 0.15;
let reveal: { cancel(): void } | undefined;
/** Set once the reveal has played, been skipped, or the viewer moved the line themselves. */
let splitSettled = reducedMotion.matches;
let stopWaitingForReveal: (() => void) | undefined;
const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

const MIN_LABEL_ROOM = 88;   // px; about one short word of the 13px label plus padding

function setSplit(f: number): void {
  split = Math.min(1, Math.max(0, f));
  viewer.scene.splitPosition = split;
  const pct = Math.round(split * 100);
  stage.style.setProperty('--split', `${split * 100}%`);
  knob.setAttribute('aria-valuenow', String(pct));
  knob.setAttribute('aria-valuetext', `${pct}% ${lowerFirst(labelLeft.textContent ?? '')}, ${100 - pct}% with the extensions`);
  // The labels wrap to fit their half (CSS max-width); hide one only when its half has
  // no useful room left. Uses a fixed threshold, not the label's own width, so hiding
  // it never changes the measurement that decided to hide it.
  const w = stage.clientWidth;
  labelLeft.style.visibility = split * w - 28 < MIN_LABEL_ROOM ? 'hidden' : '';
  labelRight.style.visibility = (1 - split) * w - 28 < MIN_LABEL_ROOM ? 'hidden' : '';
  viewer.scene.requestRender();
}

/** The viewer took the line, or the reveal no longer applies: never animate it again. */
function stopReveal(): void {
  reveal?.cancel(); reveal = undefined;
  stopWaitingForReveal?.(); stopWaitingForReveal = undefined;
  splitSettled = true;
}

/** The one orchestrated moment: sweep the line open once the first buildings are in. */
function playReveal(): void {
  if (reducedMotion.matches) { setSplit(0.5); return; }
  const from = 0.15, to = 0.5, ms = 900, t0 = performance.now();
  let raf = 0;
  splitSettled = true;
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / ms);
    setSplit(from + (to - from) * (1 - Math.pow(1 - t, 3)));        // ease-out cubic
    if (t < 1) raf = requestAnimationFrame(step); else reveal = undefined;
  };
  raf = requestAnimationFrame(step);
  reveal = { cancel: () => cancelAnimationFrame(raf) };
}

function dragFrom(el: HTMLElement): void {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    stopReveal();
    el.setPointerCapture(e.pointerId);
    knob.focus({ preventScroll: true });
    const move = (ev: PointerEvent) => {
      const r = stage.getBoundingClientRect();
      setSplit((ev.clientX - r.left) / r.width);
    };
    move(e);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}
dragFrom(knob);
dragFrom(splitUi.querySelector<HTMLElement>('.split-line')!);

knob.addEventListener('keydown', (e) => {
  const steps: Record<string, number> = { ArrowLeft: -0.02, ArrowDown: -0.02, ArrowRight: 0.02, ArrowUp: 0.02, PageDown: -0.1, PageUp: 0.1 };
  let next: number | undefined;
  if (e.key in steps) next = split + steps[e.key];
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = 1;
  if (next === undefined) return;
  e.preventDefault();
  stopReveal();
  setSplit(next);
});

// On narrow screens the panel is a bottom sheet; keep the knob and credits clear of it.
const narrow = window.matchMedia('(max-width: 639px)');
const syncSheet = () => {
  stage.style.setProperty('--sheet-h', narrow.matches ? `${panel.offsetHeight + 16}px` : '0px');
  setSplit(split);
};
new ResizeObserver(syncSheet).observe(panel);
narrow.addEventListener('change', syncSheet);
window.addEventListener('resize', () => setSplit(split));

// ---------- Layers ----------
interface Place {
  providers: Cesium.I3SDataProvider[];
  /** A reload after the place was unloaded; shared by every show() that needs it. */
  reloading?: Promise<void>;
}
const places = new Map<string, Place>();
const byId = new Map(DEMO_LAYERS.map((l) => [l.id, l]));

const tilesetsOf = (p: Cesium.I3SDataProvider) =>
  p.layers.map((l) => l.tileset).filter((t): t is Cesium.Cesium3DTileset => t !== undefined);

interface I3SMaterialDef {
  normalTexture?: unknown; occlusionTexture?: unknown; emissiveTexture?: unknown;
  pbrMetallicRoughness?: { metallicRoughnessTexture?: unknown; metallicFactor?: number };
}

/**
 * Demo-only workaround, not part of the library. CesiumJS (1.138 through 1.145) copies an I3S
 * materialDefinition straight into the glTF it builds, but only creates a glTF
 * texture for the base colour. A layer whose materials also reference a normal
 * or metallic-roughness texture set (the Boston layer does) then fails every
 * tile with a RuntimeError in GltfLoader, so stock CesiumJS draws nothing.
 * Dropping those references lets the base-colour atlas render; the metallic
 * factor falls back to 0 because the texture that scaled it is gone.
 */
function dropUnsupportedMaterialTextures(p: Cesium.I3SDataProvider): void {
  for (const layer of p.layers) {
    const defs = (layer as unknown as { _data?: { materialDefinitions?: I3SMaterialDef[] } })._data?.materialDefinitions ?? [];
    for (const d of defs) {
      delete d.normalTexture; delete d.occlusionTexture; delete d.emissiveTexture;
      const pbr = d.pbrMetallicRoughness;
      if (pbr?.metallicRoughnessTexture) { delete pbr.metallicRoughnessTexture; pbr.metallicFactor = 0; }
    }
  }
}

async function loadProvider(l: DemoLayer, shader: Cesium.CustomShader, side: Cesium.SplitDirection) {
  const p = await Cesium.I3SDataProvider.fromUrl(l.url, {
    cesium3dTilesetOptions: {
      ...i3sTilesetDefaults,
      ...(l.screenSpaceError !== undefined ? { maximumScreenSpaceError: l.screenSpaceError } : {}),
    },
  });
  dropUnsupportedMaterialTextures(p);
  attachAtlasShader(p, shader);
  for (const t of tilesetsOf(p)) t.splitDirection = side;
  viewer.scene.primitives.add(p);
  return p;
}

const shortName = (l: DemoLayer) => l.label.split(',')[0];
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err ?? 'unknown error')).replace(/\.$/, '');

let active = DEMO_LAYERS.find((l) => l.visible)!;

function renderStatus(l: DemoLayer, s: LayerStatus | undefined, err?: unknown): void {
  if (l !== active) return;
  statusEl.classList.toggle('is-error', s === 'failed');
  statusEl.textContent =
    s === 'loading' ? `Loading ${shortName(l)}…`
    : s === 'loaded' ? `${shortName(l)} loaded`
    : s === 'failed' ? `${shortName(l)} didn’t load: ${errorText(err)}. Check the network tab for the SceneServer request.`
    : '';
}
const lastError = new Map<string, unknown>();

async function loadPlaceProviders(l: DemoLayer): Promise<Cesium.I3SDataProvider[]> {
  if (l.split !== 'split') {
    return [await loadProvider(l, rightShader, l.split === 'right' ? Cesium.SplitDirection.RIGHT : Cesium.SplitDirection.NONE)];
  }
  const results = await Promise.allSettled([
    loadProvider(l, leftShader, Cesium.SplitDirection.LEFT),
    loadProvider(l, rightShader, Cesium.SplitDirection.RIGHT),
  ]);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  const loaded = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (failed) {
    for (const p of loaded) viewer.scene.primitives.remove(p);          // don't strand half a pair
    throw failed.reason;
  }
  return loaded;
}

/**
 * Only one place is shown at a time, so a hidden place is destroyed rather than
 * kept. Boston is loaded twice, and keeping every visited place resident ran
 * the tab out of memory. show() reloads it on return.
 */
function unloadPlace(place: Place): void {
  for (const p of place.providers) viewer.scene.primitives.remove(p);   // the collection destroys it
  place.providers = [];
}

/**
 * Bring an unloaded place back. Concurrent callers share one in-flight reload,
 * so a quick Boston → Wellington → Boston can't load a second pair. If the place
 * is no longer the one shown when the reload lands, it is unloaded again at once.
 */
function reloadPlace(l: DemoLayer, place: Place): Promise<void> {
  place.reloading ??= loadPlaceProviders(l)
    .then((providers) => {
      unloadPlace(place);                               // never leave an earlier set behind
      place.providers = providers;
      if (active !== l) unloadPlace(place);
    })
    .finally(() => { place.reloading = undefined; });
  return place.reloading;
}

const loader = createVisibilityLoader<Place>(
  DEMO_LAYERS.map((l) => ({
    id: l.id,
    visible: l.visible,
    load: async () => {
      const place = { providers: await loadPlaceProviders(l) };
      places.set(l.id, place);
      return place;
    },
    setShown: (place, shown) => {
      if (shown) for (const p of place.providers) p.show = true;
      else unloadPlace(place);
      viewer.scene.requestRender();
    },
  })),
  {
    onStatus: (id, s, err) => {
      if (err !== undefined) lastError.set(id, err);
      renderStatus(byId.get(id)!, s, err);
    },
  },
);

// ---------- Camera ----------
let flownOnce = false;
function frame(l: DemoLayer, place: Place): void {
  // The right-hand (fixed) provider is always last.
  const t = tilesetsOf(place.providers[place.providers.length - 1])[0];
  if (!t) return;
  const { heading, pitch, range, target } = l.view;
  const bs = target ? new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(...target), 1) : t.boundingSphere;
  viewer.camera.flyToBoundingSphere(bs, {
    duration: !flownOnce || reducedMotion.matches ? 0 : undefined,
    offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(heading), Cesium.Math.toRadians(pitch), target ? range : bs.radius * range),
    complete: centreAboveSheet,
  });
  flownOnce = true;
}

/** On narrow screens, tilt the view so the target sits in the middle of the part the bottom sheet leaves visible. */
function centreAboveSheet(): void {
  const sheet = narrow.matches ? panel.offsetHeight + 16 : 0;
  const frustum = viewer.camera.frustum;
  if (!sheet || !(frustum instanceof Cesium.PerspectiveFrustum) || frustum.fovy === undefined) return;
  const half = viewer.canvas.clientHeight / 2;
  viewer.camera.lookDown(Math.atan((sheet / 2) * Math.tan(frustum.fovy / 2) / half));
}

// ---------- Panel ----------
function applySplitUse(l: DemoLayer): void {
  splitUi.hidden = l.split === 'full';
  labelLeft.textContent = l.leftLabel;
  lede.textContent = l.lede;
  compare.disabled = l.split !== 'split';
  // Leaving Boston before its first draw: skip the reveal rather than strand the line at 15%.
  if (l.split !== 'split' && !splitSettled) { stopReveal(); split = 0.5; }
  setSplit(split);
}

let revealArmed = false;
async function show(l: DemoLayer): Promise<void> {
  active = l;
  applySplitUse(l);
  await Promise.all(DEMO_LAYERS.filter((o) => o !== l).map((o) => loader.setVisible(o.id, false)));
  renderStatus(l, loader.status(l.id), lastError.get(l.id));
  await loader.setVisible(l.id, true);
  const place = places.get(l.id);
  if (active !== l || !place) return;
  if (place.providers.length === 0) {                  // visited before, unloaded when hidden
    renderStatus(l, 'loading');
    try {
      await reloadPlace(l, place);
    } catch (err) {
      renderStatus(l, 'failed', err);
      return;
    }
    if (active !== l || place.providers.length === 0) return;
    renderStatus(l, 'loaded');
  }
  frame(l, place);
  if (l.split === 'split' && !splitSettled && !revealArmed) {
    const right = tilesetsOf(place.providers[1])[0];
    if (!right) return;
    revealArmed = true;
    // allTilesLoaded also fires on the first frame, before anything was requested;
    // wait for a pass that actually draws buildings.
    const off = right.allTilesLoaded.addEventListener(() => {
      const drawn = (right as unknown as { statistics: { numberOfTrianglesSelected: number } }).statistics.numberOfTrianglesSelected;
      if (drawn === 0) return;
      stopWaitingForReveal = undefined;
      off();
      if (!splitSettled && active === l) playReveal();
    });
    stopWaitingForReveal = () => { off(); };
  }
}

const list = $('places');
for (const l of DEMO_LAYERS) {
  const row = document.createElement('label');
  row.className = 'place';
  const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'place', value: l.id, checked: l === active });
  const name = Object.assign(document.createElement('span'), { className: 'place-name', textContent: l.label });
  const note = Object.assign(document.createElement('span'), { className: 'place-note', textContent: l.note });
  const noteId = `note-${l.id}`;
  note.id = noteId;
  const describedBy = [noteId];
  row.append(input, name, note);
  if (l.caveat) {
    const caveat = Object.assign(document.createElement('span'), { className: 'place-note place-caveat', id: `caveat-${l.id}`, textContent: l.caveat });
    describedBy.push(caveat.id);
    row.append(caveat);
  }
  input.setAttribute('aria-describedby', describedBy.join(' '));
  input.addEventListener('change', () => { if (input.checked) void show(l); });
  list.append(row);
}

compare.addEventListener('change', syncCompare);
window.addEventListener('pageshow', syncCompare);

// Local-only inspection hook for verifying the demo from the browser console.
Object.assign(window, { demo: { Cesium, viewer, loader, places, leftShader, rightShader, setSplit, show: (id: string) => show(byId.get(id)!) } });

syncCompare();
setSplit(split);
void loader.init();   // starts the default place loading; show() then waits on the same in-flight load
void show(active);
