#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
//
// Finds public, anonymously accessible I3S 3DObject scene layers whose
// atlas-textured geometry uses tiling texture coordinates (uv0 outside [0,1]).
// Those are the layers where stock CesiumJS bleeds into neighbouring atlas
// regions and the atlas-UV remap visibly changes the rendering.
//
//   node scripts/find-tiling-uv-layers.mjs                  # search ArcGIS Online
//   node scripts/find-tiling-uv-layers.mjs <SceneServer>... # measure given layers
//
// For each layer: read layers/0, pick up to NODES_PER_LAYER nodes from node
// page 0 that use the atlas (uvRegion) geometry definition, fetch their
// geometry buffers (uncompressed if offered, else Draco), and measure uv0.
// Requests are sequential and capped (MAX_LAYERS) to stay polite.
import draco3d from 'draco3d';

const MAX_LAYERS = 60;
const NODES_PER_LAYER = 3;
const LO = -0.01;
const HI = 1.01;
const QUERIES = [
  'type:"Scene Service" AND access:public AND (tags:CityEngine OR tags:procedural OR description:CityEngine)',
  'type:"Scene Service" AND access:public AND (tags:"LOD2" OR tags:LOD3) AND (tags:textured OR tags:texture)',
  'type:"Scene Service" AND access:public AND (tags:facade OR tags:facades OR title:textured)',
  'type:"Scene Service" AND access:public AND (tags:"3D buildings" OR title:buildings) AND tags:textured',
  'type:"Scene Service" AND access:public AND owner:esri_3d',
];

const j = async (u) => {
  const r = await fetch(u); // anonymous: no token, no cookies
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const b = await r.json();
  if (b.error) throw new Error(`error ${b.error.code}: ${b.error.message}`);
  return b;
};
const bin = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

let dracoModule;
const draco = async () => (dracoModule ??= await draco3d.createDecoderModule({}));

const SIZE = { Float32: 4, UInt8: 1, UInt16: 2, UInt32: 4, UInt64: 8, Int32: 4, Int16: 2, Int8: 1, Float64: 8 };

/** Parses an uncompressed I3S 1.7+ geometry buffer described by `desc`. */
function parseUncompressed(buf, desc) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const vertexCount = dv.getUint32(0, true);
  const featureCount = dv.getUint32(4, true);
  let off = desc.offset ?? 8;
  const out = { vertexCount };
  for (const [name, a] of Object.entries(desc)) {
    if (name === 'offset' || !a?.type) continue;
    const n = (a.binding === 'per-feature' ? featureCount : vertexCount) * a.component;
    if (name === 'uv0') out.uv = new Float32Array(buf.slice(off, off + n * 4).buffer);
    if (name === 'uvRegion') out.region = new Uint16Array(buf.slice(off, off + n * 2).buffer);
    off += n * SIZE[a.type];
  }
  if (off > buf.byteLength) throw new Error(`buffer too short (${buf.byteLength} < ${off})`);
  return out;
}

/** Decodes an I3S Draco geometry buffer; attributes are tagged by metadata. */
async function parseDraco(buf) {
  const D = await draco();
  const decoder = new D.Decoder();
  const db = new D.DecoderBuffer();
  db.Init(buf, buf.length);
  const mesh = new D.Mesh();
  const st = decoder.DecodeBufferToMesh(db, mesh);
  if (!st.ok()) throw new Error(`draco: ${st.error_msg()}`);
  const mq = new D.MetadataQuerier();
  const n = mesh.num_points();
  const out = { vertexCount: n };
  for (let i = 0; i < mesh.num_attributes(); i++) {
    const attr = decoder.GetAttribute(mesh, i);
    const md = decoder.GetAttributeMetadata(mesh, i);
    const kind = md && md.ptr ? mq.GetStringEntry(md, 'i3s-attribute-type') : '';
    const comps = attr.num_components();
    if (kind === 'uv0') {
      const arr = new D.DracoFloat32Array();
      decoder.GetAttributeFloatForAllPoints(mesh, attr, arr);
      out.uv = Float32Array.from({ length: n * comps }, (_, k) => arr.GetValue(k));
      D.destroy(arr);
    } else if (kind === 'uv-region') {
      const arr = new D.DracoUInt16Array();
      decoder.GetAttributeUInt16ForAllPoints(mesh, attr, arr);
      out.region = Uint16Array.from({ length: n * comps }, (_, k) => arr.GetValue(k));
      D.destroy(arr);
    }
  }
  D.destroy(mq); D.destroy(mesh); D.destroy(db); D.destroy(decoder);
  return out;
}

