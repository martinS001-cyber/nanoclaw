---
name: add-buzz
description: Add Buzz (block/buzz) channel integration — a self-hosted Nostr-based team workspace where humans and AI agents share channels. Native adapter, Phase 1 MVP — text-only, single identity, buzz-cli polling. No Chat SDK bridge.
---

# Add Buzz Channel

The adapter shells out to the `buzz` binary (crate `buzz-cli`) — pure `child_process.execFile`, no Node client library, since `buzz-cli` is the only supported way to talk to a Buzz relay today. **This is a Phase 1 MVP**: single Nostr identity, text-only messages, polling-based inbound (no subscribe/stream mode exists in `buzz-cli`). DMs, attachments/voice, multi-identity, and real-time presence are explicitly out of scope — see "Known limitations" below.

The command-level CLI flags used below (`messages get/send/edit`, `reactions add`, `users get`) are verified against a live `buzz --help` (built from `github.com/block/buzz`). ⚠️ **The exact JSON field names on `messages get`'s output rows are not yet verified against a live relay round-trip** — see "Verify against a live binary" before relying on this in production.

## Install

### Pre-flight (idempotent)

Skip to **Host prerequisite** if all of these are already in place:

- `src/channels/buzz.ts` exists
- `src/channels/buzz-registration.test.ts` exists
- `src/channels/index.ts` contains `import './buzz.js';`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter and its registration test

```bash
git show origin/channels:src/channels/buzz.ts                 > src/channels/buzz.ts
git show origin/channels:src/channels/buzz-registration.test.ts > src/channels/buzz-registration.test.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if already present):

```typescript
import './buzz.js';
```

### 4. No package install needed

The adapter uses only Node.js builtins (`child_process`, `fs`, `util`) — same zero-dependency posture as the Signal adapter. Nothing to `pnpm install`.

### 5. Build and validate

```bash
pnpm run build
pnpm exec vitest run src/channels/buzz-registration.test.ts
```

Both must be clean before proceeding. `buzz-registration.test.ts` is the one integration test: it imports the real channel barrel and asserts the registry contains `buzz`. It goes red if the `import './buzz.js';` line is deleted or the barrel fails to evaluate. Importing is safe: `buzz.ts` only shells out to the `buzz` binary inside `setup()` (run at host startup) and its poll loop, never at import.

## Host prerequisite — build the `buzz` binary

Unlike the pnpm-managed packages other channels use, `buzz-cli` is a Rust binary with no published prebuilt release as of this writing. Build it via a throwaway container (same method already used to build it for in-container use on other Buzz-hosting infrastructure) — this does **not** require Rust/Cargo on the NanoClaw host itself, only Docker (already a hard dependency of this project):

```bash
mkdir -p buzz-build
docker run --rm -v "$PWD/buzz-build:/out" rust:1-bookworm bash -c '
  git clone --depth 1 https://github.com/block/buzz.git /src &&
  cd /src && cargo build --release -p buzz-cli &&
  cp target/release/buzz /out/'
mkdir -p ~/.local/bin
mv buzz-build/buzz ~/.local/bin/buzz
chmod +x ~/.local/bin/buzz
rm -rf buzz-build
buzz --version   # verify it's on PATH and runs
```

The built executable is named `buzz` (the crate is `buzz-cli`, but its `[[bin]]` output is `buzz`) — keep it named `buzz` on `PATH`, matching every command the adapter shells out to (`buzz messages send`, `buzz users get`, etc.). Ensure `~/.local/bin` is on the `PATH` the NanoClaw host process runs with (check the systemd/launchd service unit's `Environment=`/`PATH` if it doesn't inherit your interactive shell's).

## Credentials

Add to `.env`:

```bash
BUZZ_RELAY_URL=wss://your-relay-domain.example
BUZZ_IDENTITIES=data/buzz/identities.json
```

Sync to container mount (only needed if you later add Buzz as an agent-side MCP tool too — not required for the channel adapter itself, which is host-only):

```bash
mkdir -p data/env && cp .env data/env/env
```

### Identity file — `data/buzz/identities.json`

**Create this file manually.** It holds private Nostr keys (`nsec`) — this is deliberately *not* scripted or auto-populated from any other file, even if a key already exists elsewhere (e.g. an agent's own prior ad hoc Buzz experiments). A secret this sensitive should be a conscious action by whoever runs the install, not something a skill quietly copies on its own.

```bash
mkdir -p data/buzz
chmod 700 data/buzz
```

Then create `data/buzz/identities.json` by hand. **The key must be the 64-char hex pubkey, not bech32 `npub1...`** — confirmed against a live binary: `buzz users get --pubkey` rejects npub outright (`"must be a 64-character hex string"`). If you only have an `npub`/`nsec` pair from the Buzz desktop app, decode the npub to hex first (e.g. `buzz pack` tooling or any NIP-19 decoder — the desktop app's own key-export screen sometimes shows both forms). `nsec` itself may stay bech32 or hex — `--private-key`/`BUZZ_PRIVATE_KEY` accepts either.

```json
{
  "<64-char-hex-pubkey-of-the-identity>": {
    "nsec": "nsec1...",
    "agentGroupId": "<the NanoClaw agent_group id this identity belongs to>",
    "name": "<display name>",
    "channelId": "<the Buzz channel UUID this identity is a member of and will poll>"
  }
}
```

```bash
chmod 600 data/buzz/identities.json
```

Confirm `data/buzz/` is git-ignored before committing anything else in the repo:

```bash
grep -q '^data/buzz/' .gitignore || echo 'data/buzz/' >> .gitignore
```

The identity must **already be a registered relay member** of the channel it names (via `buzz-admin add-member` on the relay host, or the Buzz desktop app) — `setup()` validates this on startup and throws a clear error (redacted, never logging the nsec) if it isn't.

### Restart

```bash
source setup/lib/install-slug.sh

