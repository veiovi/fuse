// Per-site permission and the decision the in-page card acts on.

export const PERMISSIONS = ['ask', 'always', 'never'];

/**
 * "Always" spends automatically only if no slot went to that site within
 * this window. A site that keeps asking right after a successful first
 * contact (instead of honouring its session cookie) is either broken or
 * draining the budget, so the person gets asked again.
 */
export const AUTO_SPEND_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * What to do when a page presents a Fuse challenge.
 * Returns { action: 'ignore' | 'ask' | 'auto', reason? } where reason is
 * 'recent-spend' or 'banned' when an "always" site is asked about anyway.
 */
export function decideFirstContact({ permission = 'ask', lastSpendAt = null, bannedAt = null, now }) {
  if (permission === 'never') return { action: 'ignore' };
  const reason = bannedAt
    ? 'banned'
    : lastSpendAt !== null && now - lastSpendAt < AUTO_SPEND_COOLDOWN_MS
      ? 'recent-spend'
      : undefined;
  if (permission === 'always' && !reason) return { action: 'auto' };
  return reason ? { action: 'ask', reason } : { action: 'ask' };
}
