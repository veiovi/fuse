// Wallet persistence. The wallet file holds the credential secret, so it is
// written with mode 0600 and replaced atomically (temp file + rename). A lock
// file serialises read-merge-write cycles between processes sharing a wallet,
// so they can never hand out the same slot twice. Without a path the wallet
// lives in memory only.
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 10_000;
// A lock is held for one read and one write; anything older is left over from a crash.
const LOCK_STALE_MS = 30_000;

/**
 * Union another copy's slot reservations into `wallet.spent`. Refuses to mix
 * two different credentials.
 */
export function mergeSpent(wallet, other) {
  if (other.commitment !== wallet.commitment) {
    throw new Error('the wallet file now holds a different credential; refusing to overwrite it');
  }
  wallet.spent ??= {};
  for (const [epoch, slots] of Object.entries(other.spent ?? {})) {
    const merged = new Set([...(wallet.spent[epoch] ?? []), ...slots]);
    wallet.spent[epoch] = [...merged].sort((a, b) => a - b);
  }
}

export class WalletStore {
  #queue = Promise.resolve();

  /** @param {string|null} [path] wallet file; omit to keep the wallet in memory only */
  constructor(path) {
    this.path = path ? resolve(path) : null;
  }

  get persistent() {
    return this.path !== null;
  }

  async exists() {
    if (!this.path) return false;
    try {
      await stat(this.path);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  /** The wallet currently on disk, or null when there is none. */
  async read() {
    if (!this.path) return null;
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`wallet file is not valid JSON: ${this.path}`);
    }
  }

  /**
   * Apply `change(wallet)` to the in-memory wallet and persist the result,
   * under the lock. Slots that another process reserved on disk are merged in
   * first, so a change such as allocateSlot sees every slot already spent.
   * @returns the value `change` returned
   */
  async commit(wallet, change = () => undefined) {
    if (!this.path) return change(wallet);
    return this.#serialised(() =>
      this.#withFileLock(async () => {
        const onDisk = await this.read();
        if (onDisk) mergeSpent(wallet, onDisk);
        const result = change(wallet);
        await this.#writeAtomic(wallet);
        return result;
      }),
    );
  }

  #serialised(task) {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #withFileLock(task) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let handle;
    while (!handle) {
      try {
        handle = await open(lockPath, 'wx', 0o600);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        if (await isStale(lockPath)) {
          await unlink(lockPath).catch(() => {});
        } else if (Date.now() > deadline) {
          throw new Error(`wallet is locked by another process (${lockPath})`);
        } else {
          await sleep(LOCK_RETRY_MS);
        }
      }
    }
    try {
      await handle.writeFile(`${process.pid}\n`);
      return await task();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => {});
    }
  }

  async #writeAtomic(wallet) {
    const dir = dirname(this.path);
    const temp = join(dir, `.${basename(this.path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(wallet, null, 2) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, this.path);
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    }
  }
}

async function isStale(lockPath) {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false; // vanished meanwhile: just retry
  }
}
