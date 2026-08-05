---
name: add-pdf-tools
description: Add PDF reading and generation to agent containers. Installs poppler-utils (pdftotext/pdfinfo/pdftoppm) for extracting text from PDFs, and an html2pdf wrapper that reuses the existing Chromium install to render HTML/Markdown to PDF. Use when the user wants agents to read or produce PDF files.
---

# Add PDF Tools

Gives NanoClaw agents two capabilities: reading text out of existing PDFs, and generating new PDFs from HTML or Markdown. No credentials needed — both are local tools.

**Design choice:** PDF generation reuses the Chromium already installed for `agent-browser` (headless print-to-pdf) instead of adding a dedicated PDF engine. `wkhtmltopdf` pulls ~400MB and is unmaintained upstream; `weasyprint` pulls ~900MB of Python/numpy/scipy; a LaTeX engine is 500MB+. Reusing Chromium costs nothing extra. If [[add-pandoc]] isn't installed yet, install it first — this skill's Markdown-to-PDF path goes through pandoc for the Markdown-to-HTML step.

**Principle:** Do the work — don't tell the user to do it.

## Phase 1: Pre-flight

Check if already applied:

```bash
grep -Eq '^ARG POPPLER_VERSION=' container/Dockerfile && test -f container/html2pdf.sh && test -d container/skills/pdf-tools && echo "INSTALLED" || echo "NOT_INSTALLED"
```

If `INSTALLED`, skip to Phase 4 (Sync Skills).

## Phase 2: Install PDF Tools in the Container Image

Check for all three pieces — poppler-utils, the html2pdf wrapper script, and its Dockerfile wiring:

```bash
grep -Eq '^ARG POPPLER_VERSION=' container/Dockerfile && \
  grep -Eq 'apt-get install[^\n]*"?poppler-utils=\$\{POPPLER_VERSION\}"?' container/Dockerfile && \
  grep -Eq 'COPY html2pdf\.sh /usr/local/bin/html2pdf' container/Dockerfile && \
  echo "PRESENT" || echo "MISSING"
```

If `MISSING`:

1. Copy the wrapper script into the build context:

   ```bash
   cp .claude/skills/add-pdf-tools/html2pdf.sh container/html2pdf.sh
   ```

2. Add this block to `container/Dockerfile`, after the `pandoc` block and before `Entrypoint` (check what poppler-utils version is actually available for the base image's Debian release first — the pin below is dated to `node:22-slim`/bookworm and may drift on a different base image: `docker run --rm node:22-slim sh -c "apt-get update -qq >/dev/null && apt-cache policy poppler-utils" | grep Candidate`):

   ```dockerfile
   # ---- poppler-utils --------------------------------------------------------------
   # PDF text extraction (pdftotext, pdfinfo, pdftoppm). Small and well-maintained
   # compared to a full PDF toolkit, and covers the common "read this PDF" case.
   ARG POPPLER_VERSION=22.12.0-2+deb12u2
   RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
       --mount=type=cache,target=/var/lib/apt,sharing=locked \
       apt-get update && apt-get install -y --no-install-recommends \
           "poppler-utils=${POPPLER_VERSION}" \
       && rm -rf /var/lib/apt/lists/*

   # ---- html2pdf wrapper ------------------------------------------------------------
   # PDF generation without a dedicated PDF engine: reuses the Chromium already
   # installed for agent-browser (headless print-to-pdf) instead of adding
   # wkhtmltopdf (~400MB) or weasyprint (~900MB of Python/numpy/scipy).
   COPY html2pdf.sh /usr/local/bin/html2pdf
   RUN chmod +x /usr/local/bin/html2pdf
   ```

3. If the existing `pandoc` block's comment still claims PDF export requires a group-level `install_packages` self-mod, update it to point at `html2pdf` instead — that limitation is resolved by this skill.

Rebuild the image:

```bash
./container/build.sh
```

If `PRESENT`, everything is already in the image — skip the rebuild.

## Phase 3: Install Container Skill

```bash
rsync -a .claude/skills/add-pdf-tools/container-skills/ container/skills/
head -5 container/skills/pdf-tools/SKILL.md
```

## Phase 3b: Copy and Run the Dependency Guard

```bash
cp .claude/skills/add-pdf-tools/pdf-tools-dockerfile.test.ts src/pdf-tools-dockerfile.test.ts
pnpm exec vitest run src/pdf-tools-dockerfile.test.ts
```

Parses `container/Dockerfile` and asserts the pinned `ARG POPPLER_VERSION=...`, the pinned `poppler-utils` install line, and the `html2pdf` COPY + chmod are all present, plus that `container/html2pdf.sh` exists in the build context. Goes red if any piece is dropped or drifts.

## Phase 4: Sync Skills to Running Agent Groups

```bash
for session_dir in data/v2-sessions/ag-*; do
  if [ -d "$session_dir/.claude-shared/skills" ]; then
    rsync -a container/skills/ "$session_dir/.claude-shared/skills/"
    echo "Synced skills to: $session_dir"
  fi
done
```

## Phase 5: Restart Running Containers

```bash
docker ps --format "{{.ID}} {{.Names}}" | grep nanoclaw-v2 | awk '{print $1}' | xargs -r docker stop
```

## Done

Agents can now read and generate PDFs. Key commands:

- `pdftotext input.pdf -` — extract a PDF's text to stdout
- `pdfinfo input.pdf` — page count and metadata
- `html2pdf input.html output.pdf` — render HTML (or a live URL) to PDF
- `pandoc input.md -o /tmp/doc.html --standalone && html2pdf /tmp/doc.html output.pdf` — Markdown to PDF

The agent has the `pdf-tools` container skill loaded automatically for the full reference.
