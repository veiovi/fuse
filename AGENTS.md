# Project instructions

Fuse is a prototype of anonymous, rate-limited web access using zero-knowledge
proofs. Read [docs/design.md](docs/design.md) for the model and
[docs/protocol.md](docs/protocol.md) for the wire contract between components.

## Layout

- `circuits/fuse.circom`: the Groth16 circuit (RLN plus per-site pseudonym).
- `packages/core`: shared crypto and wire format, portable between Node and
  browsers. `@fuse/core/node` holds the Node-only helpers.
- `packages/core/artifacts`: compiled circuit, proving key and verifying key.
  They are committed so the prototype runs without circom.
- `packages/{registry,log,gateway,agent,explorer,extension}`: one component each.
- `demo/`: two protected demo sites, scenarios, and the one-command runner.

## Commands

```bash
npm install                 # Node 22+; installs all workspaces
npm test                    # all unit and integration tests (real proofs)
npm run demo                # registry, log, both sites and explorer on ports 4700-4720
npm run demo -- --reset     # same, starting from empty data
npm run build:extension     # Chrome extension → packages/extension/dist (load unpacked)
node packages/extension/test/e2e.mjs   # real-browser extension test (Chromium via playwright-core)
npm run build:circuit       # recompile the circuit + new dev ceremony (needs circom 2.1+)
```

## Rules

- `docs/protocol.md` is the contract. Change it in the same commit as any wire
  or endpoint change, and keep `docs/design.md` true.
- Rebuilding the circuit replaces the proving and verifying keys, which
  invalidates every existing proof and wallet path; rebuild deliberately.
- Clients must derive site ids from the origin they connected to and must
  persist slot reservations before proving. Never weaken either rule.
- Runtime data lives in `.data/` (git-ignored). Never commit wallets.
- Tests use port 0 and call `releaseProver()` so snarkjs worker threads exit.
- Hosted CI is not configured; run `npm test` locally.
