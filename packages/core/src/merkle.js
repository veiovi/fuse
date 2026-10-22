// Fixed-depth binary Poseidon Merkle tree matching the circuit's
// MerkleTreeInclusionProof. Empty leaves are 0; a removed (burned) member's
// leaf is set back to 0, so indexes never move.
import { TREE_DEPTH } from './constants.js';
import { poseidon } from './poseidon.js';

const zeroCache = new Map();

function zeroHashes(depth) {
  if (!zeroCache.has(depth)) {
    const zeros = [0n];
    for (let i = 0; i < depth; i++) zeros.push(poseidon([zeros[i], zeros[i]]));
    zeroCache.set(depth, zeros);
  }
  return zeroCache.get(depth);
}

export class MerkleTree {
  constructor(depth = TREE_DEPTH) {
    this.depth = depth;
    this.zeros = zeroHashes(depth);
    this.layers = Array.from({ length: depth + 1 }, () => new Map());
    this.size = 0;
  }

  /** Build a tree from a leaf array in O(n) hashes. */
  static fromLeaves(leaves, depth = TREE_DEPTH) {
    const tree = new MerkleTree(depth);
    if (leaves.length > 2 ** depth) throw new RangeError('too many leaves for tree depth');
    leaves.forEach((leaf, i) => tree.layers[0].set(i, BigInt(leaf)));
    tree.size = leaves.length;
    let count = leaves.length;
    for (let level = 0; level < depth; level++) {
      const parents = Math.ceil(count / 2);
      for (let i = 0; i < parents; i++) {
        tree.layers[level + 1].set(
          i,
          poseidon([tree.node(level, 2 * i), tree.node(level, 2 * i + 1)]),
        );
      }
      count = parents;
    }
    return tree;
  }

  node(level, index) {
    return this.layers[level].get(index) ?? this.zeros[level];
  }

  get root() {
    return this.node(this.depth, 0);
  }

  leaf(index) {
    return this.node(0, index);
  }

  leaves() {
    return Array.from({ length: this.size }, (_, i) => this.leaf(i));
  }

  /** Append a leaf; returns its index. */
  insert(leaf) {
    const index = this.size;
    this.update(index, leaf);
    return index;
  }

  /** Set the leaf at index (0 removes a member) and rehash its path. */
  update(index, leaf) {
    if (!Number.isInteger(index) || index < 0 || index >= 2 ** this.depth) {
      throw new RangeError(`leaf index out of range: ${index}`);
    }
    this.layers[0].set(index, BigInt(leaf));
    this.size = Math.max(this.size, index + 1);
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      const left = this.node(level, i & ~1);
      const right = this.node(level, i | 1);
      i >>= 1;
      this.layers[level + 1].set(i, poseidon([left, right]));
    }
  }

  /** Sibling path for a leaf, in the circuit's input format. */
  path(index) {
    if (index < 0 || index >= this.size) throw new RangeError(`no leaf at index ${index}`);
    const pathElements = [];
    const pathIndices = [];
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      pathElements.push(this.node(level, i ^ 1));
      pathIndices.push(i & 1);
      i >>= 1;
    }
    return { pathElements, pathIndices };
  }

  static rootFromPath(leaf, { pathElements, pathIndices }) {
    let node = BigInt(leaf);
    pathElements.forEach((sibling, level) => {
      node = pathIndices[level] ? poseidon([sibling, node]) : poseidon([node, sibling]);
    });
    return node;
  }
}
