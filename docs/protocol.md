# Fuse protocol and component contracts

This is the wire-level contract between the Fuse components in this repository:
the shared crypto core, the registry, the shared log, gateways, the agent SDK,
the browser extension and the explorer. [design.md](design.md) explains *why*;
this file says *exactly what goes over the wire*.

All field elements travel as `0x`-prefixed, 64-hex-digit strings unless stated
otherwise. Times are ISO-8601 strings. Every server sends
`Access-Control-Allow-Origin: *` on its JSON and SSE endpoints (demo setting).

## 1. Network parameters (`@fuse/core` constants)

| Name | Value | Meaning |
|---|---|---|
| `NETWORK` | `fuse-demo-v1` | Shared budget domain. Slots are global across all sites on it. |
| `EPOCH_SECONDS` | `86400` | One budget day (UTC). `epoch = floor(unixSeconds / 86400)`. |
| `EPOCH_GRACE_SECONDS` | `300` | Verifiers also accept the neighbouring epoch within 5 minutes of a boundary. |
| `TREE_DEPTH` | `20` | Registry membership tree depth (≈1M credentials per registry). |
| `LIMIT_BITS` | `16` | Daily limits and slot numbers are < 2^16. |

## 2. Cryptographic objects

Poseidon is circomlib's Poseidon over the BN254 scalar field `p`.
`H2F(domain, ...parts)` is SHA-256 over length-prefixed parts, reduced mod `p`.

| Object | Definition | Who knows it |
|---|---|---|
| secret key `k` | random field element | client only |
| identity commitment | `Poseidon(k)` | registry (public) |
| leaf (rate commitment) | `Poseidon(commitment, limit)` | registry tree (public) |
| network id | `H2F("fuse/network", NETWORK)` | everyone |
| external nullifier | `Poseidon(epoch, networkId)` | everyone; same for all sites |
| site id | `H2F("fuse/site", origin)` | everyone |
| x | `H2F("fuse/x", origin, challenge)` | client and the site |
| slope `a1` | `Poseidon(k, externalNullifier, slot)` | client only |
| share | `y = k + a1·x` | site and log (one point on a secret line) |
| slot tag (nullifier) | `Poseidon(a1)` | site and log; random-looking |
| pseudonym | `Poseidon(k, siteId)` | that site only |

`origin` is the canonical `scheme://host[:port]` (`new URL(u).origin`). Clients
MUST derive it from the URL they actually connected to, never from anything the
server says, or a malicious site could ask for another site's pseudonym.

Two shares with the same slot tag and different `x` recover the key:
`k = y1 − x1·(y1 − y2)/(x1 − x2)` (`recoverSecret` in `@fuse/core`).

### Circuit (`circuits/fuse.circom`, Groth16 on BN254)

Private inputs: `identitySecret, userMessageLimit, messageId (slot), pathElements[20], identityPathIndex[20]`.
Public inputs: `x, externalNullifier, siteId`.
Outputs: `y, root, nullifier, pseudonym`.
Public signal order: `[y, root, nullifier, pseudonym, x, externalNullifier, siteId]`.

Constraints proven: leaf is in the tree with that root; `slot < limit`;
`y`, `nullifier` and `pseudonym` are computed from the same `k` as above.

## 3. Token and HTTP headers

**Token** (base64url, no padding, 519 characters):

```
version (1 byte = 0x01) | epoch (uint32 BE) | Groth16 proof (8 × 32 bytes) | y | root | nullifier | pseudonym (4 × 32 bytes)
```

Proof word order: `pi_a[0], pi_a[1], pi_b[0][0], pi_b[0][1], pi_b[1][0], pi_b[1][1], pi_c[0], pi_c[1]`.
The verifier recomputes `x`, `externalNullifier` and `siteId` itself.

**Challenge** (gateway → client, on a 401):

```
WWW-Authenticate: Fuse challenge="<opaque>", network="fuse-demo-v1", registry="<registry URL>"
```

The challenge string is opaque to clients. Gateways in this repo use
`base64url(JSON{v,n,exp}) + "." + base64url(HMAC-SHA256)`, single-use, 120 s TTL.

**Authorization** (client → gateway):

