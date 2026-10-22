// The page's pure modules: plot geometry and event wording.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { randomFieldElement, toHex } from '@fuse/core';
import { burnPlot, lineThroughShares, onePointPlot } from '../public/plot.js';
import { describeEvent, isAlarmEvent, isRedundantEvent, shortHex } from '../public/format.js';

const randomRevocation = () => ({
  id: 'rev',
  secret: toHex(randomFieldElement()),
  nullifier: toHex(randomFieldElement()),
  shares: [
    { x: toHex(randomFieldElement()), y: toHex(randomFieldElement()), seq: 4 },
    { x: toHex(randomFieldElement()), y: toHex(randomFieldElement()), seq: 9 },
  ],
});

describe('burned-key plot', () => {
  test('the key and both shares lie on one line inside the plot, shares in order', () => {
    for (let i = 0; i < 300; i++) {
      const { ky, p1, p2, end } = lineThroughShares(randomRevocation());
      for (const y of [ky, p1.y, p2.y, end.y]) assert.ok(y > 8 && y < 156, `y=${y} inside the plot box`);
      assert.ok(p1.x < p2.x && p2.x < end.x);
      const slope = (p2.y - p1.y) / (p2.x - p1.x);
      assert.ok(Math.abs(p1.y - (ky + slope * (p1.x - 30))) < 1e-9, 'collinear with the key on the axis');
      assert.ok(Math.abs(slope) > 0.05, 'the line visibly slopes');
    }
  });

  test('stable per key, labelled with log entry numbers, animated only when fresh', () => {
    const rev = randomRevocation();
    assert.equal(burnPlot(rev), burnPlot(rev));
    assert.match(burnPlot(rev), />#4</);
    assert.match(burnPlot(rev), />#9</);
    assert.doesNotMatch(burnPlot(rev), /is-fresh/);
    assert.match(burnPlot(rev, { fresh: true }), /class="plot is-fresh"/);
    assert.match(onePointPlot(), /plot-candidate/);
  });
});

describe('event wording', () => {
  test('gateway events read as plain sentences', () => {
    const short = 'anon-0a1e65c1';
    assert.equal(describeEvent({ type: 'proof-accepted', short, verifyMs: 6 }), `Accepted a proof from ${short}`);
    assert.equal(describeEvent({ type: 'challenge-issued', method: 'POST', path: '/post' }), 'Asked for a proof on POST /post');
    assert.equal(describeEvent({ type: 'proof-rejected', reason: 'double-spend', short }), `Caught ${short} reusing a slot`);
    assert.equal(describeEvent({ type: 'proof-rejected', reason: 'challenge-expired' }), 'Turned down a proof: the challenge had expired');
    assert.equal(describeEvent({ type: 'revocation-applied', short, known: false }), `Banned ${short} in advance: its key burned elsewhere`);
    assert.equal(describeEvent({ type: 'pseudonym-banned', short, by: 'moderator', reason: 'spam' }), `A moderator banned ${short} (spam)`);
    assert.equal(describeEvent({ type: 'cache', status: 'HIT', method: 'GET', path: '/' }), 'Served / from cache');
    assert.equal(describeEvent({ type: 'something-new' }), 'Something new');
    assert.equal(isAlarmEvent({ type: 'revocation-applied' }), true);
    assert.equal(isAlarmEvent({ type: 'proof-accepted' }), false);
    assert.equal(isRedundantEvent({ type: 'pseudonym-banned', by: 'revocation' }), true);
  });

  test('short hex keeps both ends', () => {
    assert.equal(shortHex('0x0c925706b5af127755ff19b1aaeb7836309a71461d3694d3c913794a5f5a4517'), '0x0c92…4517');
    assert.equal(shortHex('e3b0c44298fc1c149afbf4c8996fb924', 6, 4), 'e3b0c4…b924');
    assert.equal(shortHex(undefined), '');
  });
});
