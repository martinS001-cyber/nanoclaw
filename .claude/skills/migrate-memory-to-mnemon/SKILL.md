---
name: migrate-memory-to-mnemon
description: Distill an agent group's flat CLAUDE.local.md into mnemon's insights[] graph store and import it, so mnemon has continuity with the group's existing memory instead of starting empty. Run after /add-mnemon is installed, per group, as a one-time seed. Triggers on "migrate memory to mnemon", "import CLAUDE.local.md into mnemon", "seed mnemon".
---

# Migrate CLAUDE.local.md into mnemon

`/add-mnemon` only wires the hooks — mnemon's graph starts empty and only captures things going forward, from live conversation. It never retroactively reads `CLAUDE.local.md`. This skill is the one-time seed step: read the group's existing flat memory, distill it into mnemon's import schema, and load it in.

**You (the coding agent) are the distillation step.** There is no mechanical parser for this — you read the markdown and use judgment to produce discrete, durable insights, same as `/migrate-memory`'s flat→scaffold step.

Principles: **copy, never move** (`CLAUDE.local.md` stays intact — side-by-side is the safe default, see Step 4), **idempotent** (`mnemon import` dedupes on re-run), **distill, don't dump** (drop conversational residue; split the file into discrete facts, not one giant blob — mnemon ranks and recalls per-insight, so a single 8000-char dump defeats the purpose).

## Step 0: Preconditions

- `/add-mnemon` must already be installed and the container image rebuilt (`grep -q MNEMON_VERSION container/Dockerfile`). If not, stop and run that first.
- Confirm the group runs the Claude provider — mnemon hooks only fire under `AGENT_PROVIDER=claude` (see `/add-mnemon`'s Provider Compatibility section).
- Confirm the group is actually live: it must have a row in `agent_groups` (`pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, folder, name FROM agent_groups"`). A `groups/<folder>/` directory with no matching DB row is orphaned — nothing will ever read a mnemon store seeded for it. Resolve that separately before migrating it.

## Step 1: Read the source

Read `groups/<folder>/CLAUDE.local.md` and any satellite files it references (e.g. `family.md`, `health.md` — anything linked from the group's memory system per the container's own `## Memory` instructions).

## Step 2: Distill into a memory draft

Produce a JSON file matching mnemon's Schema v1 (full reference: `docs/IMPORT.md` in the mnemon repo). Shape:

```json
{
  "schema_version": "1",
  "source": "claude-local-md",
  "insights": [
    {
      "content": "...",
      "category": "preference|decision|fact|insight|context|general",
      "importance": 1-5,
      "tags": ["lowercase-hyphenated"],
      "entities": ["Proper Nouns"],
      "created_at": "RFC3339 if inferable from the file (dated entries), otherwise omit"
    }
  ]
}
```

Extraction rules:

1. Each insight must stand alone — understandable without the original file.
2. One fact/preference/decision per insight, not whole sections dumped verbatim. A markdown file organized by topic (e.g. `## Ham Radio`, `## Home Assistant`) typically yields several insights per section, not one.
3. Merge duplicate mentions of the same fact into a single insight instead of repeating it.
4. Importance: 5 = core identity/seed instruction or explicit strong preference, 4 = important recurring context, 3 = normal fact (default), 2 = minor/one-off detail, 1 = stale/pending/low-value.
5. Entities: concrete nouns — people, devices, hosts, projects, services.
6. Tags: lowercase, hyphen-separated.
7. Preserve dates already in the text (`created_at`) where the file states one; skip it otherwise — do not guess.
8. Skip pure boilerplate (assistant persona description that's just the scaffold template, not personalized) — that belongs in `CLAUDE.md`/`CLAUDE.local.md` framing, not mnemon.

Write the draft to a scratch path outside the repo (e.g. `/tmp/mnemon-import-<folder>.json`) — **never commit it**, and delete it after Step 3 confirms the import succeeded. Group memory files routinely contain live credentials (passwords, tokens, API keys); treat the draft file with the same care as the source.

## Step 3: Validate, then import

mnemon needs to run against the same host directory the group's real container mounts to `/home/node/.claude` — that's where `MNEMON_DATA_DIR` (`/home/node/.claude/mnemon`) resolves. You don't need a live container; a one-off `docker run` against the same mount works and won't collide with the running session (mnemon's SQLite store handles concurrent access).

1. Find the group's agent-group id and host mount:
   ```bash
   pnpm exec tsx scripts/q.ts data/v2.db "SELECT id FROM agent_groups WHERE folder = '<folder>'"
   # host path: data/v2-sessions/<agent-group-id>/.claude-shared
   ```
2. Dry-run:
   ```bash
   docker run --rm \
     -v "$(pwd)/data/v2-sessions/<agent-group-id>/.claude-shared:/home/node/.claude" \
     -v "/tmp/mnemon-import-<folder>.json:/tmp/import.json:ro" \
     --entrypoint mnemon nanoclaw-agent:latest \
     import /tmp/import.json --dry-run
   ```
   (Substitute the actual local image tag — check `docker images | grep nanoclaw-agent` if `nanoclaw-agent:latest` isn't it.)
3. Inspect the dry-run output: `errors` must be `0`. Skim `results[]` for anything that looks wrong (bad category, truncated content) before committing.
4. Run for real (same command, drop `--dry-run`). Check `imported`/`updated`/`errors` in the output.
5. Delete the scratch draft file: `rm /tmp/mnemon-import-<folder>.json`.

## Step 4: Keep both stores side by side (default) or retire the flat file

Per mnemon's own tradeoffs: running both is a safe transition state, not a permanent end state — you pay token cost twice for facts in both stores. Default to keeping `CLAUDE.local.md` in place until Step 5 confirms mnemon actually recalls the migrated facts; only trim/retire it afterward, and only if the operator asks — this skill does not delete or edit the source file on its own.

## Step 5: Verify

Have a conversation with the group that depends on a migrated fact (something not restated in the message itself), in a fresh session if possible, and confirm the agent recalls it without the flat file being the only source (temporarily renaming `CLAUDE.local.md` aside and back is the strongest test, but a normal conversation checking mnemon surfaced the fact is usually enough for a spot check).