/** Counts uv0 values outside [LO,HI], split by whether the vertex sits in a real atlas sub-rectangle. */
function measure({ vertexCount, uv, region }) {
  const s = { vertexCount, sub: 0, subOut: 0, allOut: 0, compOut: 0, umin: Infinity, umax: -Infinity, vmin: Infinity, vmax: -Infinity };
  if (!uv) return s;
  for (let i = 0; i < vertexCount; i++) {
    const u = uv[2 * i], v = uv[2 * i + 1];
    if (u < s.umin) s.umin = u; if (u > s.umax) s.umax = u;
    if (v < s.vmin) s.vmin = v; if (v > s.vmax) s.vmax = v;
    const ou = u < LO || u > HI, ov = v < LO || v > HI;
    s.compOut += ou + ov;
    const out = ou || ov;
    s.allOut += out;
    if (region) {
      const r0 = region[4 * i], r1 = region[4 * i + 1], r2 = region[4 * i + 2], r3 = region[4 * i + 3];
      const full = r0 === 0 && r1 === 0 && r2 === 65535 && r3 === 65535;
      if (!full && r2 > r0 && r3 > r1) { s.sub++; s.subOut += out; }
    }
  }
  return s;
}

async function measureLayer(serviceUrl) {
  const base = `${serviceUrl.replace(/\/$/, '')}/layers/0`;
  const L = await j(`${base}?f=json`);
  const res = { url: serviceUrl, name: L.name, layerType: L.layerType, wkid: L.spatialReference?.wkid, version: L.store?.version, nodes: [] };
  if (L.layerType !== '3DObject') return { ...res, skip: 'not 3DObject' };
  const defs = L.geometryDefinitions ?? [];
  const atlasDefs = defs.map((d, i) => (JSON.stringify(d).match(/uvRegion|uv-region/) ? i : -1)).filter((i) => i >= 0);
  if (!(L.textureSetDefinitions ?? []).some((t) => t.atlas)) return { ...res, skip: 'no atlas texture set' };
  if (!L.nodePages) return { ...res, skip: 'no nodePages (pre-1.7)' };
  if (!atlasDefs.length) return { ...res, skip: 'no uvRegion geometry definition' };
  const perPage = L.nodePages.nodesPerPage ?? 64;
  const page0 = (await j(`${base}/nodepages/0?f=json`)).nodes;
  const withAtlas = (ns) =>
    ns.filter((n) => n.mesh?.geometry && atlasDefs.includes(n.mesh.geometry.definition))
      .sort((a, b) => (b.mesh.geometry.vertexCount ?? 0) - (a.mesh.geometry.vertexCount ?? 0));
  const cands = withAtlas(page0);
  // Page 0 often holds the root plus leaves; interior (merged, atlas-packed)
  // nodes live on later pages. Fetch the page holding the largest leaf's parent.
  const leaf = cands.find((n) => !n.children?.length);
  let inner = cands.find((n) => n.children?.length);
  if (!inner && leaf?.parentIndex != null && leaf.parentIndex >= perPage) {
    const pg = Math.floor(leaf.parentIndex / perPage);
    inner = withAtlas((await j(`${base}/nodepages/${pg}?f=json`)).nodes).find((n) => n.index === leaf.parentIndex)
      ?? null;
  }
  if (!leaf && !inner) return { ...res, skip: 'no atlas nodes found' };
  // Largest leaf, an interior node, and the median page-0 node.
  const picks = [...new Set([leaf, inner, cands[Math.floor(cands.length / 2)], cands[1]])]
    .filter(Boolean)
    .slice(0, NODES_PER_LAYER);
  const tot = measure({ vertexCount: 0 });
  for (const n of picks) {
    const g = n.mesh.geometry;
    const bufs = defs[g.definition].geometryBuffers;
    const plainIdx = bufs.findIndex((b) => !b.compressedAttributes);
    const dracoIdx = bufs.findIndex((b) => b.compressedAttributes?.encoding === 'draco');
    let parsed, method;
    try {
      if (plainIdx >= 0) {
        parsed = parseUncompressed(await bin(`${base}/nodes/${g.resource}/geometries/${plainIdx}`), bufs[plainIdx]);
        method = 'uncompressed';
      } else throw new Error('no uncompressed buffer');
    } catch (e) {
      if (dracoIdx < 0) { res.nodes.push({ id: n.index, error: e.message }); continue; }
      parsed = await parseDraco(await bin(`${base}/nodes/${g.resource}/geometries/${dracoIdx}`));
      method = 'draco';
    }
    const m = measure(parsed);
    res.nodes.push({ id: n.index, resource: g.resource, method, ...m });
    for (const k of ['vertexCount', 'sub', 'subOut', 'allOut', 'compOut']) tot[k] += m[k];
    tot.umin = Math.min(tot.umin, m.umin); tot.umax = Math.max(tot.umax, m.umax);
    tot.vmin = Math.min(tot.vmin, m.vmin); tot.vmax = Math.max(tot.vmax, m.vmax);
  }
  const pct = (a, b) => (b ? +((100 * a) / b).toFixed(2) : 0);
  return {
    ...res, ...tot,
    pctSubOut: pct(tot.subOut, tot.sub),
    pctAllOut: pct(tot.allOut, tot.vertexCount),
    pctCompOut: pct(tot.compOut, 2 * tot.vertexCount),
  };
}

