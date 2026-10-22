// Client side of a first contact: turn a site's challenge into an
// Authorization header. Shared by the agent SDK and the browser extension.
import { toField, toHex } from './field.js';
import { identityCommitment, rateCommitment } from './identity.js';
import { MerkleTree } from './merkle.js';
import {
  encodeToken,
  externalNullifierFor,
  formatAuthorizationHeader,
  normalizeOrigin,
  siteIdFor,
  xFor,
} from './protocol.js';
import { buildWitnessInput, generateProof } from './zk.js';

export class NotAMemberError extends Error {
  constructor(message = 'credential is not in the registry tree (revoked, or a different registry)') {
    super(message);
    this.name = 'NotAMemberError';
  }
}

/**
 * Prove one slot for one challenge.
 *
 * `leaves` is the registry's full leaf list: the Merkle path is computed
 * locally so the registry never learns which member is about to spend.
 * `origin` must be the origin the client actually connected to.
 * The caller reserves `slot` (allocateSlot) and persists that before calling.
 */
export async function createFuseAuthorization({
  secret,
  limit,
  index,
  leaves,
  origin,
  challenge,
  epoch,
  slot,
  artifacts,
}) {
  const site = normalizeOrigin(origin);
  const tree = MerkleTree.fromLeaves(leaves.map(toField));
  const expectedLeaf = rateCommitment(identityCommitment(secret), limit);
  if (index >= tree.size || tree.leaf(index) !== expectedLeaf) throw new NotAMemberError();

  const input = buildWitnessInput({
    secret,
    limit,
    slot,
    path: tree.path(index),
    x: xFor(site, challenge),
    externalNullifier: externalNullifierFor(epoch),
    siteId: siteIdFor(site),
  });
  const started = Date.now();
  const { proof, publicSignals } = await generateProof(input, artifacts);
  const token = encodeToken({ epoch, proof, publicSignals });
  return {
    authorization: formatAuthorizationHeader({ origin: site, challenge, token }),
    token,
    origin: site,
    epoch,
    slot,
    pseudonym: toHex(BigInt(publicSignals[3])),
    nullifier: toHex(BigInt(publicSignals[2])),
    root: toHex(BigInt(publicSignals[1])),
    provingMs: Date.now() - started,
  };
}
