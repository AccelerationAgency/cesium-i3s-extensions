#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
// Lists public ArcGIS Online Scene Services and reports which ones exhibit
// atlas textures (uvRegion attribute) and/or a Web Mercator spatial reference.
const QUERIES = [
  'type:"Scene Service" AND access:public AND (tags:buildings OR tags:3D OR title:buildings)',
  'type:"Scene Service" access:public',
  'type:"Scene Service" AND access:public AND (tags:"3D buildings" OR tags:textured OR tags:photorealistic OR tags:city)',
  'type:"Scene Service" AND access:public AND owner:Esri',
];
const WM = new Set([102100, 3857, 102113, 900913]);
const j = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.json();
};

const seen = new Set();
const hits = [];

for (const Q of QUERIES) {
  let start = 1;
  while (start > 0 && start <= 400) {
    const s = await j(
      `https://www.arcgis.com/sharing/rest/search?f=json&num=100&start=${start}&q=${encodeURIComponent(Q)}`
    );
    for (const it of s.results) {
      if (!it.url || !/SceneServer/i.test(it.url)) continue;
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      try {
        const layer = await j(`${it.url.replace(/\/$/, '')}/layers/0?f=json`);
        if (layer.layerType !== '3DObject') continue;
        const wkid = layer.spatialReference?.wkid;
        const attrs = JSON.stringify(layer.store?.defaultGeometrySchema ?? {});
        const atlas =
          attrs.includes('uvRegion') || (layer.textureSetDefinitions ?? []).some((t) => t.atlas);
        if (atlas || WM.has(wkid)) {
          hits.push({
            title: it.title,
            owner: it.owner,
            url: it.url,
            wkid,
            atlas,
            license: it.licenseInfo?.slice(0, 200) ?? '',
            query: Q,
          });
        }
      } catch {
        /* private / broken; skip */
      }
    }
    start = s.nextStart;
  }
}

console.table(hits.map(({ license, query, ...h }) => h));
console.log(JSON.stringify(hits, null, 2));
