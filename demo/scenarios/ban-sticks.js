// Scenario 4: bans stick. A moderator bans a pseudonym; the agent wipes its
// cookies and proves again with a fresh slot, but the same credential always
// shows the forum the same pseudonym, so the ban holds. The forum never
// learns who it banned.
import { BannedError, FuseAgent } from '@fuse/agent';
import { shortPseudonym } from '@fuse/core';
import { expect, getJson, narrate, postJson, sameField, step, walletPath } from './lib.js';

export default {
  id: 'ban-sticks',
  title: 'Ban sticks',
  summary:
    'A moderator bans a pseudonym at the forum. The agent drops its cookies and proves again with a fresh slot, gets the same pseudonym, and stays banned.',

  async run(ctx) {
    const { print, signal } = ctx;
    print('• Locking a pro deposit at the registry (50 demo credits → 200 slots a day)');
    const agent = await FuseAgent.create({
      registry: ctx.registryUrl,
      tier: 'pro',
      walletPath: walletPath(ctx, 'ban-sticks'),
      onEvent: narrate(ctx),
    });
    print(`✓ credential ready · member #${agent.status().index}`);

    print('• A first contact at the forum opens a session');
    const forumMe = new URL('/me', ctx.sites.forum);
    const first = await step(ctx, agent, forumMe);
    expect(first.res.ok, `first contact should succeed (got ${first.res.status})`);
    const pseudonym = agent.pseudonymFor(ctx.sites.forum);
    const short = shortPseudonym(pseudonym);

    const { pseudonyms } = await getJson(new URL('/.fuse/admin/pseudonyms', ctx.sites.forum), signal);
    const row = pseudonyms.find((p) => sameField(p.pseudonym, pseudonym));
    expect(row, 'the forum moderator should see the new pseudonym');
    print(`• Moderator's view: ${row.short} · ${row.reputation} · ${row.firstContacts} first contact · no name, no account`);
    await postJson(new URL('/.fuse/admin/ban', ctx.sites.forum), { pseudonym, banned: true, reason: 'spam' }, signal);
    print(`• Moderator bans ${short} for spam`);

    print('• The agent wipes its cookies and proves again with a fresh slot');
    agent.clearCookies();
    let refused = null;
    try {
      await step(ctx, agent, forumMe);
    } catch (err) {
      if (!(err instanceof BannedError)) throw err;
      refused = err;
    }
    expect(refused, 'a banned pseudonym should be refused');
    expect(refused.pseudonym === pseudonym, 'the new proof should carry the same pseudonym');
    const { used } = agent.status();
    print(`✗ 403 banned · slot ${used - 1}, new cookie jar, same pseudonym ${shortPseudonym(refused.pseudonym)}`);
    print('✓ The ban stuck. The forum never learned who it banned.');
    return { pseudonym: short, banned: true, slotsUsed: used };
  },
};