```
Authorization: Fuse origin="http://forum.localhost:4710", challenge="<opaque>", token="<token>"
```

`@fuse/core` provides `formatChallengeHeader`, `formatAuthorizationHeader`,
`parseFuseHeader`, `encodeToken`, `decodeToken`, `createFuseAuthorization`
(client) and `verifyFuseToken` / `verifyLogSubmission` (verifiers).

## 4. Client rules (SDK and extension)

1. Keep `k` local. Fetch the registry's full leaf list (`GET /tree`) and build
   the Merkle path locally, so the registry never learns who is spending.
2. Reserve a slot with `allocateSlot(wallet, epoch)` and persist the wallet
   **before** proving. A slot is spent once a proof exists, even if the request
   fails. Never reuse a slot: a second point on the same line burns the key.
3. Use your own clock for `epoch`. Never let a server choose it.
4. One credential per device, or partition slots between devices.
5. After a successful first contact, use the site's session cookie; do not
   spend more slots on that site while the session lives.

## 5. Ports (demo defaults)

| Port | Service | Package |
|---|---|---|
| 4700 | Explorer (network view + scenario runner) | `@fuse/explorer` |
| 4701 | Registry | `@fuse/registry` |
| 4702 | Shared log | `@fuse/log` |
| 4710 | Acme Forum at `http://forum.localhost:4710`: gateway in reverse-proxy mode | `@fuse/gateway` + `demo/sites/forum` |
| 4711 | Acme Forum upstream app (loopback only) | `demo/sites/forum` |
| 4720 | Bolt API at `http://api.localhost:4720`: Express app with gateway middleware | `demo/sites/api` |

Servers bind `127.0.0.1` by default (`FUSE_BIND` overrides). The registry,
log and explorer use `http://localhost:<port>`. The two sites get their own
host names (`*.localhost` resolves to loopback in browsers and Node) because
browsers share cookies across ports on one host, which would let one site see
the other's session cookie.

## 6. Registry (`@fuse/registry`, port 4701)

`startRegistry({ port, host, dataDir, publicUrl }) → Promise<{ url, close() }>`

| Method & path | Request | Response |
|---|---|---|
| `GET /info` | | `{ name, backing: "deposit", network, depth, currency, tiers: [{ id, deposit, limit }], size, active, burned, withdrawn, root, lockedDeposits, slashedDeposits }` |
| `POST /deposits` | `{ commitment, tier }` | `201 { index, leaf, limit, tier, root, deposit: { id, amount, currency, status: "locked" } }`; `400` bad input; `409` commitment already registered or burned (a withdrawn commitment may rejoin) |
| `GET /tree` | | `{ depth, size, root, leaves: [hex] }` (burned leaves are zero) |
| `GET /roots` | | `{ current, valid: [hex] }`: roots accepted for proofs, newest first. Removing a member resets `valid` to the new root only. |
| `GET /members` | | `{ members: [{ index, commitment, tier, limit, status: "active" \| "burned" \| "withdrawn", joinedAt, endedAt?, deposit, evidence? }] }` (`evidence` on burned members) |
| `POST /slash` | `{ secret, evidence? }` | `200 { index, commitment, root, slashed: { amount, currency } }` (`alreadyBurned: true` if repeated); `404` no member has that key. Self-authenticating: knowing `k` proves it leaked. |
| `POST /withdraw` | `{ secret }` | `200 { index, commitment, root, refunded: { amount, currency } }`. Prototype shortcut: reveals `k` to the registry at exit. |
| `GET /events` | | SSE: `hello` (the `/info` fields), `member-joined`, `member-slashed`, `member-withdrawn` (each `{ member, root, … }`) |

Demo tiers (deposits are simulated "demo credits", no money moves):
`starter` 5 → 10 slots/day, `pro` 50 → 200 slots/day, `fleet` 500 → 2000 slots/day.

## 7. Shared log (`@fuse/log`, port 4702)

`startLog({ port, host, dataDir, registries: [url], publicUrl }) → Promise<{ url, close() }>`

