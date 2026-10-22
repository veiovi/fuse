// Scenario 3: cheating that confesses. The agent reuses one slot for two
// challenges by calling @fuse/core directly, bypassing the SDK's slot
// bookkeeping: the math, not the SDK, is what enforces honesty. Two points on
// one line reveal the key; the shared log publishes it, the registry burns the
// credential, and every gateway ends its sessions.
import { CredentialBurnedError, FuseAgent } from '@fuse/agent';
import { createFuseAuthorization, epochAt, recoverSecret } from '@fuse/core';
import { nodeArtifacts } from '@fuse/core/node';
import { challengeFor, expect, getJson, narrate, sameField, shortHex, step, waitFor, walletPath } from './lib.js';

export default {
  id: 'cheater',
  title: 'Cheater burns',
  summary:
    'A pro credential spends one slot twice. The shared log recovers its key from the two points, publishes it, and the registry burns the credential: sessions end and no new proof works.',

  async run(ctx) {
    const { print, signal } = ctx;
    print('• Locking a pro deposit at the registry (50 demo credits → 200 slots a day)');
    const agent = await FuseAgent.create({
      registry: ctx.registryUrl,
      tier: 'pro',
      walletPath: walletPath(ctx, 'cheater'),
      onEvent: narrate(ctx),
    });
    const wallet = agent.wallet; // holds the secret: only compared below, never printed
    print(`✓ credential ready · member #${wallet.index}`);

    print('• An honest first contact at the api opens a session');
    const apiSearch = new URL('/v1/search?q=fuse', ctx.sites.api);
    const honest = await step(ctx, agent, apiSearch);
    expect(honest.res.ok, `honest first contact should succeed (got ${honest.res.status})`);
    const apiCookie = honest.res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    expect(apiCookie, 'the api should have set a session cookie');

    const slot = agent.status().used; // the next slot the SDK would hand out
    const epoch = epochAt();
    print(`• Now the cheater spends slot ${slot} twice, calling @fuse/core directly (no SDK bookkeeping)`);
    const forumMe = new URL('/me', ctx.sites.forum);
    const apiAgain = new URL('/v1/search?q=again', ctx.sites.api);
    const [challengeA, challengeB] = await Promise.all([challengeFor(forumMe, signal), challengeFor(apiAgain, signal)]);
    const { leaves } = await getJson(new URL('/tree', ctx.registryUrl), signal);
    const common = { secret: wallet.secret, limit: wallet.limit, index: wallet.index, leaves, epoch, slot, artifacts: nodeArtifacts };
    const a = await createFuseAuthorization({ ...common, origin: forumMe.origin, challenge: challengeA });
    const b = await createFuseAuthorization({ ...common, origin: apiAgain.origin, challenge: challengeB });
    expect(a.nullifier === b.nullifier, 'one slot should give one slot tag');
    print(`  two proofs (${a.provingMs} ms, ${b.provingMs} ms) for two challenges, same slot tag ${shortHex(a.nullifier)}`);

    print('→ GET forum /me with proof A');
    const first = await fetch(forumMe, { headers: { authorization: a.authorization, accept: 'application/json' }, signal });
    await first.arrayBuffer();
    expect(first.ok, `proof A should be accepted (got ${first.status})`);
    print(`← ${first.status} ${first.statusText} · first use of slot ${slot}: one point on the line reveals nothing`);

    print('→ GET api /v1/search with proof B (same slot, new challenge)');
    const second = await fetch(apiAgain, { headers: { authorization: b.authorization, accept: 'application/json' }, signal });
    const refusal = await second.json().catch(() => ({}));
    expect(second.status === 403 && refusal.error === 'credential-burned', `proof B should burn the credential (got ${second.status} ${refusal.error})`);
    print(`← ${second.status} ${refusal.error} · the shared log saw slot tag ${shortHex(b.nullifier)} twice`);

    const revocation = await waitFor(
      async () => {
        const { revocations } = await getJson(new URL('/revocations', ctx.logUrl), signal);
        return revocations.find((r) => sameField(r.commitment, wallet.commitment));
      },
      { signal, what: 'the revocation' },
    );
    const matches = sameField(revocation.secret, wallet.secret);
    const [s1, s2] = revocation.shares;
    const onOneLine = sameField(recoverSecret(s1, s2), revocation.secret);
    expect(matches && onOneLine, 'the published key should be this wallet secret and fit both shares');
    print('• The shared log published a revocation (the confession):');
    print(`  recovered key ${shortHex(revocation.secret)} = this wallet's secret · match ✓`);
    print(`  anyone can check it: both published points lie on one line through it ✓`);

    const { members } = await getJson(new URL('/members', ctx.registryUrl), signal);
    const member = members.find((m) => m.index === wallet.index);
    expect(member?.status === 'burned', `registry member should be burned (got ${member?.status})`);
    print(`• Registry: member #${member.index} ${member.status} · ${member.deposit.amount} ${member.deposit.currency} slashed`);

    const ended = await waitFor(
      async () => {
        const res = await fetch(apiSearch, { headers: { cookie: apiCookie, accept: 'application/json' }, signal });
        const body = await res.json().catch(() => ({}));
        return res.status === 200 ? null : { status: res.status, error: body.error ?? res.statusText };
      },
      { signal, what: 'the api session to end' },
    );
    print(`• The earlier api session: ${ended.status} ${ended.error} · ended ✓`);

    print('• A fresh proof attempt with a clean cookie jar');
    agent.clearCookies();
    let freshAttempt = 'accepted';
    try {
      await step(ctx, agent, apiSearch);
    } catch (err) {
      if (!(err instanceof CredentialBurnedError)) throw err;
      freshAttempt = err.reason;
    }
    expect(freshAttempt === 'not-a-member', `a fresh proof should fail for a burned credential (got ${freshAttempt})`);
    print('✗ refused before proving: the credential is no longer a member · burned for good');

    return {
      slotReused: slot,
      keyRecovered: matches,
      memberStatus: member.status,
      slashed: `${member.deposit.amount} ${member.deposit.currency}`,
      apiSession: ended.status,
      freshAttempt,
    };
  },
};
