# Security

Report a vulnerability privately using GitHub's private vulnerability reporting on this repository: open the **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a suspected vulnerability.

## Scope

This package patches CesiumJS's I3S loading and decoding at runtime and ships a rebuilt copy of Cesium's own decode worker. A security report might reasonably cover this repository's own code (`src/`, `worker/`, the build/verify CLIs) or a way the patch changes CesiumJS's own security posture (for example, content handled differently than stock Cesium handles it). A vulnerability in CesiumJS itself, unrelated to anything this package changes, should go to the CesiumJS project instead.
