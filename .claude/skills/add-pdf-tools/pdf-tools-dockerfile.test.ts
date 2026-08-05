/**
 * Dependency guard for the PDF tooling integration point (host tree, vitest).
 *
 * add-pdf-tools installs `poppler-utils` via apt and copies an `html2pdf`
 * wrapper script into the agent container image (`container/Dockerfile`).
 * Neither a Dockerfile-installed apt package nor a copied shell script is
 * importable or typed, so only an image build would catch their removal, and
 * the skill's validate step does not rebuild the image in CI. This structural
 * test stands in for that build leg: it parses the Dockerfile and asserts
 * every half of both installs is present. Drop or drift any of them and this
 * goes red.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'container', 'Dockerfile'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('container/Dockerfile not found walking up from ' + __dirname);
}

function dockerfile(): string {
  return fs.readFileSync(path.join(repoRoot(), 'container', 'Dockerfile'), 'utf8');
}

describe('container/Dockerfile installs PDF tooling', () => {
  const text = dockerfile();

  it('declares a pinned POPPLER_VERSION build arg', () => {
    expect(text).toMatch(/^ARG\s+POPPLER_VERSION=\S+/m);
  });

  it('installs the pinned poppler-utils apt package', () => {
    expect(text).toMatch(/apt-get install[\s\S]{0,200}?"?poppler-utils=\$\{POPPLER_VERSION\}"?/);
  });

  it('copies the html2pdf wrapper into the image and makes it executable', () => {
    expect(text).toMatch(/COPY\s+html2pdf\.sh\s+\/usr\/local\/bin\/html2pdf/);
    expect(text).toMatch(/chmod \+x \/usr\/local\/bin\/html2pdf/);
  });
});

describe('the html2pdf wrapper script', () => {
  it('exists in the container build context', () => {
    expect(fs.existsSync(path.join(repoRoot(), 'container', 'html2pdf.sh'))).toBe(true);
  });
});
