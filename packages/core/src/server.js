// Verifier side. The gateway checks tokens against its own origin and
// challenge; the shared log re-checks the proof from the x and siteId the
// gateway forwards. Neither function checks root freshness (registry state)
// or challenge authenticity (gateway state); callers do that.
import { toField } from './field.js';
import {
  acceptableEpochs,
  decodeToken,
  externalNullifierFor,
  normalizeOrigin,
  publicSignalsFrom,
  siteIdFor,
  xFor,
} from './protocol.js';
import { verifyProof } from './zk.js';

async function verifyWithInputs({ token, x, siteId, vkey, now }) {
  let decoded;
  try {
    decoded = decodeToken(token);
  } catch (err) {
    return { ok: false, reason: 'malformed-token', detail: err.message };
  }
  if (!acceptableEpochs(now).includes(decoded.epoch)) {
    return { ok: false, reason: 'wrong-epoch', epoch: decoded.epoch };
  }
  const signals = {
    ...decoded.outputs,
    x: toField(x),
    externalNullifier: externalNullifierFor(decoded.epoch),
    siteId: toField(siteId),
  };
  const valid = await verifyProof(vkey, publicSignalsFrom({ outputs: decoded.outputs, ...signals }), decoded.proof);
  if (!valid) return { ok: false, reason: 'bad-proof' };
  return { ok: true, epoch: decoded.epoch, signals };
}

/**
 * Verify a token presented at `origin` for `challenge`.
 * Returns { ok, epoch, signals: { y, root, nullifier, pseudonym, x, externalNullifier, siteId } }
 * with bigint signals, or { ok: false, reason }.
 */
export async function verifyFuseToken({ token, challenge, origin, vkey, now = Date.now() }) {
  const site = normalizeOrigin(origin);
  return verifyWithInputs({ token, x: xFor(site, challenge), siteId: siteIdFor(site), vkey, now });
}

/** Verify a log submission, where x and siteId come from the forwarding gateway. */
export async function verifyLogSubmission({ token, x, siteId, vkey, now = Date.now() }) {
  return verifyWithInputs({ token, x, siteId, vkey, now });
}
