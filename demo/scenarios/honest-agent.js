// Scenario 1: an honest agent. Each first contact costs one slot, sessions
// carry on for free, and the two sites see unrelated pseudonyms. Each site
// also gets only its own session cookie back, so cookies cannot link them.
import { FuseAgent } from '@fuse/agent';
import { shortPseudonym } from '@fuse/core';
import { expect, narrate, step, walletPath } from './lib.js';

export default {
  id: 'honest-agent',
  title: 'Honest agent',
  summary:
    'A pro credential visits the forum and the API. Each first contact costs one slot, repeat visits ride the session cookie, and the two sites see unlinkable pseudonyms.',

  async run(ctx) {
    const { print } = ctx;
    print('• Locking a pro deposit at the registry (50 demo credits → 200 slots a day)');
    const cookiesSent = []; // [origin, ["name=value", …]] for every request the agent makes
    const agent = await FuseAgent.create({
      registry: ctx.registryUrl,
      tier: 'pro',
      walletPath: walletPath(ctx, 'honest-agent'),
      onEvent: narrate(ctx),
      fetch: (url, init) => {
        const cookies = (new Headers(init?.headers).get('cookie') ?? '').split('; ').filter(Boolean);
        cookiesSent.push([new URL(url).origin, cookies]);
        return fetch(url, init);
      },
    });
    const { index, limit } = agent.status();
    print(`✓ credential ready · member #${index} · the secret key never leaves this agent`);

    const forumMe = new URL('/me', ctx.sites.forum);
    const apiSearch = new URL('/v1/search?q=fuse', ctx.sites.api);
    const forum = shortPseudonym(agent.pseudonymFor(ctx.sites.forum));
    const api = shortPseudonym(agent.pseudonymFor(ctx.sites.api));

    print('• First contact with each site costs one slot');
    const first = [await step(ctx, agent, forumMe), await step(ctx, agent, apiSearch)];
    expect(first.every(({ res }) => res.ok), 'both first contacts should succeed');
    expect(first[0].seenAs === forum && first[1].seenAs === api, 'each site should see the pseudonym computed locally');
    expect(agent.status().used === 2, `expected 2 slots used, found ${agent.status().used}`);

    print('• Same requests again: the session cookies carry on');
    const again = [await step(ctx, agent, forumMe), await step(ctx, agent, apiSearch)];
    expect(again.every(({ res }) => res.ok), 'repeat requests should succeed');
    const { used } = agent.status();
    expect(used === 2, `sessions should not spend slots (used ${used})`);

    expect(forum !== api, 'pseudonyms should differ between sites');
    print(`• forum knows this agent as ${forum}, api as ${api}: nothing links the two`);
    const sentTo = (url) => new Set(cookiesSent.filter(([origin]) => origin === new URL(url).origin).flatMap(([, list]) => list));
    const [toForum, toApi] = [sentTo(ctx.sites.forum), sentTo(ctx.sites.api)];
    expect(toForum.size > 0 && toApi.size > 0, 'both sessions should have ridden on cookies');
    expect(![...toForum].some((cookie) => toApi.has(cookie)), 'a session cookie reached the other site');
    print('✓ and each site only ever got its own session cookie back');
    print(`✓ slots used ${used}/${limit} today`);
    return { used, limit, pseudonyms: { forum, api } };
  },
};
