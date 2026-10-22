#!/usr/bin/env node
// fuse: command-line front end to the agent SDK. Narration goes to stderr so
// `fuse fetch` can be piped like curl.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { normalizeOrigin, shortPseudonym } from '@fuse/core';
import { releaseProver } from '@fuse/core/node';
import { BannedError, BudgetExhaustedError, CredentialBurnedError, FuseAgent } from './index.js';

const USAGE = `fuse: spend a daily slot instead of an identity

Usage
  fuse init [--registry URL] [--tier starter|pro|fleet]
                         lock a demo deposit and create a credential
  fuse status            today's budget and the sites that know you
  fuse fetch <url> [-X METHOD] [-d DATA] [-H 'K: V']... [-i]
                         HTTP request that answers Fuse challenges itself
  fuse pseudonym <origin>
                         the pseudonym <origin> sees (computed locally)
  fuse history           first contacts: slot, proving time, pseudonym, status

Options
  --wallet PATH   wallet file (default: $FUSE_WALLET, else ~/.fuse/wallet.json)
  --registry URL  for init (default: $FUSE_REGISTRY_URL, else http://localhost:4701)
  --json          machine-readable output for status, history and pseudonym
  -h, --help      show this help

fetch: -d implies POST (form-encoded unless -H sets Content-Type); -d @file
reads a file and -d @- reads stdin. The body goes to stdout, narration to
stderr; -i also prints the status line and headers.

Exit status: 0 ok, 1 HTTP status >= 400 or other error, 2 usage,
3 budget exhausted, 4 banned, 5 credential burned.`;

const OPTIONS = {
  wallet: { type: 'string' },
  registry: { type: 'string' },
  tier: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  request: { type: 'string', short: 'X' },
  data: { type: 'string', short: 'd' },
  header: { type: 'string', short: 'H', multiple: true },
  include: { type: 'boolean', short: 'i' },
};

const EXIT = { ok: 0, failed: 1, usage: 2, budget: 3, banned: 4, burned: 5 };

class UsageError extends Error {}

const paint = (style, text) => styleText(style, text, { stream: process.stderr });
const say = (line = '') => process.stderr.write(line + '\n');
const out = (line = '') => process.stdout.write(line + '\n');

const commands = {
  async init({ values, walletPath }) {
    // The registry owns the tier list (demo: starter, pro, fleet) and rejects unknown ones.
    const tier = values.tier ?? 'pro';
    const registry = values.registry ?? process.env.FUSE_REGISTRY_URL ?? 'http://localhost:4701';
    const agent = await FuseAgent.create({ registry, tier, walletPath });
    const { wallet } = agent;
    const s = agent.status();
    say(`${paint('green', '✓')} new ${s.tier} credential · ${s.limit} slots/day`);
    if (wallet.deposit) {
      say(`  deposit     ${wallet.deposit.amount} ${wallet.deposit.currency} ${wallet.deposit.status} (${wallet.deposit.id})`);
    }
    say(`  member      #${s.index} at ${s.registry}`);
    say(`  commitment  ${shortHex(s.commitment)}`);
    say(`  wallet      ${tildify(agent.walletPath)} (mode 0600; keep it private)`);
    return EXIT.ok;
  },

  async status({ values, walletPath }) {
    const agent = await FuseAgent.load({ walletPath });
    const s = agent.status();
    if (values.json) return outJson(s);
    out(`${s.tier} credential · member #${s.index} at ${s.registry}`);
    out(`today   ${s.used}/${s.limit} slots used · ${s.remaining} left · resets in ${duration(Date.parse(s.resetsAt) - Date.now())}`);
    out(`sites   ${s.sites.length === 0 ? 'none yet' : s.sites.length}`);
    for (const site of s.sites) {
      const contacts = `${site.firstContacts} first contact${site.firstContacts === 1 ? '' : 's'}`;
      out(`  ${site.short}  ${site.origin}  ${contacts} · last used ${duration(Date.now() - Date.parse(site.lastUsed))} ago`);
    }
    return EXIT.ok;
  },

  async fetch({ values, positionals, walletPath }) {
    const [url] = positionals;
    if (!url) throw new UsageError('fetch needs a URL');
    const headers = new Headers();
    for (const header of values.header ?? []) {
      const colon = header.indexOf(':');
      if (colon <= 0) throw new UsageError(`bad header (want 'Name: value'): ${header}`);
      headers.append(header.slice(0, colon).trim(), header.slice(colon + 1).trim());
    }
    const body = await readData(values.data);
    if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
    const method = (values.request ?? (body === undefined ? 'GET' : 'POST')).toUpperCase();

    const agent = await FuseAgent.load({ walletPath, onEvent: narrate });
    say(`${paint('cyan', '→')} ${method} ${url}`);
    const res = await agent.fetch(url, { method, headers, body });
    const bytes = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type')?.split(';')[0] ?? 'no content type';
    const color = res.status >= 400 ? 'red' : 'green';
    say(`${paint(color, '←')} ${res.status} ${res.statusText} · ${size(bytes.length)} ${type}`);

    if (values.include) {
      out(`HTTP/1.1 ${res.status} ${res.statusText}`);
      for (const [name, value] of res.headers) out(`${name}: ${value}`);
      out();
    }
    process.stdout.write(bytes);
    if (process.stdout.isTTY && bytes.length && bytes.at(-1) !== 0x0a) out();
    return res.status >= 400 ? EXIT.failed : EXIT.ok;
  },

  async pseudonym({ values, positionals, walletPath }) {
    const [target] = positionals;
    if (!target) throw new UsageError('pseudonym needs an origin, e.g. http://localhost:4710');
    let origin;
    try {
      origin = normalizeOrigin(target);
    } catch {
      throw new UsageError(`not an http(s) origin: ${target}`);
    }
    const agent = await FuseAgent.load({ walletPath });
    const pseudonym = agent.pseudonymFor(origin);
    const short = shortPseudonym(pseudonym);
    if (values.json) return outJson({ origin, pseudonym, short });
    out(`${short}  ${origin}`);
    out(pseudonym);
    say(paint('dim', 'Only this origin sees this value; every other site sees an unrelated one.'));
    return EXIT.ok;
  },

  async history({ values, walletPath }) {
    const agent = await FuseAgent.load({ walletPath });
    const entries = agent.history;
    if (values.json) return outJson(entries);
    if (entries.length === 0) {
      out('no first contacts yet');
      return EXIT.ok;
    }
    const shown = entries.slice(-20);
    const width = Math.max(...shown.map((e) => e.origin.length));
    out(['when    ', 'site'.padEnd(width), 'slot', ' proof ', 'status', 'pseudonym'].join('  '));
    for (const e of shown) {
      out(
        [
          new Date(e.at).toTimeString().slice(0, 8),
          e.origin.padEnd(width),
          String(e.slot).padStart(4),
          `${e.provingMs} ms`.padStart(7),
          String(e.status).padEnd(6),
          shortPseudonym(e.pseudonym),
        ].join('  '),
      );
    }
    if (entries.length > shown.length) out(`(${entries.length - shown.length} earlier; --json shows all)`);
    return EXIT.ok;
  },
};

