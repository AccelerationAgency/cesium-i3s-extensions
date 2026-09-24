// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 The Acceleration Agency, LLC
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanText } from '../../scripts/sanitize-lib.mjs';
import { loadDenylist } from '../../scripts/load-denylist.mjs';
import { checkCommitMessage } from '../../scripts/check-commit-msg.mjs';

// Neutral fake terms; the real list is private and never committed.
const list = {
  deny: ['acme', 'globex', { term: 'initech', word: true }],
  allow: [{ file: 'README.md', term: 'globex', prefix: 'project' }],
};

describe('scanText', () => {
  it('flags deny terms case-insensitively', () => {
    expect(scanText('src/a.ts', 'const url = "https://x.ACME.example"', list)).toHaveLength(1);
    expect(scanText('src/a.ts', '// GloBex layer', list)).toHaveLength(1);
  });
  it('reports the line number', () => {
    expect(scanText('src/a.ts', 'ok\nok\nacme', list)).toEqual(['src/a.ts:3: denylisted term "acme"']);
  });
  it('matches a plain term inside a longer word', () => {
    expect(scanText('src/a.ts', 'acmecorp', list)).toHaveLength(1);
  });
  it('does not match a word-bounded term inside a longer word', () => {
    expect(scanText('src/a.ts', 'preinitechx', list)).toEqual([]);
    expect(scanText('src/a.ts', 'initechs', list)).toEqual([]);
    expect(scanText('src/a.ts', 'built at Initech.', list)).toHaveLength(1);
    expect(scanText('src/a.ts', 'mail@initech.example', list)).toHaveLength(1);
  });
  it('allows a prefixed term only in its file', () => {
    expect(scanText('README.md', 'Built for ProjectGlobex.', list)).toEqual([]);
    expect(scanText('src/a.ts', 'ProjectGlobex', list)).toHaveLength(1);
  });
  it('still flags the bare term in the allowed file', () => {
    expect(scanText('README.md', 'Our globex library', list)).toHaveLength(1);
    expect(scanText('README.md', 'Built for ProjectGlobex, not globex.', list)).toHaveLength(1);
  });
  it('scopes allow entries to the exact file path', () => {
    expect(scanText('docs/README.md', 'ProjectGlobex', list)).toHaveLength(1);
    expect(scanText('readme.md', 'ProjectGlobex', list)).toHaveLength(1);
  });
  it('allows an unprefixed allow entry anywhere in its file only', () => {
    const l = { deny: ['acme'], allow: [{ file: 'NOTICE', term: 'acme' }] };
    expect(scanText('NOTICE', 'acme and ACME', l)).toEqual([]);
    expect(scanText('NOTICE.md', 'acme', l)).toHaveLength(1);
  });
  it('flags nothing with an empty list', () => {
    expect(scanText('src/a.ts', 'acme globex initech')).toEqual([]);
  });
});

describe('loadDenylist', () => {
  const json = JSON.stringify(list);
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reads .sanitize-denylist from the root', () => {
    fs.writeFileSync(path.join(dir, '.sanitize-denylist'), json);
    expect(loadDenylist({ root: dir, env: {} })).toEqual(list);
  });
  it('prefers the file over the environment', () => {
    fs.writeFileSync(path.join(dir, '.sanitize-denylist'), json);
    expect(loadDenylist({ root: dir, env: { SANITIZE_DENYLIST: '{"deny":["other"]}' } })).toEqual(list);
  });
  it('falls back to SANITIZE_DENYLIST', () => {
    expect(loadDenylist({ root: dir, env: { SANITIZE_DENYLIST: json } })).toEqual(list);
  });
  it('defaults allow to an empty list', () => {
    expect(loadDenylist({ root: dir, env: { SANITIZE_DENYLIST: '{"deny":["acme"]}' } })).toEqual({ deny: ['acme'], allow: [] });
  });
  it('returns null when neither exists (or the env var is blank)', () => {
    expect(loadDenylist({ root: dir, env: {} })).toBeNull();
    expect(loadDenylist({ root: dir, env: { SANITIZE_DENYLIST: '  ' } })).toBeNull();
  });
  it('rejects malformed JSON', () => {
    expect(() => loadDenylist({ root: dir, env: { SANITIZE_DENYLIST: '{nope' } })).toThrow(/invalid JSON/);
    expect(() => loadDenylist({ root: dir, env: { SANITIZE_DENYLIST: '{"allow":[]}' } })).toThrow(/expected/);
  });
});

describe('checkCommitMessage', () => {
  it('accepts a clean message', () => {
    expect(checkCommitMessage('fix(atlas): clamp uv region\n\nBody text.\n', list)).toEqual([]);
  });
  it('rejects a deny term, honouring word bounds', () => {
    expect(checkCommitMessage('feat: support Acme layers\n', list)).toHaveLength(1);
    expect(checkCommitMessage('docs: mention Initech\n', list)).toHaveLength(1);
    expect(checkCommitMessage('docs: preinitechx\n', list)).toEqual([]);
  });
  it('ignores allow entries (they are file-scoped)', () => {
    expect(checkCommitMessage('docs: ProjectGlobex\n', list)).toHaveLength(1);
  });
  it('rejects a Co-Authored-By trailer with or without a list', () => {
    const msg = 'fix: x\n\nCo-authored-by: Someone <a@b.example>\n';
    expect(checkCommitMessage(msg, list)).toHaveLength(1);
    expect(checkCommitMessage(msg, null)).toHaveLength(1);
  });
  it('ignores git comment lines', () => {
    expect(checkCommitMessage('fix: x\n# acme in a template comment\n', list)).toEqual([]);
  });
  it('checks only the trailer rule without a list', () => {
    expect(checkCommitMessage('feat: acme\n', null)).toEqual([]);
  });
});
