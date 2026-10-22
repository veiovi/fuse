pragma circom 2.1.0;

// Fuse circuit: Rate-Limiting Nullifier (RLN v2) plus a per-site pseudonym.
//
// The RLN part follows the structure of the PSE circom-rln circuit. One proof
// says, without revealing which member is speaking:
//   1. I know a secret k whose rate commitment Poseidon(Poseidon(k), limit) is
//      a leaf of the registry's Merkle tree (root is public).
//   2. The slot I am spending is below my daily limit.
//   3. y = k + a1 * x, where a1 = Poseidon(k, externalNullifier, slot).
//      One point on this line reveals nothing; two points with the same slot
//      reveal k (the line's value at x = 0).
//   4. nullifier = Poseidon(a1) is this slot's public tag for the shared log.
//   5. pseudonym = Poseidon(k, siteId) is the stable name this site sees.

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/mux1.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

template MerkleTreeInclusionProof(DEPTH) {
    signal input leaf;
    signal input pathIndex[DEPTH];
    signal input pathElements[DEPTH];

    signal output root;

    signal mux[DEPTH][2];
    signal levelHashes[DEPTH + 1];

    levelHashes[0] <== leaf;
    for (var i = 0; i < DEPTH; i++) {
        pathIndex[i] * (pathIndex[i] - 1) === 0;
        mux[i] <== MultiMux1(2)(
            [
                [levelHashes[i], pathElements[i]],
                [pathElements[i], levelHashes[i]]
            ],
            pathIndex[i]
        );
        levelHashes[i + 1] <== Poseidon(2)([mux[i][0], mux[i][1]]);
    }

    root <== levelHashes[DEPTH];
}

template RangeCheck(LIMIT_BIT_SIZE) {
    assert(LIMIT_BIT_SIZE < 253);

    signal input messageId;
    signal input limit;

    signal messageIdBits[LIMIT_BIT_SIZE] <== Num2Bits(LIMIT_BIT_SIZE)(messageId);
    signal limitBits[LIMIT_BIT_SIZE] <== Num2Bits(LIMIT_BIT_SIZE)(limit);
    signal inRange <== LessThan(LIMIT_BIT_SIZE)([messageId, limit]);
    inRange === 1;
}

template Fuse(DEPTH, LIMIT_BIT_SIZE) {
    // Private inputs
    signal input identitySecret;
    signal input userMessageLimit;
    signal input messageId;
    signal input pathElements[DEPTH];
    signal input identityPathIndex[DEPTH];

    // Public inputs
    signal input x;
    signal input externalNullifier;
    signal input siteId;

    // Public outputs
    signal output y;
    signal output root;
    signal output nullifier;
    signal output pseudonym;

    // Membership: the rate commitment is a leaf of the registry tree.
    signal identityCommitment <== Poseidon(1)([identitySecret]);
    signal rateCommitment <== Poseidon(2)([identityCommitment, userMessageLimit]);
    root <== MerkleTreeInclusionProof(DEPTH)(rateCommitment, identityPathIndex, pathElements);

    // Budget: slot (messageId) < daily limit.
    RangeCheck(LIMIT_BIT_SIZE)(messageId, userMessageLimit);

    // Secret share: one point on the line y = k + a1 * x.
    signal a1 <== Poseidon(3)([identitySecret, externalNullifier, messageId]);
    y <== identitySecret + a1 * x;

    // Slot tag for the shared log.
    nullifier <== Poseidon(1)([a1]);

    // Sticky, site-local pseudonym.
    pseudonym <== Poseidon(2)([identitySecret, siteId]);
}

component main { public [x, externalNullifier, siteId] } = Fuse(20, 16);
