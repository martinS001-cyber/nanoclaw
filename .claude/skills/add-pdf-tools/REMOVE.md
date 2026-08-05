# Remove PDF Tools

Every step is idempotent — safe to re-run. Steps delete the files and Dockerfile edits the apply created.

## 1. Remove the container skill

```bash
rm -rf container/skills/pdf-tools
for session_dir in data/v2-sessions/ag-*; do
  rm -rf "$session_dir/.claude-shared/skills/pdf-tools"
done
```

## 2. Remove the dependency guard test

```bash
rm -f src/pdf-tools-dockerfile.test.ts
```

## 3. Remove PDF tooling from the container image

Delete `container/html2pdf.sh`:

```bash
rm -f container/html2pdf.sh
```

Delete the two blocks this skill added to `container/Dockerfile`:

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

If the `pandoc` block's comment was updated to reference `html2pdf`, revert it to note that PDF export isn't available without a group-level `install_packages` self-mod.

Then rebuild the image:

```bash
./container/build.sh
```

## 4. Restart running containers

```bash
docker ps --format "{{.ID}} {{.Names}}" | grep nanoclaw-v2 | awk '{print $1}' | xargs -r docker stop
```
