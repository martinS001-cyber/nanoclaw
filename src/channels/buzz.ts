/**
 * Buzz (block/buzz) channel adapter — Phase 1 MVP.
 *
 * Bridges NanoClaw with Buzz, a self-hosted Nostr-based team workspace where
 * humans and agents share channels. This adapter shells out to the `buzz`
 * binary (crate name `buzz-cli`, executable name `buzz`) rather than driving
 * a client library — `buzz-cli` has no subscribe/stream mode, so inbound is
 * polling-based in Phase 1. Phase 2 (raw Nostr WebSocket transport,
 * multi-identity connection pool) is intentionally not implemented here.
 *
 * Identity model: each NanoClaw agent that wants a Buzz presence signs as
 * its own Nostr keypair (an "identity"). Because `deliver()` receives no
 * agent_group_id — only `platformId`/`threadId`/`message` — the signing
 * identity is encoded directly into `platformId` as `"<channelId>@<pubkey>"`.
 * Split on the LAST '@' (hex pubkeys never contain '@').
 *
 * Identity keying uses the 64-char HEX pubkey throughout, not bech32 `npub1...`
 * — confirmed against a live `buzz` binary: `buzz users get --pubkey` rejects
 * npub outright ("must be a 64-character hex string"). npub/nsec bech32 forms
 * are purely a human-facing GUI convenience (e.g. the desktop app's key-import
 * field); the CLI and the raw Nostr wire format both use hex.
 *
 * Required env vars (.env):
 *   BUZZ_RELAY_URL  — e.g. wss://buzz.example.com
 *   BUZZ_IDENTITIES — path to a JSON file, e.g. data/buzz/identities.json:
 *     { "<64-char-hex-pubkey>": { "nsec": "nsec1...", "agentGroupId": "ag-...",
 *                                 "name": "nanobot", "channelId": "<buzz channel UUID>" } }
 *   The identities file is 0600 and git-ignored — it holds private keys.
 *   (`nsec` may be bech32 or hex — `buzz`'s `--private-key`/`BUZZ_PRIVATE_KEY`
 *   accepts either — but the map KEY must be the hex pubkey.)
 *
 * CLI surface fully verified against a live `buzz` binary (built from
 * github.com/block/buzz) and a real relay round-trip, 2026-08-13:
 *   - `messages get --channel --since --limit` (NOT --json — JSON is the
 *     default output format; there is no --json flag)
 *   - `messages send --channel --content --reply-to`
 *   - `reactions add --event --emoji`
 *   - `messages edit --event --content`
 *   - `users get --pubkey`
 *   - `messages get` output rows are raw Nostr events: `pubkey` (not
 *     `author`) is the sender; mentions and reply-references are NIP-01
 *     tags (`["p", "<hex>"]`, `["e", "<event-id>"]`), not dedicated
 *     `mentions`/`reply_to` fields. An earlier version of this file guessed
 *     the flat-field shape, which silently broke mention detection — every
 *     poll succeeded, isMention was just always false, so nothing ever
 *     engaged. Fixed after observing real output via `buzz messages get`.
 */
import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { promisify } from 'util';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 4000;
const POLL_LIMIT = 20;
/** Re-fetch a small overlap window each poll — created_at is second-granularity,
 *  a bare since=lastPoll cursor can silently drop a same-second message. */
const OVERLAP_MS = 15000;
/** Bounded per-identity dedupe set so memory doesn't grow unbounded over a long run. */
const SEEN_IDS_MAX = 500;

interface BuzzIdentity {
  nsec: string;
  agentGroupId: string;
  name: string;
  /** Phase 1: one channel per identity, matching the single-channel MVP smoke test. */
  channelId: string;
}

type IdentityMap = Map<string, BuzzIdentity>; // keyed by 64-char hex pubkey

function loadIdentities(path: string): IdentityMap {
  const map: IdentityMap = new Map();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    log.warn('Buzz: identities file not found, skipping channel', {
      path,
      err: err instanceof Error ? err.message : String(err),
    });
    return map;
  }
  let parsed: Record<string, BuzzIdentity>;
  try {
    parsed = JSON.parse(raw) as Record<string, BuzzIdentity>;
  } catch (err) {
    log.error('Buzz: identities file is not valid JSON, skipping channel', {
      path,
      err: err instanceof Error ? err.message : String(err),
    });
    return map;
  }
  for (const [pubkey, identity] of Object.entries(parsed)) {
    if (!identity.nsec || !identity.agentGroupId || !identity.channelId) {
      log.warn('Buzz: skipping malformed identity entry (missing nsec/agentGroupId/channelId)', {
        pubkey: pubkey.slice(0, 12),
      });
      continue;
    }
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
      log.warn(
        'Buzz: skipping identity key that is not a 64-char hex pubkey (bech32 npub is not accepted by --pubkey)',
        {
          pubkey: pubkey.slice(0, 12),
        },
      );
      continue;
    }
    map.set(pubkey, identity);
  }
  return map;
}

