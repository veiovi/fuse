// Credential secrets, commitments, pseudonyms, and the client wallet's slot
// bookkeeping. The wallet is plain JSON so the SDK can keep it in a file and
// the extension in chrome.storage.
import { randomFieldElement, toField, toHex } from './field.js';
import { poseidon } from './poseidon.js';
import { epochAt, siteIdFor } from './protocol.js';

export function identityCommitment(secret) {
  return poseidon([toField(secret)]);
}

/** Registry leaf: binds the commitment to its daily limit (RLN v2). */
export function rateCommitment(commitment, limit) {
  return poseidon([toField(commitment), BigInt(limit)]);
}

/** Stable per-site pseudonym. Same site → same value; different sites → unrelated values. */
export function pseudonymFor(secret, origin) {
  return poseidon([toField(secret), siteIdFor(origin)]);
}

/** Short display form, e.g. anon-3f2a91c0. */
export function shortPseudonym(pseudonym) {
  return 'anon-' + toHex(toField(pseudonym)).slice(-8);
}

export function createIdentity() {
  const secret = randomFieldElement();
  return { secret, commitment: identityCommitment(secret) };
}

/**
 * Wallet shape (all field elements as 0x-hex strings):
 * { version, secret, commitment, registry, index, limit, tier, spent: { [epoch]: number[] }, history: [] }
 */
export function createWallet({ secret, registry, index, limit, tier }) {
  const s = toField(secret);
  return {
    version: 1,
    secret: toHex(s),
    commitment: toHex(identityCommitment(s)),
    registry,
    index,
    limit,
    tier,
    spent: {},
    history: [],
  };
}

export function slotsUsed(wallet, epoch = epochAt()) {
  return (wallet.spent?.[epoch] ?? []).length;
}

export function remainingSlots(wallet, epoch = epochAt()) {
  return Math.max(0, wallet.limit - slotsUsed(wallet, epoch));
}

/**
 * Reserve the lowest unused slot for an epoch, or null if the budget is gone.
 * Mutates the wallet; persist it BEFORE generating a proof. A slot is spent
 * once a proof exists, even if the request then fails: reusing it with a new
 * challenge would put a second point on the same line and burn the credential.
 */
export function allocateSlot(wallet, epoch = epochAt()) {
  wallet.spent ??= {};
  const used = new Set(wallet.spent[epoch] ?? []);
  for (let slot = 0; slot < wallet.limit; slot++) {
    if (!used.has(slot)) {
      wallet.spent[epoch] = [...used, slot].sort((a, b) => a - b);
      // Old epochs can never be spent again; drop their bookkeeping.
      for (const e of Object.keys(wallet.spent)) if (Number(e) < epoch - 1) delete wallet.spent[e];
      return slot;
    }
  }
  return null;
}

/** Undo a reservation that never produced a proof (e.g. membership check failed first). */
export function releaseSlot(wallet, epoch, slot) {
  wallet.spent[epoch] = (wallet.spent[epoch] ?? []).filter((s) => s !== slot);
}
