// Scenario 2: a mass scanner. It throws its cookies away before every request,
// so every request is a first contact and costs a slot. The budget, not an
// identity check, is what stops it.
import { BudgetExhaustedError, FuseAgent } from '@fuse/agent';
import { shortPseudonym } from '@fuse/core';
import { expect, formatNumber, getJson, siteName, walletPath } from './lib.js';

const SERVERS_PER_DAY = 1_000_000;
// protocol.md §6 demo tiers, used if the registry's /info is unreachable.
const DEMO_TIERS = [
  { id: 'starter', deposit: 5, limit: 10 },
  { id: 'pro', deposit: 50, limit: 200 },
  { id: 'fleet', deposit: 500, limit: 2000 },
];

export default {
  id: 'scanner',
  title: 'Mass scanner',
  summary:
    'A starter credential (10 slots a day) drops its cookies before every request, like a scanner. Ten first contacts go through; the eleventh is refused before anything is sent.',

  async run(ctx) {
    const { print } = ctx;
    print('• Locking a starter deposit (5 demo credits → 10 slots a day)');
    let proof = null;
    const agent = await FuseAgent.create({
      registry: ctx.registryUrl,
      tier: 'starter',
      walletPath: walletPath(ctx, 'scanner'),
      onEvent: (event) => {
        if (event.type === 'proved' || event.type === 'rejected') proof = event;
      },
    });
    const { limit } = agent.status();
    print(`✓ credential ready · ${limit} slots a day`);
    print('• Scanning: a fresh cookie jar before every request, alternating sites');

    const targets = [new URL('/me', ctx.sites.forum), new URL('/v1/search?q=probe', ctx.sites.api)];
    const contacts = new Map(); // site → first contacts
    let accepted = 0;
    let refusedAt = null;
    let resetsAt = null;
    for (let n = 1; n <= limit + 1; n++) {
      agent.clearCookies();
      const url = targets[(n - 1) % targets.length];
      const site = siteName(ctx, url.origin);
      const label = `#${String(n).padStart(2, '0')} ${site.padEnd(5)} ${url.pathname}`;
      proof = null;
      try {
        const res = await agent.fetch(url, { headers: { accept: 'application/json' }, signal: ctx.signal });
        await res.arrayBuffer();
        expect(res.ok && proof?.type === 'proved', `probe ${n} should be a paid first contact (got ${res.status})`);
        accepted++;
        contacts.set(site, (contacts.get(site) ?? 0) + 1);
        const left = agent.status().remaining;
        print(`→ ${label.padEnd(22)} slot ${String(proof.slot).padStart(2)} · ${proof.provingMs} ms · ${res.status} · ${left} left`);
      } catch (err) {
        if (!(err instanceof BudgetExhaustedError)) throw err;
        refusedAt = n;
        resetsAt = err.resetsAt;
        print(`✗ ${label.padEnd(22)} refused locally: all ${limit} slots spent, nothing sent`);
        print(`  the budget resets at ${resetsAt.slice(11, 16)} UTC (next epoch)`);
        break;
      }
    }
    expect(accepted === limit && refusedAt === limit + 1, `expected ${limit} probes then a refusal (got ${accepted}, refused at ${refusedAt})`);

    for (const [site, count] of contacts) {
      const short = shortPseudonym(agent.pseudonymFor(ctx.sites[site]));
      print(`• ${site} saw ${count} first contacts, every one from ${short}: dropping cookies does not change the pseudonym`);
    }

    const tiers = await getJson(new URL('/info', ctx.registryUrl), ctx.signal)
      .then((info) => info.tiers ?? DEMO_TIERS)
      .catch(() => DEMO_TIERS);
    const pro = tiers.find((t) => t.id === 'pro') ?? DEMO_TIERS[1];
    const backings = Math.ceil(SERVERS_PER_DAY / pro.limit);
    print(`• Economics: probing ${formatNumber(SERVERS_PER_DAY)} servers a day at ${pro.limit} slots per backing needs ${formatNumber(backings)} backings`);
    print(`  that is ${formatNumber(backings * pro.deposit)} demo credits locked, and slashed the moment one slot is reused`);
    return { limit, accepted, refusedAt, resetsAt, backingsFor1M: backings };
  },
};