function splitPlatformId(platformId: string): { channelId: string; pubkey: string } {
  const i = platformId.lastIndexOf('@');
  if (i === -1) {
    throw new Error(`Buzz: malformed platformId (missing '@pubkey' suffix): ${platformId}`);
  }
  return { channelId: platformId.slice(0, i), pubkey: platformId.slice(i + 1) };
}

/** Shape of a `buzz messages get` JSON row — confirmed live against a real
 *  relay (2026-08-13). It's a raw Nostr event: author is `pubkey` (not
 *  `author`), and there is no dedicated mentions/reply_to field — both are
 *  encoded as NIP-01 tags (`["p", "<hex-pubkey>"]` for mentions, `["e",
 *  "<event-id>"]` for a reply reference). An earlier version of this file
 *  guessed `author`/`mentions`/`reply_to` as flat fields, which silently
 *  broke mention detection (isMention was always false) — every row parsed
 *  successfully, so the poll loop never errored, it just never engaged. */
interface BuzzMessageRow {
  id: string;
  content: string;
  created_at: number; // unix seconds (Nostr standard)
  pubkey: string; // hex pubkey of the author
  kind: number;
  tags: string[][]; // NIP-01 tags, e.g. [["p", "<hex>"], ["e", "<event-id>"], ["h", "<channel-id>"]]
}

function extractMentions(tags: string[][]): string[] {
  return tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1] as string);
}

/** First 'e' tag is treated as the reply/thread-root reference. buzz-cli's
 *  `--reply-to` maps to a single flat e-tag, not full NIP-10 root/reply
 *  marker semantics — sufficient for Phase 1's one-thread-one-session model. */
function extractReplyTo(tags: string[][]): string | null {
  const eTag = tags.find((t) => t[0] === 'e' && t[1]);
  return eTag ? (eTag[1] as string) : null;
}

/** Redacts the nsec from a thrown error's message before it can reach logs. */
function redact(err: unknown, nsec: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  return nsec ? msg.split(nsec).join('[redacted]') : msg;
}

function runBuzzCli(relayUrl: string, nsec: string, args: string[]): Promise<string> {
  // Per-call minimal env — never mutate process.env. With multiple identities
  // (Phase 2) that would race: overlapping async sends could sign as the
  // wrong identity. Every buzz-cli invocation gets its own child env.
  return execFileAsync('buzz', args, {
    env: {
      PATH: process.env.PATH ?? '',
      BUZZ_RELAY_URL: relayUrl,
      BUZZ_PRIVATE_KEY: nsec,
    },
    maxBuffer: 10 * 1024 * 1024,
  }).then(({ stdout }) => stdout);
}

interface PollState {
  sinceMs: number;
  seenIds: Set<string>;
}