| Method & path | Request | Response |
|---|---|---|
| `GET /info` | | `{ name, network, epochSeconds, epoch, size, revocations, publicKey, sth, registries }` (`publicKey`: Ed25519, base64 SPKI DER) |
| `POST /entries` | `{ token, x, siteId }` from a gateway | see below |
| `GET /entries?after=<seq>&limit=<n>` | | `{ size, entries: [{ seq, epoch, nullifier, x, y, at, revocation? }] }`; `seq` is 0-based (the RFC 6962 leaf index), `after` is exclusive and defaults to −1 |
| `GET /entries/:seq/proof?treeSize=<n>` | | RFC 6962 inclusion proof `{ seq, treeSize, leafHash, auditPath: [hex], rootHash }` |
| `GET /sth` | | Signed tree head `{ treeSize, rootHash, timestamp, signature }`: Ed25519 (base64) over `fuse-log-sth:v1:<treeSize>:<rootHash>:<timestamp>`; hashes are plain hex, timestamps ISO |
| `GET /revocations` | | `{ revocations: [Revocation] }` |
| `GET /events` | | SSE: `hello` (the `/info` fields), `entry` `{ entry, sth }`, `replay` `{ entry }`, `double-spend` `{ revocation }` |

`POST /entries` verifies the proof (`verifyLogSubmission`), checks the root is in
some configured registry's `valid` roots, then looks up the slot tag:

- new tag → append `{ seq, epoch, nullifier, x, y, at }`, return
  `201 { status: "fresh", entry, receipt: { seq, treeSize, rootHash, timestamp, signature } }`
- same tag, same `x` and `y` → `409 { status: "replay", entry }`
- same tag, different `x` → recover `k`, `POST /slash` to the registries,
  append the second share as evidence (its entry carries `revocation: <id>`),
  publish a Revocation, return `409 { status: "double-spend", revocation }`
- otherwise `400 { status: "invalid", reason: "malformed-token" | "wrong-epoch" | "bad-proof" | "unknown-root" }`

The log stores only the tag, epoch and share. It sees `siteId` and the
pseudonym while checking the proof and discards them.

```
Revocation = { id, at, epoch, nullifier, secret, commitment,
               shares: [{ x, y, seq }, { x, y, seq }],
               registry: { url, index, slashed: { amount, currency } } | null }
```

Publishing `secret` is the "confession": anyone can check both shares lie on
one line through it, and every gateway can compute the cheater's pseudonym at
its own site and end those sessions.

## 8. Gateway (`@fuse/gateway`)

Two integration styles over one core:

- `fuseGateway(options)` → Express middleware (mount before your routes);
  protected handlers see `req.fuse = { pseudonym, short, reputation }`.
- `startProxyGateway({ port, host, upstream, ...options })` → reverse proxy in
  front of any HTTP app; forwards `X-Fuse-Pseudonym`, `X-Fuse-Pseudonym-Short`,
  `X-Fuse-Reputation` upstream (and strips client-supplied `X-Fuse-*` headers
  and every `fuse_*` cookie). Public `GET`s are cached (`X-Fuse-Cache: HIT|MISS`).

Options: `{ siteName, origins, protect: [pattern], registries: [url], log, registryHint?, secret?, dataDir?, cookieName?, spec?, cacheTtlSeconds?, reputation?, admin? }`.
Patterns are exact paths or `prefix/*`.

`origins` is required (`startProxyGateway` defaults it to
`http://localhost:<port>`). Each origin is one site id, so it fixes the
pseudonyms a credential can have here: a gateway that accepted any `Host`
would let a banned client mint a new pseudonym per host name. On protected
paths, `/.fuse/redeem` and `/.fuse/challenge`, a request for any other host
gets a `307` redirect to `origins[0]` (GET/HEAD) or
`421 { error: "misdirected-request", origin }`, and never a challenge. A
claimed origin must be listed and must match the `Host` header.

Request handling on a protected path:

1. **Spec gate**: if `spec` is set, reject requests that match no declared
   route (method, path, content type, body size, fields) with
   `400 { error: "request-not-in-spec" }` before any proof work.
2. **Session**: a valid session cookie (default name `fuse_<first 8 hex of siteId>`,
   since cookies are shared across ports) → rate-limit by reputation → pass.
