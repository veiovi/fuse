// Shared helpers for the demo scenarios: narration of agent events, request
// steps, short display forms, and checks that fail a scenario loudly when the
// network does not behave the way the story says.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseFuseHeader, toField } from '@fuse/core';

/** Friendly site name ("forum", "api") for an origin, else the origin itself. */
export function siteName(ctx, origin) {
  for (const [name, url] of Object.entries(ctx.sites)) if (new URL(url).origin === origin) return name;
  return origin;
}

/** A fresh wallet file in ctx.tmpDir, or undefined (in-memory wallet) without one. */
export function walletPath(ctx, label) {
  return ctx.tmpDir ? join(ctx.tmpDir, `${label}-${randomBytes(4).toString('hex')}.json`) : undefined;
}

/** onEvent handler that narrates an agent's first contacts, indented under the request line. */
export function narrate(ctx) {
  return (event) => {
    const site = siteName(ctx, event.origin);
    switch (event.type) {
      case 'challenge':
        return ctx.print(`    401 Fuse challenge from ${site}`);
      case 'proving':
        return ctx.print(`    spending slot ${event.slot} · ${event.remaining}/${event.limit} left today · proving…`);
      case 'proved':
        return ctx.print(`    ✓ proof accepted (${event.provingMs} ms) · ${site} knows you as ${event.short}`);
      case 'session-reused':
        return ctx.print(`    ↻ session cookie · no slot spent`);
      case 'rejected':
        if (event.reason === 'not-a-member') return ctx.print('    ✗ not in the registry tree any more · nothing sent');
        if (event.slot === null) return ctx.print(`    ✗ not answered (${event.reason}) · no slot spent`);
        return ctx.print(`    ✗ ${site} refused the proof: ${event.reason}`);
      case 'budget-exhausted':
        return ctx.print('    ✗ no slot left today · refused locally, nothing sent');
    }
  };
}

/** One request through the agent: a "→" line, the agent's narration, a "←" line. */
export async function step(ctx, agent, url, init = {}) {
  const target = new URL(url);
  ctx.print(`→ ${init.method ?? 'GET'} ${siteName(ctx, target.origin)} ${target.pathname}${target.search}`);
  const res = await agent.fetch(target, {
    ...init,
    headers: { accept: 'application/json', ...init.headers },
    signal: ctx.signal,
  });
  const body = await readBody(res);
  const seenAs = res.headers.get('fuse-pseudonym');
  ctx.print(`← ${res.status} ${res.statusText}${seenAs ? ` · served to ${seenAs}` : ''}`);
  return { res, body, seenAs };
}

/** A fresh challenge from a protected URL, asked for without cookies, the way any client would. */
export async function challengeFor(url, signal) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal });
  await res.arrayBuffer();
  const params = parseFuseHeader(res.headers.get('www-authenticate'));
  expect(res.status === 401 && params?.challenge, `expected a Fuse challenge from ${url}, got ${res.status}`);
  return params.challenge;
}

export async function getJson(url, signal) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal });
  const body = await res.json().catch(() => null);
  expect(res.ok && body, `GET ${url} answered ${res.status}`);
  return body;
}

export async function postJson(url, payload, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await res.json().catch(() => null);
  expect(res.ok, `POST ${url} answered ${res.status}${body?.error ? ` ${body.error}` : ''}`);
  return body;
}

/** Poll `check` until it returns a truthy value (returned) or the timeout passes (throws). */
export async function waitFor(check, { timeoutMs = 6000, intervalMs = 200, signal, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs, undefined, { signal });
  }
}

/** Throw when the network does not behave as the scenario claims. */
export function expect(condition, message) {
  if (!condition) throw new Error(`unexpected: ${message}`);
}

/** Same field element, whatever the hex padding. */
export function sameField(a, b) {
  try {
    return toField(a) === toField(b);
  } catch {
    return false;
  }
}

/** 0x1a2b3c4d… */
export const shortHex = (hex) => `${String(hex).slice(0, 10)}…`;

export const formatNumber = (n) => n.toLocaleString('en-US');

async function readBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
