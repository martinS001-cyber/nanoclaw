/**
 * Integration test for the buzz channel's single reach-in: the
 * self-registration import in the `src/channels/index.ts` barrel. Importing the
 * barrel runs buzz.ts's top-level `registerChannelAdapter('buzz', …)`;
 * without the import the channel is silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './buzz.js';` line is deleted, or the barrel fails to evaluate for
 * any reason (so the channel genuinely would not register), this goes red.
 *
 * Importing the barrel is safe: registration is a pure top-level call, and
 * buzz.ts only shells out to the `buzz` binary inside setup() (run at host
 * startup) and inside its poll loop, never at import — so nothing spawns here.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('buzz channel registration', () => {
  it('registers buzz via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('buzz');
  });
});
