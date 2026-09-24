// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}
const noop = () => {};
const silent: Logger = { info: noop, warn: noop, error: noop };
const prefixed: Logger = {
  info: (m, ...a) => console.info(`[cesium-i3s] ${m}`, ...a),
  warn: (m, ...a) => console.warn(`[cesium-i3s] ${m}`, ...a),
  error: (m, ...a) => console.error(`[cesium-i3s] ${m}`, ...a),
};
let current: Logger = prefixed;
/** Replace the logger; pass null to silence. */
export function setLogger(l: Logger | null): void { current = l ?? silent; }
export const log: Logger = {
  info: (m, ...a) => current.info(m, ...a),
  warn: (m, ...a) => current.warn(m, ...a),
  error: (m, ...a) => current.error(m, ...a),
};
