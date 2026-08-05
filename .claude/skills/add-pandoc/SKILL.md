---
name: add-pandoc
description: Add pandoc (document conversion CLI) to agent containers. Installs pandoc via apt in the agent image and teaches agents how to convert between Markdown, HTML, DOCX, ODT, EPUB, and other formats. Use when the user wants agents to convert or transform documents between file formats.
---

# Add Pandoc

Gives NanoClaw agents the ability to convert documents between formats (Markdown, HTML, DOCX, ODT, EPUB, RST, LaTeX, etc.) via the `pandoc` CLI. No credentials needed — pandoc is a local binary with no external API.

**Principle:** Do the work — don't tell the user to do it.

## Phase 1: Pre-flight

Check if already applied:

```bash
grep -Eq '^ARG PANDOC_VERSION=' container/Dockerfile && test -d container/skills/pandoc && echo "INSTALLED" || echo "NOT_INSTALLED"
```

If `INSTALLED`, skip to Phase 4 (Sync Skills).

## Phase 2: Install pandoc in the Container Image

Check for both halves of the install — the pinned version arg and the apt install line:

```bash
grep -Eq '^ARG PANDOC_VERSION=' container/Dockerfile && \
  grep -Eq 'apt-get install[^\n]*"?pandoc=\$\{PANDOC_VERSION\}"?' container/Dockerfile && \
  echo "PRESENT" || echo "MISSING"
```

If `MISSING`, add a dedicated block near the other post-CLI RUN steps in `container/Dockerfile` (after the `email-mcp wrapper` block, before `Entrypoint`):

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

Check what pandoc version is actually available for the base image's Debian release before hardcoding the pin — the block above is dated to `node:22-slim` (Debian bookworm) and may drift on a different base image:

```bash
docker run --rm node:22-slim sh -c "apt-get update -qq >/dev/null && apt-cache policy pandoc" | grep Candidate
```

Use whatever version string that reports as `PANDOC_VERSION`.

Rebuild the image:

```bash
./container/build.sh
```

If `PRESENT`, the CLI is already in the image — skip the rebuild.

## Phase 3: Install Container Skill

Copy the bundled container skill into the container skills directory:

```bash
rsync -a .claude/skills/add-pandoc/container-skills/ container/skills/
```

Verify:

```bash
head -5 container/skills/pandoc/SKILL.md
```

## Phase 3b: Copy and Run the Dependency Guard

```bash
cp .claude/skills/add-pandoc/pandoc-dockerfile.test.ts src/pandoc-dockerfile.test.ts
pnpm exec vitest run src/pandoc-dockerfile.test.ts
```

The test parses `container/Dockerfile` and asserts both the `ARG PANDOC_VERSION=...` and the `apt-get install ... "pandoc=${PANDOC_VERSION}"` line are present. It goes red if either is dropped or drifts.

## Phase 4: Sync Skills to Running Agent Groups

Container skills are copied once at group creation and not auto-synced. After installing or updating a container skill, sync it to all existing agent groups:

```bash
for session_dir in data/v2-sessions/ag-*; do
  if [ -d "$session_dir/.claude-shared/skills" ]; then
    rsync -a container/skills/ "$session_dir/.claude-shared/skills/"
    echo "Synced skills to: $session_dir"
  fi
done
```

## Phase 5: Restart Running Containers

Stop all running agent containers so they pick up the new skill and the rebuilt image on next wake:

```bash
docker ps --format "{{.ID}} {{.Names}}" | grep nanoclaw-v2 | awk '{print $1}' | xargs -r docker stop
```

## Done

Agents can now convert documents between formats. Key commands:

- `pandoc input.md -o output.html` — Markdown to HTML
- `pandoc input.md -o output.docx` — Markdown to Word
- `pandoc input.docx -o output.md` — Word to Markdown

PDF output is not included (see the `pandoc` container skill for why and the workaround). For the full usage reference, the agent has the `pandoc` container skill loaded automatically.