function narrate(event) {
  switch (event.type) {
    case 'challenge':
      say(`  401 Fuse challenge from ${event.origin}`);
      break;
    case 'proving':
      say(`  spending slot ${event.slot} · ${event.remaining} of ${event.limit} left today · proving…`);
      break;
    case 'proved':
      say(`  ${paint('green', '✓')} proved in ${event.provingMs} ms · this site knows you as ${paint('bold', event.short)}`);
      break;
    case 'session-reused':
      say(`  ↻ session cookie reused · no slot spent (${event.short})`);
      break;
    case 'rejected':
      if (event.reason === 'not-a-member') say('  this credential is no longer in the registry tree · nothing sent');
      else if (event.slot === null) say(`  ${paint('red', '✗')} not answered (${event.reason}) · no slot spent`);
      else say(`  ${paint('red', '✗')} proof refused: ${event.reason} · slot ${event.slot} is spent`);
      break;
    // budget-exhausted is reported from the thrown error
  }
}

async function readData(data) {
  if (data === undefined) return undefined;
  if (data === '@-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  return data.startsWith('@') ? readFile(data.slice(1)) : data;
}

function outJson(value) {
  out(JSON.stringify(value, null, 2));
  return EXIT.ok;
}

function report(err) {
  if (err instanceof UsageError) {
    say(`${paint('red', 'usage:')} ${err.message}\nRun "fuse --help" for usage.`);
    return EXIT.usage;
  }
  if (err instanceof BudgetExhaustedError) {
    say(`${paint('red', '✗')} budget exhausted: all ${err.limit} slots of today are spent; nothing was sent`);
    say(`  resets in ${duration(Date.parse(err.resetsAt) - Date.now())} (${err.resetsAt})`);
    return EXIT.budget;
  }
  if (err instanceof BannedError) {
    say(`${paint('red', '✗')} banned at ${err.origin} as ${shortPseudonym(err.pseudonym)}${err.reason ? ` (${err.reason})` : ''}`);
    say('  proving again would not help: this credential always shows that site the same pseudonym');
    return EXIT.banned;
  }
  if (err instanceof CredentialBurnedError) {
    say(`${paint('red', '✗')} ${err.message}`);
    return EXIT.burned;
  }
  if (err?.code === 'no-wallet') {
    say(`${paint('red', '✗')} ${err.message}; run "fuse init" first (or pass --wallet / set FUSE_WALLET)`);
    return EXIT.failed;
  }
  const cause = err?.cause?.code ?? err?.cause?.message;
  say(`${paint('red', '✗')} ${err?.message ?? err}${cause ? ` (${cause})` : ''}`);
  return EXIT.failed;
}

function shortHex(hex) {
  return `${hex.slice(0, 10)}…${hex.slice(-4)}`;
}

function tildify(path) {
  const home = homedir();
  return path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}

function size(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    (command || values.help ? out : say)(USAGE);
    return command || values.help ? EXIT.ok : EXIT.usage;
  }
  if (!Object.hasOwn(commands, command)) throw new UsageError(`unknown command "${command}"`);
  const walletPath = values.wallet ?? process.env.FUSE_WALLET ?? join(homedir(), '.fuse', 'wallet.json');
  return commands[command]({ values, positionals: rest, walletPath });
}

main(process.argv.slice(2))
  .catch(report)
  .then(async (code) => {
    await releaseProver();
    process.exitCode = code;
  });
