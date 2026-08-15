# Remove Buzz

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './buzz.js';
```

Then delete the copied adapter and its registration test:

```bash
rm -f src/channels/buzz.ts src/channels/buzz-registration.test.ts
```

## 2. Remove credentials

Remove these lines from `.env`:

```bash
BUZZ_RELAY_URL
BUZZ_IDENTITIES
```

If `.env` was synced to the container mount, refresh it:

```bash
mkdir -p data/env && cp .env data/env/env
```

## 3. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh

# Linux
systemctl --user restart $(systemd_unit)

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
```

## 4. Remove identity data (optional)

```bash
rm -rf data/buzz/
```

> **Warning:** this deletes the private Nostr key(s) (`nsec`) stored in `data/buzz/identities.json`. If you want to reuse the same Buzz identity later, back up the file first — a lost `nsec` cannot be recovered; you'd have to mint a new identity and re-register it as a relay member.

## 5. Remove the wiring (optional)

If you wired a Buzz channel to an agent group, remove it so the agent group doesn't retain a dangling reference:

```bash
ncl wirings list  # find the buzz wiring's id
ncl wirings delete --id <id>
ncl messaging-groups delete --id <messaging-group-id>
```

## 6. Remove the host binary (optional)

```bash
rm -f ~/.local/bin/buzz
```

Only do this if nothing else on the host needs the `buzz` CLI.

## Verification

After removal, confirm the adapter is no longer starting:

```bash
grep "buzz" logs/nanoclaw.log | tail -5
```

Expected: no `Buzz: adapter started` entry after the last restart.
