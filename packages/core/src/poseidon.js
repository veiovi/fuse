// Poseidon hash over BN254, identical to circomlib's Poseidon template.
import { poseidon1 } from 'poseidon-lite/poseidon1';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { poseidon3 } from 'poseidon-lite/poseidon3';

const byArity = [null, poseidon1, poseidon2, poseidon3];

/** Poseidon of 1–3 field elements. */
export function poseidon(inputs) {
  const fn = byArity[inputs.length];
  if (!fn) throw new RangeError(`poseidon arity ${inputs.length} not supported`);
  return fn(inputs.map(BigInt));
}
