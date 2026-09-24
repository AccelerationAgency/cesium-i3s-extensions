# Upstream PR draft: I3S layer loading and memory (docs + Sandcastle)

- **Branch:** `i3s-docs-layer-loading` (local clone, branched from tag `1.138`, one commit)
- **Target:** `CesiumGS/cesium` `main` (rebase onto `main` on release day)
- **Requires CLA signature:** yes. Sign the Cesium Contributor License Agreement (individual, or corporate for the company) before opening the PR.
- **Scope:** documentation and a Sandcastle only. No behavior change.

## Title

Document I3S layer loading and memory

## Description

### Problem

A common way to build a layer picker is to create an `I3SDataProvider` for every layer the app offers, add them all to the scene, and toggle `show`. Two things about this are not documented:

- `I3SDataProvider.fromUrl` requests the layer JSON, node pages and root nodes of every layer it contains, whether or not the provider is ever shown.
- Hiding a provider stops it from requesting and rendering tiles, but tiles loaded while it was visible stay cached, up to each layer tileset's `cacheBytes`. The tileset cache only trims down to `cacheBytes`, and while a tileset is hidden nothing marks its tiles as still in use. In an app with many layers, memory held by layers that were visible once and then hidden adds up, and `show = false` does not release it.

A second trap: lowering `cacheBytes` to save memory backfires if it drops below what the current view needs. Tiles that are still needed get evicted, then requested and decoded again on the following frames.

### Change

- JSDoc for `I3SDataProvider#show`: a hidden dataset does not request or render tiles (unless `preloadWhenHidden` is set in `cesium3dTilesetOptions`). Tiles loaded while it was shown stay cached up to each layer tileset's `cacheBytes`. Removing the provider from the scene destroys it and releases that memory. Apps with many layers should create each provider the first time its layer is shown. The `show` constructor option links to the property.
- New Sandcastle `packages/sandcastle/gallery/i3s-layer-loading`. It offers two public layers already used in other Sandcastles (San Francisco 3D Objects and the Frankfurt integrated mesh) and creates each provider only the first time its toggle is switched on. It passes `cesium3dTilesetOptions` with a comment explaining why `cacheBytes` should not go below the view's working set, and it has an "Unload hidden layers" button that removes (and so destroys) hidden providers.

### How tested

- `npx prettier --check` on all 4 changed files (`I3SDataProvider.js` and the three Sandcastle files): "All matched files use Prettier code style!". `npx eslint` on the 2 changed `.js` files: exit 0. `npm run build-ts` succeeds, so the JSDoc parses. `npm run build-gallery` builds the gallery list, including the new Sandcastle.
- `npm run test -- --browsers ChromeHeadlessGL --includeName "Scene/I3S" --failTaskOnError --suppressPassed` passes 121/121 (`ChromeHeadlessGL` is a local, uncommitted SwiftShader launcher). There are no code changes, so this is only a sanity check.
- The Sandcastle has not been run in a browser against the live services yet. Do that before opening the PR, and add a 225x150 `thumbnail.jpg`.

For the PR text, the problem was found in an application that loaded every configured building layer and toggled visibility. Loading only the layers that are shown fixed it, and lowering `cacheBytes` below the working set made it worse (many more repeated tile requests). Those measurements came from that application, not from this Sandcastle, so the PR should describe them qualitatively and not quote numbers.

### Applies to current `main`?

Yes. `git merge-tree --write-tree origin/main i3s-docs-layer-loading` merges cleanly (checked 2026-09-23).

### CHANGES.md

Documentation-only; no entry needed. If the maintainers want one:

```
- Added an I3S Sandcastle and documentation about loading layers on demand and releasing their memory. [#XXXXX](https://github.com/CesiumGS/cesium/pull/XXXXX)
```
