/**
 * Dependency guard for the pandoc CLI integration point (host tree, vitest).
 *
 * add-pandoc installs the `pandoc` binary via apt in the agent container image
 * (`container/Dockerfile`). A Dockerfile-installed CLI binary is not importable
 * or typed, so neither `tsc` nor a runtime import can catch its removal — only
 * an image build would, and the skill's validate step does not rebuild the
 * image in CI. This structural test stands in for that build leg: it parses
 * the Dockerfile and asserts both halves of the install are present — the
 * pinned `ARG PANDOC_VERSION=...` and the `apt-get install ... "pandoc=${PANDOC_VERSION}"`
 * line. Drop or drift either and this goes red.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function dockerfile(): string {
  // Walk up from this test file to the repo root (the dir holding container/Dockerfile),
  // so the test works wherever it is copied (src/ on the host, or the skill folder).
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'container', 'Dockerfile');
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    dir = path.dirname(dir);
  }
  throw new Error('container/Dockerfile not found walking up from ' + __dirname);
}

describe('container/Dockerfile installs pandoc', () => {
  const text = dockerfile();

  it('declares a pinned PANDOC_VERSION build arg', () => {
    expect(text).toMatch(/^ARG\s+PANDOC_VERSION=\S+/m);
  });

  it('installs the pinned pandoc apt package', () => {
    expect(text).toMatch(/apt-get install[\s\S]{0,200}?"?pandoc=\$\{PANDOC_VERSION\}"?/);
  });
});