3. **Authorization: Fuse**: check the challenge MAC, expiry and single use;
   check the claimed origin is this site; `verifyFuseToken`; root ∈ registry
   `valid` roots; banned pseudonym → `403 { error: "banned" }`; `POST` to the
   log (`fresh` → continue; `double-spend` → `403 { error: "credential-burned" }`;
   `replay` → 401 with a new challenge). On success, set the session cookie
   and serve the request in the same round trip. Every admitted request
   (first contact or session) carries `Fuse-Pseudonym: anon-…` in the response.
4. **Otherwise** `401` with `WWW-Authenticate`. Browsers (`Accept: text/html`)
   get an interstitial page carrying
   `<meta name="fuse-challenge" content="…">`,
   `<meta name="fuse-registry" content="…">` and
   `<meta name="fuse-network" content="fuse-demo-v1">` for the extension,
   which spends nothing if the network differs; other clients
   get `{ error: "fuse-required", challenge, network, registry, expiresAt, reason? }`
   (`reason` explains a refused proof).

Other outcomes: spec rejections are `400 { error: "request-not-in-spec", reason }`;
an unreachable log or registry gives `503 { error: "log-unavailable" | "registry-unavailable" }`;
a session ended by a ban or a burn answers `403` rather than a new challenge,
so the client doesn't waste a slot; rate limits answer `429`.

Reputation per pseudonym (persisted in `dataDir`): `probation` for the first
24 h, then `member`; bans are sticky. A gateway follows the log's revocations,
computes `pseudonymFor(secret, origin)` for every origin it has accepted
(whether or not that pseudonym was ever seen there), bans it and ends its
sessions.

The proxy cache skips responses with `Vary` or a private `Cache-Control` and
is cleared after any successful write.

Gateway endpoints:

| Method & path | Purpose |
|---|---|
| `GET /.fuse/info` | `{ siteName, origins, protect, registries, log, stats }` |
| `GET /.fuse/challenge` | `{ challenge, network, registry, expiresAt }` |
| `POST /.fuse/redeem` | Verify an `Authorization: Fuse` header, set the session cookie: `{ ok, pseudonym, short, reputation }`. Used by the extension. |
| `GET /.fuse/session` | `{ authenticated, pseudonym?, short?, reputation? }` |
| `POST /.fuse/logout` | End the session |
| `GET /.fuse/admin` | Moderator page: pseudonyms, reputation, ban/unban (demo: no auth) |
| `GET /.fuse/admin/pseudonyms` | `{ pseudonyms: [{ pseudonym, short, firstSeen, lastSeen, firstContacts, requests, reputation, banned, bannedReason? }] }` |
| `POST /.fuse/admin/ban` | `{ pseudonym, banned: boolean, reason? }` |
| `GET /.fuse/events` | SSE: `hello` (with `recent` events), `challenge-issued`, `proof-accepted`, `proof-rejected`, `banned-request`, `pseudonym-banned`, `pseudonym-unbanned`, `revocation-applied`, `spec-rejected`, `rate-limited`, `cache` |

## 9. Agent SDK (`@fuse/agent`)

```js
import { FuseAgent } from '@fuse/agent';
const agent = await FuseAgent.create({ registry: 'http://localhost:4701', tier: 'pro', walletPath, onEvent });
const res = await agent.fetch('http://api.localhost:4720/v1/search?q=fuse'); // answers 401 challenges itself
agent.status();
// { tier, limit, epoch, used, remaining, resetsAt, commitment, registry, index,
//   sites: [{ origin, pseudonym, short, lastUsed, firstContacts }] }
```

- `FuseAgent.load({ walletPath })` reopens a saved wallet. Wallet files are
  mode 0600; a `<wallet>.lock` file serializes slot reservations between
  processes sharing one wallet.
- The Merkle tree always comes from the wallet's own registry; the
  challenge's `registry` hint is ignored.
- Membership is checked before proving; if the credential is gone, the
  reserved slot is returned. Once a proof exists the slot stays spent, even if
  the server then fails.
- One `fetch()` spends at most one slot: a second challenge within the same
  call (a redirect chain, or a site answering a proof with a new challenge)
  throws `FuseAgentError` with code `repeat-challenge` and proves nothing.
  `firstContactCooldownMs` (default 0, off) also refuses a new first contact
  at an origin within that window (`first-contact-cooldown`, with `retryAt`).
