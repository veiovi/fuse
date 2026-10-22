/**
 * Run async tasks one at a time, in call order. Every wallet mutation goes
 * through one queue, so two proofs can never reserve the same slot and a
 * slow proof cannot interleave with a delete or a registration.
 */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return function run(task) {
    const result = tail.then(() => task());
    tail = result.catch(() => {});
    return result;
  };
}