# Linux
systemctl --user restart $(systemd_unit)

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
```

## Verify against a live binary

**Confirmed** against a live `buzz --help` (built 2026-08-13 from `github.com/block/buzz` main):

| Confirmed | Where used |
|---|---|
| `messages get --channel <id> --since <unix-seconds> --limit <n>` — **no `--json` flag**; JSON is the default output format (`--format json`, global option) | inbound poll loop |
| `messages send --channel <id> --content <text> [--reply-to <event-id>]` | outbound text |
| `reactions add --event <id> --emoji <emoji>` | outbound reaction |
| `messages edit --event <id> --content <text>` | outbound edit |
| `users get --pubkey <64-char-hex>` — **rejects bech32 `npub1...`** with `"must be a 64-character hex string"`; must be hex | startup membership validation |
| `BUZZ_RELAY_URL` / `BUZZ_PRIVATE_KEY` env vars (or `--relay`/`--private-key` flags) — `--private-key` accepts hex or bech32 `nsec1...` | credential injection |

**Not yet confirmed** — requires an actual relay round-trip, not just `--help` output. Verify these against `messages get`'s real output the first time you run this against a live relay, and adjust `src/channels/buzz.ts` if any differ:

| Assumed | Where used |
|---|---|
| `messages get` returns a JSON array with fields `id`, `author`, `content`, `created_at`, `reply_to`, `mentions` | parsing inbound rows |
| `author` is the same 64-char hex string as the identity's own pubkey (not npub, not truncated) | self-authored-message filtering (loop prevention) — **if this is wrong, the adapter will ingest and reply to its own messages** |
| `mentions` (or whatever the real field is named) is an array of hex pubkeys p-tagged in the event | mention detection (`isMention`) |
| `messages send` prints JSON with an `id` field on success | `deliver()`'s return value (platform message id) — non-fatal if wrong, just loses the platform message id |

If any of these differ, the affected code path fails loudly (thrown error → delivery retry-then-fail, or a poll warning logged) rather than silently misbehaving — except the self-authored-filter row, which fails *silently* if wrong (the adapter would just start replying to itself). Verify that one specifically before leaving this unattended.

## Wiring

Buzz has no auto-create-on-first-message flow the way DM-based channels do — the identity must already be a member of a specific channel (see Credentials above), so wiring is always manual:

```bash
ncl messaging-groups create --channel-type buzz \
  --platform-id "<channelId>@<64-char-hex-pubkey>" --instance buzz \
  --unknown-sender-policy strict
ncl wirings create --messaging-group-id <id-from-above> --agent-group-id <your-agent-group-id> \
  --engage-mode mention-sticky --session-mode per-thread --sender-scope all
ncl destinations add --agent-group-id <your-agent-group-id> --local-name buzz-<short-name> \
  --target-type channel --target-id <messaging-group-id-from-first-command>
