// Runs demo scenarios one at a time and streams what they print as events:
// scenario-started, scenario-output (one per print call), scenario-finished.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

const KEEP_LINES = 400;
const ANSI_ESCAPES = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * scenarios: [{ id, title, summary, run(ctx) }]
 * context: { registryUrl, logUrl, sites: { [id]: url } }, extended per run
 * with print, a fresh tmpDir (removed afterwards) and an AbortSignal that
 * fires when the explorer shuts down.
 */
export function createScenarioRunner({ scenarios, context, publish }) {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const shutdown = new AbortController();
  let current = null;
  let settled = Promise.resolve();

  function snapshot(run) {
    if (!run) return null;
    const { runId, id, title, status, startedAt, finishedAt, durationMs, output, result, error } = run;
    return { runId, id, title, status, startedAt, finishedAt, durationMs, output: [...output], result, error };
  }

  function start(id) {
    const scenario = byId.get(id);
    if (!scenario) return { status: 404, body: { error: 'unknown-scenario', id } };
    if (current?.status === 'running') {
      return { status: 409, body: { error: 'scenario-running', running: { id: current.id, runId: current.runId } } };
    }
    const run = {
      runId: randomUUID(),
      id,
      title: scenario.title,
      status: 'running',
      startedAt: new Date().toISOString(),
      output: [],
    };
    current = run;
    publish({ type: 'scenario-started', at: run.startedAt, source: 'explorer', runId: run.runId, id, title: run.title });
    settled = execute(scenario, run);
    return { status: 202, body: { runId: run.runId, id, title: run.title, startedAt: run.startedAt } };
  }

  async function execute(scenario, run) {
    const started = performance.now();
    const print = (...parts) => {
      if (run.status !== 'running') return;
      const line = parts
        .map((p) => (typeof p === 'string' ? p : inspect(p, { depth: 4, breakLength: 100 })))
        .join(' ')
        .replace(ANSI_ESCAPES, '');
      run.output.push(line);
      if (run.output.length > KEEP_LINES) run.output.shift();
      publish({ type: 'scenario-output', at: new Date().toISOString(), source: 'explorer', runId: run.runId, id: run.id, line });
    };
    let tmpDir;
    let outcome;
    try {
      tmpDir = await mkdtemp(join(tmpdir(), `fuse-scenario-${run.id}-`));
      const ctx = { ...context, sites: { ...context.sites }, print, tmpDir, signal: shutdown.signal };
      outcome = { ok: true, result: jsonSafe(await scenario.run(ctx)) };
    } catch (err) {
      outcome = { ok: false, error: { name: err?.name ?? 'Error', message: err?.message ?? String(err) } };
    }
    // Release the lock before announcing the finish, so a client that reacts
    // to scenario-finished can start the next run straight away.
    Object.assign(run, outcome, {
      status: outcome.ok ? 'finished' : 'failed',
      finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
    });
    publish({
      type: 'scenario-finished',
      at: run.finishedAt,
      source: 'explorer',
      runId: run.runId,
      id: run.id,
      durationMs: run.durationMs,
      ...outcome,
    });
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    list: () => scenarios.map(({ id, title, summary }) => ({ id, title, summary })),
    current: () => snapshot(current),
    start,
    /** Signal the running scenario to stop and wait (bounded) for it to settle. */
    async close({ timeoutMs = 3000 } = {}) {
      shutdown.abort();
      let timer;
      await Promise.race([settled, new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
      clearTimeout(timer);
    },
  };
}

function jsonSafe(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch {
    return String(value);
  }
}
