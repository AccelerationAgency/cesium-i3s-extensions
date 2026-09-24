// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// CESIUM_BASE_URL is set by an inline script in index.html, before the module
// script runs. The patched decodeI3S.js lives in demo/public/cesium/Workers
// (written by `npm run worker:build`); Vite serves public/ ahead of the
// plugin-copied files in dev, and `overwrite: false` keeps it in `vite build`.
export default defineConfig({
  root: __dirname,
  plugins: [viteStaticCopy({ targets: [
    { src: '../node_modules/cesium/Build/Cesium/{Assets,ThirdParty,Widgets}', dest: 'cesium' },
    { src: '../node_modules/cesium/Build/Cesium/Workers/*', dest: 'cesium/Workers', overwrite: false },
  ] })],
  server: { port: 5199 },
});