async function searchCandidates() {
  const seen = new Set();
  const out = [];
  for (const q of QUERIES) {
    let s;
    try {
      s = await j(`https://www.arcgis.com/sharing/rest/search?f=json&num=100&q=${encodeURIComponent(q)}`);
    } catch { continue; }
    for (const it of s.results) {
      if (!it.url || !/SceneServer/i.test(it.url) || seen.has(it.url)) continue;
      seen.add(it.url);
      out.push({ url: it.url, title: it.title, owner: it.owner, id: it.id, licenseInfo: it.licenseInfo ?? '' });
    }
  }
  return out;
}

const args = process.argv.slice(2);
const cands = args.length ? args.map((url) => ({ url })) : await searchCandidates();
const results = [];
let examined = 0;
for (const c of cands) {
  if (examined >= MAX_LAYERS) break;
  let r;
  try {
    r = await measureLayer(c.url);
  } catch (e) {
    r = { url: c.url, skip: e.message };
  }
  examined++;
  results.push({ title: c.title, owner: c.owner, itemId: c.id, license: c.licenseInfo?.replace(/<[^>]+>/g, ' ').slice(0, 300), ...r });
  const tag = r.skip ? `skip (${r.skip})` : `vtx=${r.vertexCount} subRegionVtx=${r.sub} out(sub)=${r.pctSubOut}% out(all)=${r.pctAllOut}% u[${r.umin?.toFixed(2)},${r.umax?.toFixed(2)}] v[${r.vmin?.toFixed(2)},${r.vmax?.toFixed(2)}]`;
  console.error(`${c.title ?? r.name ?? c.url} :: ${tag}`);
}
const measured = results.filter((r) => !r.skip).sort((a, b) => b.pctSubOut - a.pctSubOut);
console.log(JSON.stringify({ examined, measured, skipped: results.filter((r) => r.skip) }, null, 2));
