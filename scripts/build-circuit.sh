#!/usr/bin/env bash
# Compile circuits/fuse.circom and run a local, single-party Groth16 setup.
#
# Output (committed, so nobody needs circom to run the prototype):
#   packages/core/artifacts/fuse.wasm               witness generator
#   packages/core/artifacts/fuse.zkey               proving key
#   packages/core/artifacts/verification_key.json   verifying key
#
# The setup here is a development ceremony with one contributor. Anyone who
# kept its toxic waste could forge proofs, so a real deployment needs a
# multi-party ceremony (or a transparent proof system).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/circuits/build"
OUT="$ROOT/packages/core/artifacts"
SNARKJS="$ROOT/node_modules/.bin/snarkjs"
POWER="${FUSE_PTAU_POWER:-14}"

CIRCOM="$(command -v circom || true)"
if [[ -z "$CIRCOM" && -x "$HOME/.cargo/bin/circom" ]]; then
  CIRCOM="$HOME/.cargo/bin/circom"
fi
if [[ -z "$CIRCOM" ]]; then
  echo "circom 2.1+ is required: cargo install --locked --git https://github.com/iden3/circom.git --tag v2.2.2 circom" >&2
  exit 1
fi

mkdir -p "$BUILD" "$OUT"

echo "==> compiling circuit"
"$CIRCOM" "$ROOT/circuits/fuse.circom" --O2 --r1cs --wasm --sym -l "$ROOT/node_modules" -o "$BUILD"
"$SNARKJS" r1cs info "$BUILD/fuse.r1cs"

entropy() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'; }

echo "==> powers of tau (2^$POWER), local dev contribution"
"$SNARKJS" powersoftau new bn128 "$POWER" "$BUILD/pot_0000.ptau"
"$SNARKJS" powersoftau contribute "$BUILD/pot_0000.ptau" "$BUILD/pot_0001.ptau" --name="fuse dev" -e="$(entropy)"
"$SNARKJS" powersoftau prepare phase2 "$BUILD/pot_0001.ptau" "$BUILD/pot_final.ptau"

echo "==> groth16 circuit-specific setup"
"$SNARKJS" groth16 setup "$BUILD/fuse.r1cs" "$BUILD/pot_final.ptau" "$BUILD/fuse_0000.zkey"
"$SNARKJS" zkey contribute "$BUILD/fuse_0000.zkey" "$BUILD/fuse_final.zkey" --name="fuse dev" -e="$(entropy)"
"$SNARKJS" zkey export verificationkey "$BUILD/fuse_final.zkey" "$OUT/verification_key.json"

cp "$BUILD/fuse_js/fuse.wasm" "$OUT/fuse.wasm"
cp "$BUILD/fuse_final.zkey" "$OUT/fuse.zkey"

echo "==> done"
ls -la "$OUT"
