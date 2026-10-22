// Crash-safe JSON state files: write a temp file, fsync it, then rename it
// over the old one, so a reader never sees a half-written registry.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';

/** Atomically replace `file` with `value` serialized as JSON. */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, 'w', 0o644);
    try {
      writeSync(fd, JSON.stringify(value, null, 2) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Parsed JSON from `file`, or null if it does not exist. */
export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
