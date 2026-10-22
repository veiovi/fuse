// Fuse wire format and the public values both sides derive independently:
// epochs, site ids, x values, external nullifiers, tokens and HTTP headers.
import {
  AUTH_SCHEME,
  EPOCH_GRACE_SECONDS,
  EPOCH_SECONDS,
  NETWORK,
  PUBLIC_SIGNALS,
  TOKEN_VERSION,
} from './constants.js';
import {
  base64urlDecode,
  base64urlEncode,
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  hashToField,
  toField,
} from './field.js';
import { poseidon } from './poseidon.js';

/** Canonical origin (scheme://host[:port]) of a URL or origin string. */
export function normalizeOrigin(input) {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`Fuse origins must be http(s): ${input}`);
  }
  return url.origin;
}

/** Field element naming the shared budget domain. */
export const networkId = hashToField('fuse/network', NETWORK);

export function epochAt(ms = Date.now()) {
  return Math.floor(ms / 1000 / EPOCH_SECONDS);
}

export function epochBounds(epoch) {
  const start = epoch * EPOCH_SECONDS * 1000;
  return { start, end: start + EPOCH_SECONDS * 1000 };
}

/**
 * Epochs a verifier accepts at time ms: the current one, plus a neighbour
 * within EPOCH_GRACE_SECONDS of the boundary to absorb clock skew.
 */
export function acceptableEpochs(ms = Date.now()) {
  const epoch = epochAt(ms);
  const into = ms / 1000 - epoch * EPOCH_SECONDS;
  const epochs = [epoch];
  if (into < EPOCH_GRACE_SECONDS) epochs.push(epoch - 1);
  if (EPOCH_SECONDS - into < EPOCH_GRACE_SECONDS) epochs.push(epoch + 1);
  return epochs;
}

/** Same for every site on the network, so a slot is global, not per-site. */
export function externalNullifierFor(epoch) {
  return poseidon([BigInt(epoch), networkId]);
}

/**
 * Site id the pseudonym is bound to. Clients MUST derive it from the origin
 * they actually connected to, never from a server-supplied name; otherwise a
 * malicious site could learn your pseudonym at another site.
 */
export function siteIdFor(origin) {
  return hashToField('fuse/site', normalizeOrigin(origin));
}

/** x coordinate of the share: fixed by the site and its one-time challenge. */
export function xFor(origin, challenge) {
  return hashToField('fuse/x', normalizeOrigin(origin), challenge);
}

// ---------------------------------------------------------------------------
// Token: version(1) | epoch(u32) | Groth16 proof (8 x 32) | y | root | nullifier | pseudonym (4 x 32)
// The verifier recomputes x, externalNullifier and siteId itself.

const PROOF_WORDS = 8;
const OUTPUT_NAMES = PUBLIC_SIGNALS.slice(0, 4);
export const TOKEN_BYTES = 1 + 4 + 32 * (PROOF_WORDS + OUTPUT_NAMES.length);

function proofToWords(proof) {
  const [a, b, c] = [proof.pi_a, proof.pi_b, proof.pi_c];
  return [a[0], a[1], b[0][0], b[0][1], b[1][0], b[1][1], c[0], c[1]].map(BigInt);
}

function wordsToProof(w) {
  const s = w.map(String);
  return {
    pi_a: [s[0], s[1], '1'],
    pi_b: [[s[2], s[3]], [s[4], s[5]], ['1', '0']],
    pi_c: [s[6], s[7], '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };
}

export function encodeToken({ epoch, proof, publicSignals }) {
  const words = [...proofToWords(proof), ...publicSignals.slice(0, OUTPUT_NAMES.length).map(BigInt)];
  return base64urlEncode(
    concatBytes(
      Uint8Array.of(TOKEN_VERSION),
      bigIntToBytes(BigInt(epoch), 4),
      ...words.map((w) => bigIntToBytes(w, 32)),
    ),
  );
}

export function decodeToken(token) {
  const bytes = base64urlDecode(token);
  if (bytes.length !== TOKEN_BYTES) throw new TypeError(`token must be ${TOKEN_BYTES} bytes`);
  if (bytes[0] !== TOKEN_VERSION) throw new TypeError(`unsupported token version ${bytes[0]}`);
  const epoch = Number(bytesToBigInt(bytes.subarray(1, 5)));
  const words = [];
  for (let off = 5; off < bytes.length; off += 32) words.push(bytesToBigInt(bytes.subarray(off, off + 32)));
  const outputs = Object.fromEntries(
    OUTPUT_NAMES.map((name, i) => [name, toField(words[PROOF_WORDS + i])]),
  );
  return { version: TOKEN_VERSION, epoch, proof: wordsToProof(words.slice(0, PROOF_WORDS)), outputs };
}

/** Full public-signal array (decimal strings, circuit order) for verification. */
export function publicSignalsFrom({ outputs, x, externalNullifier, siteId }) {
  const values = { ...outputs, x, externalNullifier, siteId };
  return PUBLIC_SIGNALS.map((name) => BigInt(values[name]).toString());
}

export function signalsToObject(publicSignals) {
  return Object.fromEntries(PUBLIC_SIGNALS.map((name, i) => [name, BigInt(publicSignals[i])]));
}

// ---------------------------------------------------------------------------
// HTTP authentication headers (shaped like RFC 9577 Privacy Pass).

function quote(v) {
  return `"${String(v).replace(/["\\]/g, '')}"`;
}

/** WWW-Authenticate value a gateway sends with a 401. */
export function formatChallengeHeader({ challenge, registry }) {
  const params = [`challenge=${quote(challenge)}`, `network=${quote(NETWORK)}`];
  if (registry) params.push(`registry=${quote(registry)}`);
  return `${AUTH_SCHEME} ${params.join(', ')}`;
}

/**
 * Authorization value a client sends back. `origin` names the origin the
 * client connected to (and bound its pseudonym to); the gateway accepts it
 * only if it is one of its own.
 */
export function formatAuthorizationHeader({ origin, challenge, token }) {
  return `${AUTH_SCHEME} origin=${quote(normalizeOrigin(origin))}, challenge=${quote(challenge)}, token=${quote(token)}`;
}

/** Parse `Fuse k="v", ...` from a WWW-Authenticate or Authorization value; null if absent. */
export function parseFuseHeader(value) {
  if (!value) return null;
  const at = value.search(new RegExp(`(^|[\\s,])${AUTH_SCHEME}\\s`, 'i'));
  if (at < 0) return null;
  const rest = value.slice(at).replace(new RegExp(`^[\\s,]*${AUTH_SCHEME}\\s+`, 'i'), '');
  const params = {};
  const re = /([A-Za-z][\w-]*)=(?:"([^"]*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(rest))) params[m[1].toLowerCase()] = m[2] ?? m[3];
  return params;
}
