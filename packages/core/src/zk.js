// Groth16 proving and verification for circuits/fuse.circom via snarkjs.
import * as snarkjs from 'snarkjs';
import { toField } from './field.js';

/** Circuit input object (decimal strings) from Fuse values. */
export function buildWitnessInput({ secret, limit, slot, path, x, externalNullifier, siteId }) {
  return {
    identitySecret: toField(secret).toString(),
    userMessageLimit: String(limit),
    messageId: String(slot),
    pathElements: path.pathElements.map(String),
    identityPathIndex: path.pathIndices.map(String),
    x: toField(x).toString(),
    externalNullifier: toField(externalNullifier).toString(),
    siteId: toField(siteId).toString(),
  };
}

// snarkjs builds its BN254 curve, with a worker-thread pool, on first use and
// caches it on globalThis. Two first calls racing each other build two pools
// and orphan one, which keeps Node alive, so callers wait for the first build.
let warming = null;
async function withCurve(run) {
  while (!globalThis.curve_bn128 && warming) await warming;
  if (globalThis.curve_bn128) return run();
  const result = run();
  warming = result.then(
    () => {},
    () => {},
  ).finally(() => {
    warming = null;
  });
  return result;
}

/**
 * Generate a proof. artifacts.wasm / artifacts.zkey are file paths (Node),
 * URLs (browser), or { type: 'mem', data: Uint8Array }.
 */
export async function generateProof(input, artifacts) {
  if (!artifacts?.wasm || !artifacts?.zkey) throw new TypeError('generateProof needs { wasm, zkey }');
  const { proof, publicSignals } = await withCurve(() =>
    snarkjs.groth16.fullProve(input, artifacts.wasm, artifacts.zkey),
  );
  return { proof, publicSignals };
}

export async function verifyProof(vkey, publicSignals, proof) {
  try {
    return await withCurve(() => snarkjs.groth16.verify(vkey, publicSignals, proof));
  } catch {
    return false;
  }
}
