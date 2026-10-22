# Running and showing the demo

## Start everything

```bash
npm install
npm run demo            # add -- --reset to start from empty data
```

One process starts five services:

| URL | What it is |
|---|---|
| http://localhost:4700 | **Explorer**: live view of the registry, the shared log, burned keys and both sites, plus the scenario runner |
| http://localhost:4701 | Registry (simulated deposits; the extension and SDK register here) |
| http://localhost:4702 | Shared log of slot tags and revocations |
| http://forum.localhost:4710 | **Acme Forum**, a normal web app behind the Fuse gateway in reverse-proxy mode |
| http://api.localhost:4720 | **Bolt API**, an Express API with the Fuse gateway as middleware |

Data lives in `.data/` and survives restarts.

The two sites use their own host names because browsers share cookies across
ports on one host. Browsers and Node resolve `*.localhost` to your machine on
most systems; if yours doesn't, add `127.0.0.1 forum.localhost api.localhost`
to `/etc/hosts`.

## The four scenarios

Run them from the explorer (one button each) or from a terminal:

```bash
node demo/scenarios/cli.js honest-agent   # or scanner | cheater | ban-sticks | all
```

1. **Honest agent.** An AI agent with a `pro` credential (200 slots a day)
   calls the forum and the API. Each first contact costs one slot; repeat
   calls ride the session for free. The two sites see two unrelated pseudonyms.
2. **Scanner.** A `starter` credential (10 slots a day) behaves like a mass
   scanner: no sessions, every request a first contact. Ten succeed, then the
   budget is gone. At 200 slots per backing, probing a million servers a day
   needs 5,000 deposits.
3. **Cheater.** A client deliberately spends one slot twice, at two different
   challenges. The second share lands on the log, the log draws the line,
   recovers the key, the registry burns the deposit, and the gateway that had
   an open session for that key ends it. The burned key appears in the
   explorer with both points plotted on its line.
4. **Ban sticks.** The forum's moderator bans an agent's pseudonym. The agent
   drops its cookies and proves again with a fresh slot, and gets the same
   pseudonym, so the ban holds. The forum never learned who it banned.

## As a person, with the Chrome extension

```bash
npm run build:extension
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked**, choose `packages/extension/dist`.
2. Open the Fuse popup and choose **Get a credential** (registry
   `http://localhost:4701`, tier `starter`).
3. Visit http://forum.localhost:4710 and read a thread: public pages cost nothing.
4. Click **New post** (`/new`). The forum answers with a Fuse challenge; the
   extension asks whether to spend 1 of your 10 slots. Allow it. The proof is
   generated in the browser, the page reloads, and you are posting as
   `anon-…`.
5. Visit http://api.localhost:4720 and call a protected endpoint: a second slot,
   and a different pseudonym.
6. The popup's spend log lists both first contacts. The explorer shows two new
   random-looking tags on the shared log.

## As an agent, with the SDK

```bash
npx fuse init --tier pro                   # deposit at the registry, wallet in ~/.fuse/wallet.json
npx fuse fetch "http://api.localhost:4720/v1/search?q=hello"
npx fuse status                            # slots left today, pseudonym per site
```

In code:

```js
import { FuseAgent } from '@fuse/agent';
const agent = await FuseAgent.create({ registry: 'http://localhost:4701', tier: 'pro' });
const res = await agent.fetch('http://api.localhost:4720/v1/search?q=hello'); // answers the 401 itself
```

## Explaining it in six steps

1. Servers ask "who is this?", and that question drags in identity, IP
   reputation and CAPTCHAs. Fuse lets them ask "has this client used up its
   budget?" instead.
2. Back it once: a deposit (later a passport or an EU wallet) buys a
   credential. The registry never learns where you use it.
3. Spend a daily budget: each first contact with a protected endpoint costs
   one slot, anywhere on the web. Reading public pages stays free.
4. Each slot is a point on a secret line. One point reveals nothing. Use a slot
   twice and the two points reveal your key, which burns your credential.
   (Show the cheater scenario and the line in the explorer.)
5. Each site sees its own pseudonym for you: bans stick, but no two sites can
   link you. (Show ban-sticks.)
6. It is all ordinary HTTP headers plus a 389-byte zero-knowledge proof
   generated on the device. A site can switch it on one endpoint at a time.
   (Show the extension asking before it spends a slot.)
