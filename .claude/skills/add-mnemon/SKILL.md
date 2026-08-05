---
name: add-mnemon
description: Add persistent graph-based memory via mnemon. Agents recall past context before responding and remember insights after each turn.
---

# Add Mnemon — Persistent Memory

Installs [mnemon](https://github.com/mnemon-dev/mnemon) in the agent container image. On each container start, `mnemon setup` registers Claude Code hooks that surface relevant memory before the agent responds and store new insights after each turn. Memory is written to the per-agent-group `.claude/` mount and survives container restarts.

## Provider Compatibility

mnemon hooks fire only under `--target claude-code`. Use this skill on agent groups that run the default Claude provider (`AGENT_PROVIDER=claude`). Confirm the provider before applying:

```bash
grep AGENT_PROVIDER .env groups/*/container.json 2>/dev/null
```

If a group uses a different provider (e.g. `AGENT_PROVIDER=opencode`), it spawns its own process and never invokes the `claude` CLI, so the hooks registered by `mnemon setup` do not run for that group.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'MNEMON_VERSION' container/Dockerfile && echo "Already applied" || echo "Not applied"
```

If already applied, re-run Phase 2 anyway — every step is idempotent and skips work that is already in place — then continue to Phase 3 (Verify).

### Check latest mnemon version

```bash
curl -fsSL https://api.github.com/repos/mnemon-dev/mnemon/releases/latest | grep '"tag_name"'
```

Note the version (e.g. `v0.1.1`) — use it as `MNEMON_VERSION` in the next step.

## Phase 2: Apply Changes

### 1. Dockerfile — install mnemon binary

Insert the mnemon block immediately above the `# ---- Bun runtime` section of `container/Dockerfile` (skip if `grep -q 'MNEMON_VERSION' container/Dockerfile` already matches):

```dockerfile
# ---- mnemon — persistent agent memory ----------------------------------------
ARG MNEMON_VERSION=0.1.1
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin mnemon && \
    chmod +x /usr/local/bin/mnemon

ENV MNEMON_DATA_DIR=/home/node/.claude/mnemon
```

`MNEMON_DATA_DIR` points into the per-agent-group `.claude/` mount, so memory persists across container restarts.

### 2. Wire mnemon setup into the actual runtime spawn command

**`container/entrypoint.sh` is not the runtime path for real sessions.** NanoClaw v2's dynamic container spawn overrides the Dockerfile `ENTRYPOINT` entirely — `src/container-runner.ts`'s `buildContainerArgs` pushes `--entrypoint bash` and its own `-c '<script>'`, so `entrypoint.sh` (and the `tini` PID 1 it runs under) never executes for a real session. Wiring `mnemon setup` only into `entrypoint.sh` looks correct but silently does nothing — no error, no log line, hooks just never register. Verify this assumption still holds before applying (v2's architecture could change):

```bash
grep -n "'-c'," src/container-runner.ts
```

You should see a line like `args.push('-c', 'exec bun run /app/src/index.ts');`. That is the real target.

First check whether it's already wired:

```bash
grep -q 'mnemon setup' src/container-runner.ts && echo "Already wired" || echo "Wire it"
```

If it prints `Wire it`, change that line so mnemon setup runs first, in the same script, joined with `;` (not `&&` — a mnemon failure, or mnemon simply not being installed, must never block the agent from starting):

```typescript
  args.push(
    '-c',
    'mnemon setup --target claude-code --yes --global >/dev/stderr 2>&1; exec bun run /app/src/index.ts',
  );
```

Also add the same line to `container/entrypoint.sh` (right after `set -e`, before the `cat` that captures stdin) for parity with the Dockerfile's own `ENTRYPOINT` — that path is dead for real sessions but is still what `docker run -i <image>` (the manual smoke-test invocation `build.sh` prints) goes through, so keeping it in sync avoids the two paths silently diverging:

```bash
set -e

mnemon setup --target claude-code --yes --global >/dev/stderr 2>&1

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json
```

### 3. Copy the integration tests

Three reach-ins guard files that aren't importable or typed the normal way (a GitHub-release binary in the Dockerfile, a shell line in the entrypoint, an inline shell script string in host TypeScript). Copy the container-level tests into the host test tree; the container-runner regression test is written inline in Step 2's own file, so add it directly to `src/container-runner.test.ts` rather than copying:

```bash
cp .claude/skills/add-mnemon/mnemon-dockerfile.test.ts src/mnemon-dockerfile.test.ts
cp .claude/skills/add-mnemon/mnemon-entrypoint.test.ts src/mnemon-entrypoint.test.ts
pnpm exec vitest run src/mnemon-dockerfile.test.ts src/mnemon-entrypoint.test.ts
```

`mnemon-dockerfile.test.ts` asserts the `MNEMON_VERSION` ARG and `MNEMON_DATA_DIR` ENV are present (red if the install layer is dropped on an upgrade). `mnemon-entrypoint.test.ts` asserts `entrypoint.sh` invokes `mnemon setup --target claude-code` (red if that parity copy is removed — but note this alone does NOT prove hooks work at runtime, see above). Add a matching structural test to `src/container-runner.test.ts` asserting the `-c` script contains `mnemon setup` before `exec bun run`, joined by `;` not `&&` — that's the one that actually guards runtime behavior. Then rebuild the host (`pnpm run build`) since this step edits `src/`.

### 4. Rebuild the host, rebuild the image, smoke-test the binary

Step 2 edited `src/container-runner.ts`, so the host TypeScript needs rebuilding too, not just the container image:

```bash
pnpm run build
./container/build.sh
docker run --rm --entrypoint mnemon nanoclaw-agent:latest --version
```

Any agent group with custom apt/npm packages runs a **derived** per-group image built `FROM` the base image (check `container_configs.packages_apt`/`packages_npm` per group, or just `docker images | grep nanoclaw-agent` for extra tags beyond `:latest`). Rebuilding the base image does not touch those — they keep the old base layer (no mnemon) until explicitly rebuilt:

```bash
ncl groups restart --id <agent-group-id> --rebuild
```

Do this for every group with a derived image before moving on, or that group's containers will keep spawning without mnemon.

## Phase 3: Restart and Verify

### Restart the service

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
```

### Confirm mnemon hooks are registered

This requires a **real** container spawn — send an actual message to a group wired to this install (a synthetic `docker run` won't exercise `container-runner.ts`'s spawn path). After that, check that setup ran:

```bash
docker logs $(docker ps --filter name=nanoclaw-v2 --format '{{.Names}}' | head -1) 2>&1 | grep -i mnemon
```

If that's empty, don't assume it's fine — it means setup did not run. Re-check Step 2: confirm the live `-c` script (`grep -n "'-c'," src/container-runner.ts`) actually contains `mnemon setup`, that `pnpm run build` ran after the edit, and that the service was restarted after the build (an unbuilt or unrestarted host keeps spawning containers with the old command).

Then inspect the hooks inside the running container:

```bash
docker exec $(docker ps --filter name=nanoclaw-v2 --format '{{.Names}}' | head -1) \
  cat /home/node/.claude/settings.json | grep -A5 mnemon
```

### Test memory recall

Have a conversation with the agent, then start a new session and reference something from the earlier one. Mnemon should surface the relevant context automatically without you restating it.

## Memory Storage

Mnemon writes to `/home/node/.claude/mnemon/` inside the container, which maps to the per-agent-group `.claude/` directory on the host. To find the exact host path:

```bash
docker inspect $(docker ps --filter name=nanoclaw-v2 --format '{{.Names}}' | head -1) \
  --format '{{range .Mounts}}{{if eq .Destination "/home/node/.claude"}}{{.Source}}{{end}}{{end}}'
```

To reset all memory for an agent, stop the container and delete the `mnemon/` subdirectory from that host path.

## Troubleshooting

### `mnemon: command not found` in container

The image wasn't rebuilt after adding the Dockerfile layer. Run `./container/build.sh` and restart.

### Memory not persisting across restarts

Verify `MNEMON_DATA_DIR` resolves to a mounted path (not an in-container ephemeral directory):

```bash
docker exec <container> sh -c 'ls -la $MNEMON_DATA_DIR'
```

If the directory is empty after conversations, the mount is missing or the path is wrong. Check the host mount with the `docker inspect` command above.

### Agent not using past memory

`mnemon setup` writes hooks into `/home/node/.claude/settings.json`. Verify:

```bash
docker exec <container> cat /home/node/.claude/settings.json
```

If the hooks are absent, `mnemon setup` may have failed silently. Check container startup logs for errors from mnemon.

### Setup fails at container start

Run setup manually inside a running container to see the full error:

```bash
docker exec -it <container> mnemon setup --target claude-code --yes --global
```
