# Releasing

Maintainer guide. Releases are cut from `main` by a repository maintainer.

## One-time setup

Repository secrets (Settings → Secrets and variables → Actions):

- `NPM_TOKEN` — an npm automation token for the `@accelerationagency` scope. Used only by the publish step of `.github/workflows/release.yml`.
- `SANITIZE_DENYLIST` — the private denylist used by `npm run sanitize` (see [CONTRIBUTING.md](CONTRIBUTING.md#gates)). CI fails on `main` without it.

## Cutting a release

1. **Bump and date.** Set `version` in `package.json` and change the matching `CHANGELOG.md` heading from `unreleased` to the release date. Add release notes under `docs/release-notes/v<version>.md`. Commit and push to `main`; wait for `ci` to pass.
2. **Tag.**
   ```bash
   git tag -a v<version> -m v<version>
   git push origin v<version>
   ```
3. **Dry run.** Run the release workflow against the tag without publishing:
   ```bash
   gh workflow run release.yml --ref v<version> -f dry_run=true
   ```
   Confirm it is green: the guards (public repository, non-private `package.json`, version matches tag), typecheck/test/sanitize, build, worker build/verify, and `npm publish --dry-run` all pass.
4. **Publish.** Create the GitHub release from the existing tag:
   ```bash
   gh release create v<version> --verify-tag --title v<version> --notes-file docs/release-notes/v<version>.md
   ```
   Publishing the release triggers `release.yml`, which repeats the checks, attaches the packed tarball and the built `decodeI3S.js` to the release, and publishes to npm with provenance. An npm version cannot be republished, so treat this step as irreversible.
5. **Verify.** `npm view @accelerationagency/cesium-i3s-extensions@<version>`.
