// Field arithmetic and byte helpers. Portable: runs in Node and browsers.
import { sha256 } from '@noble/hashes/sha2';
import { FIELD_MODULUS as P } from './constants.js';

export function mod(a) {
  const r = a % P;
  return r < 0n ? r + P : r;
}
export const add = (a, b) => mod(a + b);
export const sub = (a, b) => mod(a - b);
export const mul = (a, b) => mod(a * b);

/** Multiplicative inverse mod P (extended Euclid). */
export function inv(a) {
  a = mod(a);
  if (a === 0n) throw new RangeError('0 has no inverse');
  let [t, nextT, r, nextR] = [0n, 1n, P, a];
  while (nextR !== 0n) {
    const q = r / nextR;
    [t, nextT] = [nextT, t - q * nextT];
    [r, nextR] = [nextR, r - q * nextR];
  }
  return mod(t);
}
export const div = (a, b) => mul(a, inv(b));

const encoder = new TextEncoder();
export const utf8 = (s) => encoder.encode(s);

export function concatBytes(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function bytesToBigInt(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

export function bigIntToBytes(v, length = 32) {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new RangeError(`value does not fit in ${length} bytes`);
  return out;
}

/**
 * Domain-separated hash of strings/bytes into the field: SHA-256 over
 * length-prefixed parts, reduced mod P. Used for site ids, x values and the
 * network id, which the circuit takes as public inputs.
 */
export function hashToField(domain, ...parts) {
  const framed = [];
  for (const part of [domain, ...parts]) {
    const bytes = typeof part === 'string' ? utf8(part) : part;
    framed.push(bigIntToBytes(BigInt(bytes.length), 4), bytes);
  }
  return mod(bytesToBigInt(sha256(concatBytes(...framed))));
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** Uniform random field element (64 random bytes reduced mod P). */
export function randomFieldElement() {
  return mod(bytesToBigInt(randomBytes(64)));
}

/** 0x-prefixed, 64-hex-digit encoding of a field element. */
export const toHex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');

/** Parse a bigint, decimal string, or 0x-hex string into a field element. */
export function toField(v) {
  if (typeof v === 'bigint') return checkRange(v);
  if (typeof v === 'number') return checkRange(BigInt(v));
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return checkRange(BigInt(s));
    if (/^[0-9]+$/.test(s)) return checkRange(BigInt(s));
  }
  throw new TypeError(`not a field element: ${String(v).slice(0, 80)}`);
}
export const fromHex = toField;

function checkRange(v) {
  if (v < 0n || v >= P) throw new RangeError('value outside the BN254 scalar field');
  return v;
}

export function base64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new TypeError('invalid base64url');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const s = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
