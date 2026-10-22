#!/usr/bin/env node
// Run the demo scenarios from a terminal against a running demo network:
//   node demo/scenarios/cli.js <id|all|list>
// URLs default to the demo network (registry localhost:4701, log localhost:4702,
// forum.localhost:4710, api.localhost:4720: each site on its own host name);
// override them with FUSE_REGISTRY_URL, FUSE_LOG_URL, FUSE_FORUM_URL and FUSE_API_URL.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { styleText } from 'node:util';
import { releaseProver } from '@fuse/core/node';
import { scenarios } from './index.js';

const env = process.env;
const context = {
  registryUrl: env.FUSE_REGISTRY_URL ?? 'http://localhost:4701',
  logUrl: env.FUSE_LOG_URL ?? 'http://localhost:4702',
  sites: {
    forum: env.FUSE_FORUM_URL ?? 'http://forum.localhost:4710',
    api: env.FUSE_API_URL ?? 'http://api.localhost:4720',
  },
};

const paint = (style, text) => styleText(style, text);
const write = (line = '') => process.stdout.write(line + '\n');
const SYMBOL_STYLES = { '✓': 'green', '✗': 'red', '→': 'cyan', '←': 'cyan' };

function usage() {
  write('Usage: node demo/scenarios/cli.js <id|all|list>');
  write(`Scenarios: ${scenarios.map((s) => s.id).join(', ')}`);
  write('Env: FUSE_REGISTRY_URL, FUSE_LOG_URL, FUSE_FORUM_URL, FUSE_API_URL');
  write(`Defaults: ${context.registryUrl}, ${context.logUrl}, ${context.sites.forum}, ${context.sites.api}`);
}

/** Fail fast with a helpful message when the demo network is not running. */
async function preflight() {
  const checks = [
    ['registry', `${context.registryUrl}/info`],
    ['log', `${context.logUrl}/info`],
    ['forum', `${context.sites.forum}/.fuse/info`],
    ['api', `${context.sites.api}/.fuse/info`],
  ];
  const problems = await Promise.all(
    checks.map(async ([name, url]) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        await res.arrayBuffer();
        return res.ok ? null : `${name} (${url} → ${res.status})`;
      } catch (err) {
        return `${name} (${url}: ${err.cause?.code ?? err.cause?.message ?? err.message})`;
      }
    }),
  );
  const down = problems.filter(Boolean);
  if (down.length) {
    write(paint('red', `✗ demo network not reachable: ${down.join(', ')}`));
    write('  Start it first (npm run demo), or point the FUSE_*_URL variables at it.');
    return false;
  }
  return true;
}

async function runOne(scenario, signal) {
  write();
  write(paint('bold', `━━ ${scenario.id} · ${scenario.title}`));
  write(paint('dim', `   ${scenario.summary}`));
  const started = performance.now();
  const print = (line) => {
    const elapsed = `${((performance.now() - started) / 1000).toFixed(1)}s`.padStart(6);
    const symbol = String(line).trimStart()[0];
    const text = SYMBOL_STYLES[symbol] ? String(line).replace(symbol, paint(SYMBOL_STYLES[symbol], symbol)) : line;
    write(`${paint('dim', elapsed)}  ${text}`);
  };
  const tmpDir = await mkdtemp(join(tmpdir(), `fuse-scenario-${scenario.id}-`));
  try {
    const result = await scenario.run({ ...context, sites: { ...context.sites }, print, tmpDir, signal });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    write(`${paint('green', '✓')} ${scenario.id} finished in ${seconds}s ${paint('dim', JSON.stringify(result))}`);
    return true;
  } catch (err) {
    write(`${paint('red', '✗')} ${scenario.id} failed: ${err?.message ?? err}`);
    if (env.FUSE_DEBUG) write(err?.stack ?? '');
    return false;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function main(arg) {
  if (!arg || arg === '-h' || arg === '--help') {
    usage();
    return arg ? 0 : 2;
  }
  if (arg === 'list') {
    for (const s of scenarios) write(`${s.id.padEnd(14)} ${s.title}: ${s.summary}`);
    return 0;
  }
  const selected = arg === 'all' ? scenarios : scenarios.filter((s) => s.id === arg);
  if (selected.length === 0) {
    write(`unknown scenario "${arg}"`);
    usage();
    return 2;
  }
  if (!(await preflight())) return 1;

  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  let failures = 0;
  for (const scenario of selected) {
    if (abort.signal.aborted) break;
    if (!(await runOne(scenario, abort.signal))) failures++;
  }
  if (selected.length > 1) write(`\n${failures ? paint('red', `✗ ${failures} failed`) : paint('green', `✓ all ${selected.length} scenarios passed`)}`);
  return failures ? 1 : 0;
}

main(process.argv[2]).then(async (code) => {
  await releaseProver();
  process.exitCode = code;
});
