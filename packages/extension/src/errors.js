// Error codes shared by the background, the in-page card and the popup.
// Messages are user-facing: short, plain, and honest about whether a slot was spent.

export const ERROR_MESSAGES = {
  'no-credential': 'There is no Fuse credential in this browser yet.',
  'credential-exists': 'This browser already holds a credential. Delete it before getting a new one.',
  'budget-exhausted': 'All of today’s slots are spent.',
  'credential-burned': 'This credential has been burned: the network revoked it.',
  'not-a-member': 'The registry no longer lists this credential.',
  blocked: 'You chose never to use Fuse on this site.',
  'wrong-network': 'This site uses a different Fuse network.',
  'needs-consent': 'This site needs your go-ahead before Fuse spends a slot.',
  'page-gone': 'The page that asked for this proof is gone. No slot was spent.',
  'storage-unprotected':
    'This browser cannot keep the credential’s key out of reach of web pages, so Fuse will not create one. Update Chrome and try again.',
  'registry-unreachable': 'Could not reach the registry.',
  'registry-error': 'The registry refused the request.',
  'proof-failed': 'Generating the proof failed.',
  'bad-request': 'That request was malformed.',
  forbidden: 'That action is not allowed from here.',
  internal: 'Something went wrong inside Fuse.',
};

export class FuseError extends Error {
  constructor(code, message = ERROR_MESSAGES[code] ?? code, details = {}) {
    super(message);
    this.name = 'FuseError';
    this.code = code;
    this.details = details;
  }
}

/** JSON-safe form for runtime messages. */
export function errorPayload(err) {
  if (err instanceof FuseError) return { code: err.code, message: err.message, ...err.details };
  return { code: 'internal', message: err?.message || ERROR_MESSAGES.internal };
}
