// On-disk state of the shared log: append-only JSON Lines files and the
// Ed25519 signing key. With no data directory everything stays in memory.
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** File paths inside a log data directory. */
export function logFiles(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  return {
    entries: join(dataDir, 'entries.jsonl'),
    revocations: join(dataDir, 'revocations.jsonl'),
    key: join(dataDir, 'log-key.pem'),
  };
}

/**
 * Read a JSON Lines file. A final line without its newline can only come from
 * a crash mid-append (the client was never answered), so it is cut off; any
 * other unparseable line is corruption and throws.
 */
export function readJsonLines(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const records = [];
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf('\n', offset);
    if (end === -1) {
      truncateSync(file, Buffer.byteLength(text.slice(0, offset)));
      console.warn(`fuse-log: dropped an unterminated final line in ${file}`);
      break;
    }
    const line = text.slice(offset, end);
    if (line.trim()) {
      try {
        records.push(JSON.parse(line));
      } catch {
        throw new Error(`${file}: line ${records.length + 1} is not valid JSON`);
      }
    }
    offset = end + 1;
  }
  return records;
}

/** Append one line (the caller supplies the serialized JSON). */
export function appendLine(file, line) {
  appendFileSync(file, line + '\n');
}

/** Load the PEM (PKCS#8) Ed25519 key, creating it on first start; ephemeral without a file. */
export function loadOrCreateSigningKey(file) {
  if (file) {
    try {
      return createPrivateKey(readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  if (file) writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  return privateKey;
}
