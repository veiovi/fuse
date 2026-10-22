// Node-only helpers: bundled circuit artifacts and prover shutdown.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const artifact = (name) => fileURLToPath(new URL(`../artifacts/${name}`, import.meta.url));

export const artifactPaths = {
  wasm: artifact('fuse.wasm'),
  zkey: artifact('fuse.zkey'),
  vkey: artifact('verification_key.json'),
};

/** { wasm, zkey } for generateProof / createFuseAuthorization. */
export const nodeArtifacts = { wasm: artifactPaths.wasm, zkey: artifactPaths.zkey };

let vkey;
export function loadVerificationKey() {
  vkey ??= JSON.parse(readFileSync(artifactPaths.vkey, 'utf8'));
  return vkey;
}

/**
 * snarkjs keeps a pool of worker threads alive after proving or verifying.
 * Short-lived scripts call this so the process can exit.
 */
export async function releaseProver() {
  const curve = globalThis.curve_bn128;
  if (curve?.terminate) await curve.terminate();
}