- Cookies are kept per origin (scheme, host and port), stricter than browsers,
  so one site never receives another site's session cookie.
- Events (`onEvent(type, data)`): `challenge`, `budget-exhausted`, `proving`,
  `proved`, `rejected`, `session-reused`.
- Errors: `BudgetExhaustedError` (with `resetsAt`), `CredentialBurnedError`,
  `BannedError` (all extend `FuseAgentError`), thrown for first contacts and
  for 403s on session requests.

CLI (`fuse`, wallet at `--wallet`, `$FUSE_WALLET` or `~/.fuse/wallet.json`):

```
fuse init [--registry URL] [--tier starter|pro|fleet]
fuse status | history | pseudonym <origin>   [--json]
fuse fetch <url> [-X METHOD] [-d DATA|@file|@-] [-H 'K: V']... [-i]
```

Exit status: 0 ok, 1 HTTP ≥ 400 or other error, 2 usage, 3 budget exhausted,
4 banned, 5 credential burned.

## 10. Browser extension (`packages/extension`)

1. The content script looks for the interstitial's `fuse-challenge` meta tag.
   If the page sat open for more than 60 s, it fetches a fresh challenge from
   `GET /.fuse/challenge` first.
2. It shows a card in a Shadow DOM: allow once, always for this site, or not
   now. Each request is tagged as a click or an automatic ("Always") spend.
   Automatic spends are re-decided inside the background's serial queue: a
   site that challenges again within 10 minutes gets `needs-consent` and the
   card asks, so a looping or self-reloading site can't drain the budget.
   Requests from a page that has since gone away are dropped (`page-gone`).
3. The background worker takes the origin from the message sender (never from
   the page), reserves and persists a slot (with the spend time, in the same
   write), fetches `GET /tree`, and has an offscreen document generate the
   proof. The wallet lives in `chrome.storage.local` restricted to trusted
   extension contexts (`setAccessLevel`), so content scripts and pages can't
   read the secret; registration refuses to run if that restriction fails.
4. The content script posts the `Authorization: Fuse …` header to
   `POST /.fuse/redeem` (same origin, so the session cookie lands on the site)
   and reloads.

A slot is released only if proving fails before any proof leaves the device.
The offscreen document closes after 2 idle minutes (a warm prover holds about
100–150 MB).

## 11. Explorer (`@fuse/explorer`, port 4700)

`startExplorer({ port, host, registryUrl, logUrl, sites: [{ id, name, url, publicUrl?, mode }], scenarios, links?, reconnect? })`
aggregates the other services server-side, so the page talks to one origin.

| Method & path | Response |
|---|---|
| `GET /api/state` | Snapshot: registry `/info` + `/members`, log `/info` + recent entries + `/revocations`, each site's `/.fuse/info` + pseudonyms (last known data is kept while a source is down) |
| `GET /api/events` | One merged SSE stream; each event is tagged with its `source`, plus `source-status`, `scenario-started`, `scenario-output`, `scenario-finished` (with `runId`). Supports `Last-Event-ID` replay. |
| `GET /api/scenarios` | `{ scenarios: [{ id, title, summary }], current }` |
| `POST /api/scenarios/:id/run` | Starts a listed scenario (404 for unknown ids, 409 while another runs). Scenarios get `ctx = { registryUrl, logUrl, sites, print, tmpDir, signal }`. |
| `GET /install` | Extension and agent SDK setup instructions |

`demo/run.js` exports `startDemo(options)` → `{ urls, internalUrls, dataDir, close() }`
and reads `FUSE_BIND`, `FUSE_DATA_DIR`, `FUSE_PUBLIC_BASE` and the port
variables `FUSE_EXPLORER_PORT`, `FUSE_REGISTRY_PORT`, `FUSE_LOG_PORT`,
`FUSE_FORUM_PORT`, `FUSE_FORUM_UPSTREAM_PORT`, `FUSE_API_PORT`.

## 12. Server-sent events

Every SSE stream uses `event: <type>` and `data: <JSON>`; the JSON always has
`type` and `at`. Streams start with a `hello` event carrying a snapshot.
