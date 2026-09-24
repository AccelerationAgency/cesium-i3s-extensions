# Contributing

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By submitting a contribution, you agree it is licensed under Apache-2.0, the same license as the rest of this project (inbound = outbound) — see the checklist in the [pull request template](.github/pull_request_template.md).

## Setup

```sh
npm install
git config core.hooksPath .githooks
```

The second command points git at this repo's hooks (`.githooks/pre-commit`, `.githooks/commit-msg`) instead of the default `.git/hooks`, which git does not run unless told to.

## Gates

Every commit must pass, in order:

```sh
npm run typecheck
npm test
npm run sanitize
```

`.githooks/pre-commit` runs all three automatically once `core.hooksPath` is set. `sanitize` (`scripts/sanitize-check.mjs`) runs `gitleaks` for secrets and, when configured, scans every tracked/staged file against a private denylist of internal names; it fails the commit if either finds anything. `.githooks/commit-msg` rejects `Co-Authored-By` trailers and, when the denylist is configured, messages containing a listed name.

The denylist is not part of this repository. Contributors do not need it: without it, `sanitize` prints a warning and runs `gitleaks` only, and CI applies the full check on `main`.

Maintainers: the list is JSON, `{ "deny": [...], "allow": [...] }` (`deny` entries are strings or `{ "term", "word": true }` for word-bounded matching; `allow` entries are `{ "file", "term", "prefix"? }`). Supply it locally as `.sanitize-denylist` in the repo root (gitignored — never commit it) or via the `SANITIZE_DENYLIST` environment variable. CI reads it from the `SANITIZE_DENYLIST` repository secret; the sanitize step fails on `main` if that secret is missing.

## Regenerating the worker patch

`worker/patched/decodeI3S.js` is the patched worker, checked in directly. `worker/decodeI3S.patch` is a reviewable diff of it against the stock `@cesium/engine` source — it exists for review, not for applying; nothing reads it at build or run time. After editing `worker/patched/decodeI3S.js`, regenerate the diff:

```sh
npm run worker:diff
```

This runs `worker/make-patch.mjs`, which diffs your installed `node_modules/@cesium/engine/Source/Workers/decodeI3S.js` against `worker/patched/decodeI3S.js` and overwrites `worker/decodeI3S.patch`. Commit the updated patch file alongside your change to `worker/patched/decodeI3S.js`.

## Bumping the Cesium version

This package pins `cesium` and `@cesium/engine` to exact versions (see `README.md` § Compatibility) because the worker patch is hand-derived against one specific `decodeI3S.js` source, not maintained as an abstract diff that applies cleanly to any version. Bumping the supported Cesium version is not a version-number change; it requires:

1. Installing the new `cesium` / `@cesium/engine` locally and diffing the new `Source/Workers/decodeI3S.js` against the version this package currently patches.
2. Re-deriving `worker/patched/decodeI3S.js` from the new stock source — reapplying the same logical changes (Web Mercator scale folding, `_UV_REGION_0` emission, the de-indexing fix — see `docs/01-web-mercator-i3s.md` and `docs/02-atlas-uv.md`) to whatever the new source looks like, not a mechanical patch-apply.
3. Updating `worker/base.json` (`engine`, `cesium`, `sha256` of the new stock `decodeI3S.js`) — `cesium-i3s-build-worker` refuses to run against a version/hash that doesn't match this file, by design.
4. Regenerating `worker/decodeI3S.patch` (`npm run worker:diff`).
5. Re-running the full test suite and the demo against real scene layers before merging — the worker patch has no automated coverage for whether it still matches the new engine's internal call shape beyond what `test/unit/worker-build.test.ts` and `cesium-i3s-verify-worker`'s marker check catch.

## Code layout

- `src/` — the library itself (`projected/`, `atlas/`, `tuning/`), zero runtime dependencies.
- `worker/` — the patched decode worker and the CLIs that build/verify it against a consumer's installed Cesium. May depend on `esbuild`.
- `demo/` — a local-only comparison demo against public ArcGIS Online layers. `npm run demo` builds the worker and starts it.
- `test/unit/` — Vitest unit tests, including a JS import of `worker/src/workerMath.js` (hence `allowJs: true` in `tsconfig.json`).
