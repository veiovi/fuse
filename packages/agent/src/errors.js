// Errors the agent throws when it cannot, or must not, answer a challenge.
// Each carries a stable kebab-case `code` for programmatic checks:
//   budget-exhausted, credential-burned, banned (the subclasses below);
//   repeat-challenge, first-contact-cooldown (refused locally, nothing proved);
//   wallet-exists, no-wallet, bad-wallet, deposit-refused, deposit-mismatch,
//   registry-unavailable.

/** Base class for agent errors. Extra details (e.g. `reason`, `retryAt`) become properties. */
export class FuseAgentError extends Error {
  constructor(message, { code = 'agent-error', origin, status, body, cause, ...details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.origin = origin;
    this.status = status;
    this.body = body;
    Object.assign(this, details);
  }
}

/**
 * Every slot of the current epoch is spent. Raised locally, before anything
 * is sent: the agent never proves without a fresh slot.
 */
export class BudgetExhaustedError extends FuseAgentError {
  /** @param {{ origin?: string, epoch: number, limit: number, resetsAt: string }} details */
  constructor({ origin, epoch, limit, resetsAt }) {
    super(`daily budget exhausted: all ${limit} slots of epoch ${epoch} are spent; resets at ${resetsAt}`, {
      code: 'budget-exhausted',
      origin,
      epoch,
      limit,
      resetsAt,
    });
  }
}

/**
 * The credential is unusable. `reason` is `credential-burned` (a gateway
 * reported that the shared log saw one of its slots twice) or `not-a-member`
 * (the registry tree no longer holds its leaf: burned or withdrawn).
 */
export class CredentialBurnedError extends FuseAgentError {
  /** @param {{ origin?: string, reason: string, status?: number, body?: object, cause?: Error }} details */
  constructor({ origin, reason, status, body, cause }) {
    const what =
      reason === 'not-a-member'
        ? 'the registry tree no longer contains this credential (burned or withdrawn)'
        : 'the network burned this credential (a slot was used twice)';
    super(`credential unusable: ${what}`, { code: 'credential-burned', origin, status, body, cause, reason });
  }
}

/**
 * The site has banned this credential's pseudonym. Proving again cannot help:
 * the same credential always yields the same pseudonym at the same site.
 */
export class BannedError extends FuseAgentError {
  /** @param {{ origin: string, pseudonym?: string, status?: number, body?: object }} details */
  constructor({ origin, pseudonym, status, body }) {
    super(`banned at ${origin}${body?.reason ? ` (${body.reason})` : ''}`, {
      code: 'banned',
      origin,
      status,
      body,
      pseudonym,
      reason: body?.reason,
    });
  }
}
