// Network-wide Fuse parameters. Every client, registry, log and gateway on the
// same network must agree on these.

/** BN254 scalar field modulus: all circuit values live in this field. */
export const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Depth of every registry's membership tree (2^20 ≈ 1M credentials). */
export const TREE_DEPTH = 20;

/** Daily limits and slot numbers must fit in this many bits (circuit RangeCheck). */
export const LIMIT_BITS = 16;
export const MAX_LIMIT = 2 ** LIMIT_BITS - 1;

/** One budget epoch. Slots reset when the epoch number changes. */
export const EPOCH_SECONDS = 86400;

/** Clock-skew window around an epoch boundary in which the neighbouring epoch is accepted. */
export const EPOCH_GRACE_SECONDS = 300;

/** Name of the shared budget domain. Slots are global across every site on it. */
export const NETWORK = 'fuse-demo-v1';

/** HTTP authentication scheme name used in WWW-Authenticate / Authorization. */
export const AUTH_SCHEME = 'Fuse';

/** Binary token layout version. */
export const TOKEN_VERSION = 1;

/** Public signal order produced by circuits/fuse.circom: outputs, then public inputs. */
export const PUBLIC_SIGNALS = ['y', 'root', 'nullifier', 'pseudonym', 'x', 'externalNullifier', 'siteId'];
