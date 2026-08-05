# Remove Pandoc

Every step is idempotent — safe to re-run. Steps delete the files and Dockerfile edits the apply created.

## 1. Remove the container skill

Delete the copied container skill and its per-group session copies:

```bash
rm -rf container/skills/pandoc
for session_dir in data/v2-sessions/ag-*; do
  rm -rf "$session_dir/.claude-shared/skills/pandoc"
done
```

## 2. Remove the dependency guard test

```bash
rm -f src/pandoc-dockerfile.test.ts
```

## 3. Remove pandoc from the container image

Delete the block this skill added to `container/Dockerfile`:

```dockerfile
# ---- pandoc --------------------------------------------------------------------
# Document conversion CLI (markdown/html/docx/odt/epub/rst/etc). Pinned to the
# bookworm apt version so a rebuild never silently picks up a newer one. PDF
# output needs a LaTeX engine, which is not installed here (texlive-xetex alone
# is 500MB+) — convert to HTML/DOCX instead, or add it via a group's
# install_packages self-mod if a group genuinely needs PDF export.
ARG PANDOC_VERSION=2.17.1.1-2~deb12u1
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        "pandoc=${PANDOC_VERSION}" \
    && rm -rf /var/lib/apt/lists/*
```

Then rebuild the image:

```bash
./container/build.sh
```

## 4. Restart running containers

So sessions stop loading the removed `pandoc` skill on next wake:

```bash
docker ps --format "{{.ID}} {{.Names}}" | grep nanoclaw-v2 | awk '{print $1}' | xargs -r docker stop
```
