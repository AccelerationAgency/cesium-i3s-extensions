// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
export { setLogger, type Logger } from './log.js';
export { installProjectedI3SSupport, isWebMercatorWkid, webMercatorToDegrees } from './projected/index.js';
export { createAtlasUvShader, attachAtlasShader, setAtlasDemoMode, getAtlasDemoMode, type AtlasMode } from './atlas/index.js';
export { i3sTilesetDefaults, createVisibilityLoader, type LayerDef, type LayerStatus, type VisibilityLoader } from './tuning/index.js';
