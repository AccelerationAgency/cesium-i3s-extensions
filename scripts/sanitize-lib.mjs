// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC

// The term list is private and supplied by the caller (see load-denylist.mjs);
// nothing in this file names a term.
//
// deny:  entries are either a string or { term, word?: boolean }. Matching is
//        case-insensitive. With word: true the match must not be preceded or
//        followed by a letter (so "foo" does not match inside "xfoox").
// allow: { file, term, prefix? }. The term is permitted in that exact file; if
//        prefix is set, only where it is immediately preceded by that prefix.

/** @typedef {string | { term: string, word?: boolean }} DenyEntry */
/** @typedef {{ file: string, term: string, prefix?: string }} AllowEntry */

/** @param {DenyEntry[] | undefined} deny */
function normalizeDeny(deny) {
  return (deny ?? []).map((d) => (typeof d === 'string'
    ? { term: d.toLowerCase(), word: false }
    : { term: String(d.term).toLowerCase(), word: Boolean(d.word) }));
}

/**
 * @param {string} path repo-relative path (used for allow scoping and messages)
 * @param {string} text file contents
 * @param {{ deny?: DenyEntry[], allow?: AllowEntry[] }} [list]
 * @returns {string[]} one message per hit
 */
export function scanText(path, text, { deny = [], allow = [] } = {}) {
  const lower = text.toLowerCase();
  const out = [];
  for (const { term, word } of normalizeDeny(deny)) {
    if (!term) continue;
    const allowEntries = allow.filter((a) => a.file === path && String(a.term).toLowerCase() === term);
    let i = lower.indexOf(term);
    while (i !== -1) {
      let isMatch = true;
      if (word) {
        const before = i > 0 ? lower[i - 1] : ' ';
        const after = i + term.length < lower.length ? lower[i + term.length] : ' ';
        isMatch = !/[a-z]/.test(before) && !/[a-z]/.test(after);
      }
      const allowed = isMatch && allowEntries.some((a) => {
        if (!a.prefix) return true;
        const p = String(a.prefix).toLowerCase();
        return lower.slice(Math.max(0, i - p.length), i) === p;
      });
      if (isMatch && !allowed) {
        const line = lower.slice(0, i).split('\n').length;
        out.push(`${path}:${line}: denylisted term "${term}"`);
      }
      i = lower.indexOf(term, i + term.length);
    }
  }
  return out;
}