```

Use `strict` for `unknown_sender_policy` when the Buzz channel already has fixed, known membership (no new senders expected). Use `request_approval` if the channel might gain new members over time. `session_mode: per-thread` matches what the router forces anyway for a threads-supporting adapter in group chats — setting it explicitly keeps the wiring row honest about what actually happens.

**Confirmed live**: `ncl wirings create` does a generic CRUD insert into `messaging_group_agents` — it does **not** run the `createMessagingGroupAgent()` code path and does **not** auto-create the matching `agent_destinations` ACL row, despite `ncl destinations help` describing that row as "created automatically when wiring channels" (true for other creation paths like `/init-first-agent`, not for raw `ncl wirings create`). The third command above adds it explicitly. Without it, the agent can receive Buzz messages fine but gets `unauthorized channel destination` errors trying to proactively post there from a different session context.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, mention the identity in its wired Buzz channel to trigger the first response.

## Channel Info

- **type**: `buzz`
- **terminology**: Buzz calls them "channels" (group rooms); no native 1:1 DM support wired in Phase 1
- **supports-threads**: yes — Nostr NIP-10 reply-root event id maps to `threadId`; each Buzz thread becomes its own NanoClaw session
- **platform-id-format**: `"<Buzz channel UUID>@<64-char-hex pubkey of the signing identity>"` — required because `deliver()` receives no agent_group_id, so the signing identity must be recoverable from `platformId` alone. Hex, not bech32 `npub` — confirmed live, see "Verify against a live binary"
- **user-id-format**: 64-char hex Nostr pubkey, as returned by `buzz-cli` and required by `--pubkey` (confirmed live — npub is rejected)
- **how-to-find-channel-id**: from the Buzz desktop app (channel settings) or `buzz channels list`
- **typical-use**: an agent that already lives on Telegram/Slack/WhatsApp gaining an *additional* presence in a shared human+agent Buzz room — existing channels are unaffected
- **default-isolation**: one identity per agent group; an identity is not shared across agent groups

### Known limitations (Phase 1 scope)

- **Polling, not push** — inbound latency is bounded by `POLL_INTERVAL_MS` (4s), not instant. Phase 2 (raw Nostr WebSocket transport) would fix this.
- **Single identity, single channel per identity** — the identities file's `channelId` field means one identity polls exactly one channel. Multi-channel-per-identity and multi-identity connection pooling are Phase 2.
- **No DMs** — only group channels are wired up.
- **No attachments/voice** — text only.
- **`ask_question` degrades to plain text** — no card/button widget exists in Buzz; the answer comes back as a normal reply message.
- **Presence/typing are best-effort, not real** — `setTyping` is a no-op. Upstream `users set-presence` is reported broken over HTTP and only models online/away/offline, not typing.

## Troubleshooting

### Adapter not starting — credentials missing

```bash
grep "Channel credentials missing" logs/nanoclaw.log | grep buzz
```

Both `BUZZ_RELAY_URL` and `BUZZ_IDENTITIES` must be present in `.env`, and the identities file must contain at least one well-formed entry (`nsec`, `agentGroupId`, `channelId` all present).

### Adapter fails at startup with a membership-check error

```bash
grep "Buzz: identity" logs/nanoclaw.error.log | tail -5
```

Means `buzz users get --pubkey <hex-pubkey>` failed for a configured identity — either the relay is unreachable at `BUZZ_RELAY_URL`, that pubkey isn't actually a registered member yet (register it via `buzz-admin add-member` on the relay host first), or the identities.json key is bech32 `npub1...` instead of hex (the CLI rejects npub outright).

### `buzz: command not found`

The `buzz` binary isn't on the PATH the NanoClaw host process runs with. Re-check the Host Prerequisite section — confirm `which buzz` succeeds in the same shell/service context the host runs under, not just your interactive shell.

### Messages not arriving

1. Confirm the adapter started: `grep "Buzz: adapter started" logs/nanoclaw.log`
2. Confirm polling is succeeding (no repeated `Buzz: poll failed` warnings): `grep "Buzz: poll failed" logs/nanoclaw.error.log | tail -10`
3. Confirm the messaging group is wired: `pnpm exec tsx scripts/q.ts data/v2.db "SELECT mg.platform_id, mga.agent_group_id FROM messaging_groups mg JOIN messaging_group_agents mga ON mg.id = mga.messaging_group_id WHERE mg.channel_type='buzz'"`
4. Confirm the message actually mentions the identity's pubkey — non-mention channel chatter with no existing session is dropped by design (`unknown_sender_policy`/mention-gated auto-create).

### Replies not threading correctly

Confirm the `--reply-to` flag name against a live `buzz messages send --help` (see "Verify against a live binary") — an earlier draft of this adapter incorrectly assumed `--thread`, which does not exist.
