// Slot accounting as the agent reports it: per-epoch budgets by the local clock.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { EPOCH_SECONDS, createIdentity, createWallet, formatChallengeHeader } from '@fuse/core';
import { BudgetExhaustedError, FuseAgent } from '../src/index.js';

const DAY = EPOCH_SECONDS * 1000;
const EPOCH = 20383;

function agentAt(clock, { limit = 3, spent = {} } = {}) {
  const wallet = createWallet({ secret: createIdentity().secret, registry: 'http://registry.test', index: 0, limit, tier: 'starter' });
  wallet.spent = spent;
  return new FuseAgent({ wallet, now: () => clock.now });
}

describe('status()', () => {
  test('counts slots of the current epoch and when they reset', () => {
    const clock = { now: EPOCH * DAY + 3_600_000 };
    const agent = agentAt(clock, { spent: { [EPOCH]: [0, 1], [EPOCH - 1]: [0, 1, 2] } });
    const status = agent.status();
    assert.deepEqual(
      { epoch: status.epoch, used: status.used, remaining: status.remaining, limit: status.limit },
      { epoch: EPOCH, used: 2, remaining: 1, limit: 3 },
    );
    assert.equal(status.resetsAt, new Date((EPOCH + 1) * DAY).toISOString());
    assert.deepEqual(status.sites, []);
  });

  test('a new epoch starts with the full budget', () => {
    const clock = { now: EPOCH * DAY + 1000 };
    const agent = agentAt(clock, { spent: { [EPOCH]: [0, 1, 2] } });
    assert.equal(agent.status().remaining, 0);
    clock.now += DAY;
    assert.deepEqual([agent.status().epoch, agent.status().remaining], [EPOCH + 1, 3]);
  });
});

describe('budget exhaustion', () => {
  let server;
  let url;
  let authorizations = 0;

  before(async () => {
    // A gateway that always challenges; the registry is never reached.
    server = createServer((req, res) => {
      if (req.headers.authorization) authorizations++;
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': formatChallengeHeader({ challenge: 'c', registry: 'http://registry.test' }),
      });
      res.end('{"error":"fuse-required"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/me`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  test('is raised locally with the reset time, and nothing is proved or sent', async () => {
    const clock = { now: EPOCH * DAY + 5000 };
    const events = [];
    const wallet = createWallet({ secret: createIdentity().secret, registry: 'http://registry.test', index: 0, limit: 2, tier: 'tiny' });
    wallet.spent = { [EPOCH]: [0, 1] };
    const agent = new FuseAgent({ wallet, now: () => clock.now, onEvent: (e) => events.push(e) });
    await assert.rejects(agent.fetch(url), (err) => {
      assert.ok(err instanceof BudgetExhaustedError);
      assert.equal(err.code, 'budget-exhausted');
      assert.equal(err.epoch, EPOCH);
      assert.equal(err.resetsAt, new Date((EPOCH + 1) * DAY).toISOString());
      return true;
    });
    assert.deepEqual(
      events.map((e) => e.type),
      ['challenge', 'budget-exhausted'],
    );
    assert.equal(authorizations, 0);
    assert.deepEqual(agent.wallet.spent[EPOCH], [0, 1]);
  });
});