function createAdapter(relayUrl: string, identities: IdentityMap): ChannelAdapter {
  let setup: ChannelSetup | undefined;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let connected = false;
  const pollState = new Map<string, PollState>(); // keyed by hex pubkey

  async function pollIdentity(pubkey: string, identity: BuzzIdentity): Promise<void> {
    const state = pollState.get(pubkey) ?? { sinceMs: Date.now() - OVERLAP_MS, seenIds: new Set<string>() };
    try {
      const stdout = await runBuzzCli(relayUrl, identity.nsec, [
        'messages',
        'get',
        '--channel',
        identity.channelId,
        '--since',
        String(Math.floor(state.sinceMs / 1000)),
        '--limit',
        String(POLL_LIMIT),
      ]);
      const rows = JSON.parse(stdout) as BuzzMessageRow[];
      for (const row of rows) {
        if (state.seenIds.has(row.id)) continue;
        if (row.pubkey === pubkey) continue; // never ingest our own posts — avoids self-reply loops
        state.seenIds.add(row.id);
        if (state.seenIds.size > SEEN_IDS_MAX) {
          const oldest = state.seenIds.values().next().value;
          if (oldest !== undefined) state.seenIds.delete(oldest);
        }
        const tags = Array.isArray(row.tags) ? row.tags : [];
        const isMention = extractMentions(tags).includes(pubkey);
        await setup?.onInbound(`${identity.channelId}@${pubkey}`, extractReplyTo(tags), {
          id: row.id,
          kind: 'chat',
          content: { text: row.content, sender: row.pubkey, senderId: row.pubkey },
          timestamp: new Date(row.created_at * 1000).toISOString(),
          isMention,
          isGroup: true,
        });
      }
      state.sinceMs = Date.now() - OVERLAP_MS;
      connected = true;
    } catch (err) {
      log.warn('Buzz: poll failed', { pubkey: pubkey.slice(0, 12), err: redact(err, identity.nsec) });
      connected = false;
    }
    pollState.set(pubkey, state);
  }

  const adapter: ChannelAdapter = {
    name: 'buzz',
    channelType: 'buzz',
    // Preserves NIP-10 reply threads as NanoClaw sessions — the router keys
    // sessions on threadId only when the adapter declares thread support.
    supportsThreads: true,

    async setup(config: ChannelSetup): Promise<void> {
      setup = config;

      // Startup validation: confirm each identity is actually a registered
      // relay member before going live, so a misconfig surfaces here as a
      // clear error rather than as "the agent never replied".
      for (const [pubkey, identity] of identities) {
        try {
          await runBuzzCli(relayUrl, identity.nsec, ['users', 'get', '--pubkey', pubkey]);
        } catch (err) {
          // The nsec never reaches argv (runBuzzCli injects it via child env
          // only), so the raw `err` (Node's execFile rejection: message/code/
          // signal/cmd/stdout/stderr) carries no secret material — safe to
          // attach as-is. The message above is still explicitly redacted.
          throw new Error(
            `Buzz: identity "${identity.name}" (${pubkey.slice(0, 12)}...) failed membership check against ${relayUrl} — ` +
              `is it registered on the relay (buzz-admin add-member)? (${redact(err, identity.nsec)})`,
            { cause: err },
          );
        }
      }

      pollTimer = setInterval(() => {
        for (const [pubkey, identity] of identities) {
          void pollIdentity(pubkey, identity);
        }
      }, POLL_INTERVAL_MS);
      connected = true;
      log.info('Buzz: adapter started', { identityCount: identities.size, relayUrl });
    },

    async teardown(): Promise<void> {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      connected = false;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const { channelId, pubkey } = splitPlatformId(platformId);
      const identity = identities.get(pubkey);
      if (!identity) {
        throw new Error(`Buzz: no configured identity for pubkey ${pubkey.slice(0, 12)}...`);
      }
      const content = (message.content ?? {}) as Record<string, unknown>;

      if (
        content.operation === 'reaction' &&
        typeof content.messageId === 'string' &&
        typeof content.emoji === 'string'
      ) {
        await runBuzzCli(relayUrl, identity.nsec, [
          'reactions',
          'add',
          '--event',
          content.messageId,
          '--emoji',
          content.emoji,
        ]);
        return undefined;
      }
      if (content.operation === 'edit' && typeof content.messageId === 'string' && typeof content.text === 'string') {
        await runBuzzCli(relayUrl, identity.nsec, [
          'messages',
          'edit',
          '--event',
          content.messageId,
          '--content',
          content.text,
        ]);
        return undefined;
      }

      // ask_question has no Buzz card/button widget in Phase 1 — degrade to
      // plain text; the answer comes back as a normal reply message.
      const text =
        typeof content.text === 'string'
          ? content.text
          : typeof content.markdown === 'string'
            ? content.markdown
            : typeof content.question === 'string'
              ? [content.question, ...(Array.isArray(content.options) ? (content.options as string[]) : [])].join('\n')
              : '';
      if (!text) return undefined;

      const args = ['messages', 'send', '--channel', channelId, '--content', text];
      if (threadId) args.push('--reply-to', threadId);
      const stdout = await runBuzzCli(relayUrl, identity.nsec, args);
      try {
        // Confirmed live: `messages send` returns { accepted, event_id, mention_pubkeys, message },
        // not a flat { id }.
        const parsed = JSON.parse(stdout) as { event_id?: string };
        return parsed.event_id;
      } catch {
        return undefined;
      }
    },

    // Best-effort only, not a Phase-1 acceptance criterion. Upstream: users
    // set-presence accepts only online|away|offline (no active/typing) and is
    // currently flagged broken over HTTP; set-status is a persistent profile
    // string, not a transient indicator. Real typing/presence waits for the
    // Phase 2 WebSocket transport.
    async setTyping(): Promise<void> {
      /* no-op in Phase 1 — see module doc comment */
    },
  };

  return adapter;
}

registerChannelAdapter('buzz', {
  factory: () => {
    const env = readEnvFile(['BUZZ_RELAY_URL', 'BUZZ_IDENTITIES']);
    if (!env.BUZZ_RELAY_URL || !env.BUZZ_IDENTITIES) {
      log.debug('Buzz: BUZZ_RELAY_URL/BUZZ_IDENTITIES not set, skipping channel');
      return null;
    }
    const identities = loadIdentities(env.BUZZ_IDENTITIES);
    if (identities.size === 0) {
      log.debug('Buzz: no identities configured, skipping channel');
      return null;
    }
    return createAdapter(env.BUZZ_RELAY_URL, identities);
  },
});
