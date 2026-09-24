// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
import fs from 'node:fs';
import path from 'node:path';

export const DENYLIST_FILE = '.sanitize-denylist';

/** @typedef {{ deny: import('./sanitize-lib.mjs').DenyEntry[], allow: import('./sanitize-lib.mjs').AllowEntry[] }} Denylist */

/** @param {string} json @param {string} source @returns {Denylist} */
function parse(json, source) {
  let data;
  try { data = JSON.parse(json); } catch (e) { throw new Error(`${source}: invalid JSON (${e.message})`); }
  if (!data || !Array.isArray(data.deny)) throw new Error(`${source}: expected { "deny": [...], "allow": [...] }`);
  return { deny: data.deny, allow: Array.isArray(data.allow) ? data.allow : [] };
}

// Loads the private denylist from <root>/.sanitize-denylist, or from the
// SANITIZE_DENYLIST environment variable (same JSON). Returns null if neither
// is present.
/**
 * @param {{ root?: string, env?: Record<string, string | undefined> }} [opts]
 * @returns {Denylist | null}
 */
export function loadDenylist({ root = process.cwd(), env = process.env } = {}) {
  const file = path.join(root, DENYLIST_FILE);
  if (fs.existsSync(file)) return parse(fs.readFileSync(file, 'utf8'), DENYLIST_FILE);
  if (env.SANITIZE_DENYLIST && env.SANITIZE_DENYLIST.trim()) return parse(env.SANITIZE_DENYLIST, 'SANITIZE_DENYLIST');
  return null;
}
