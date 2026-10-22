// Bolt API's "product": keyword search over a small built-in corpus and an
// extractive summarizer. Deliberately simple and deterministic.

const CORPUS = [
  ['rln', 'Rate-limiting nullifiers', 'RLN lets a member of a group send a limited number of messages per epoch anonymously. Each message carries a share of a secret line; a second message in the same slot reveals the key. Waku uses RLN for spam protection in peer-to-peer messaging.'],
  ['pseudonyms', 'Per-site pseudonyms', 'Fuse derives a pseudonym as Poseidon(key, siteId). The same site always sees the same pseudonym, so bans stick, while different sites see unrelated values and cannot link a visitor across the web.'],
  ['budget', 'Daily budgets instead of identity', 'Servers stop asking who a client is and ask whether it has used up its budget. Each credential gets a fixed number of first-contact slots per day across the whole network; public pages stay free.'],
  ['deposit', 'Backing a credential with a deposit', 'A credential is backed once by something scarce, such as a deposit at a registry. Burning a credential forfeits the deposit, so evading a ban costs real money rather than a fresh IP address.'],
  ['groth16', 'Groth16 zero-knowledge proofs', 'Groth16 produces short proofs that verify in milliseconds. Fuse proves Merkle membership, a slot range check and the share, pseudonym and slot tag computations in about six thousand constraints.'],
  ['poseidon', 'The Poseidon hash', 'Poseidon is a hash function designed to be cheap inside arithmetic circuits. Fuse uses it for identity commitments, Merkle trees, slopes, slot tags and pseudonyms.'],
  ['merkle', 'Merkle membership without revealing the member', 'The registry publishes a Merkle tree of credential commitments. Clients download every leaf and compute their own path so the registry never learns who is about to spend a slot.'],
  ['log', 'The shared append-only log', 'Gateways forward each accepted first contact to a shared log of slot tags. A new tag is appended; the same tag with a different share is a double-spend, and the log recovers the key and publishes a revocation.'],
  ['sessions', 'Sessions after the first contact', 'Only the first contact with a site costs a slot. After that the gateway issues an ordinary HttpOnly session cookie, so proving stays rare and fast pages stay fast.'],
  ['spec-gate', 'The spec gate', 'Before any proof work, the gateway checks method, path, query, content type, body size and fields against the routes a site declared. Requests outside the spec never reach the application.'],
  ['agents', 'Fuse for AI agents', 'An agent holds its own credential and answers 401 challenges automatically. Its daily budget caps how many sites it can touch, which makes mass scanning expensive without blocking honest automation.'],
  ['epochs', 'Epochs and clock skew', 'A budget epoch is one UTC day. Verifiers accept the neighbouring epoch for five minutes around midnight to absorb clock skew between clients and servers.'],
].map(([id, title, body]) => ({ id, title, body }));

const STOPWORDS = new Set(
  'a an and are as at be but by can do for from has have how i if in into is it its of on or so such than that the their them then there these they this to was we were what when which who why will with you your'.split(' '),
);

const words = (text) => (String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOPWORDS.has(w));

const documentFrequency = new Map();
for (const doc of CORPUS) for (const w of new Set(words(`${doc.title} ${doc.body}`))) documentFrequency.set(w, (documentFrequency.get(w) ?? 0) + 1);

/**
 * Rank corpus documents for a query (title matches weigh triple).
 * @returns {{ id: string, title: string, snippet: string, score: number }[]}
 */
export function search(query, limit = 5) {
  const terms = [...new Set(words(query))];
  if (terms.length === 0) return [];
  const results = [];
  for (const doc of CORPUS) {
    const title = words(doc.title);
    const body = words(doc.body);
    let score = 0;
    for (const term of terms) {
      const tf = 3 * title.filter((w) => w.startsWith(term)).length + body.filter((w) => w.startsWith(term)).length;
      if (tf) score += tf * Math.log(1 + CORPUS.length / (documentFrequency.get(term) ?? 1));
    }
    if (score > 0) results.push({ id: doc.id, title: doc.title, snippet: snippet(doc.body, terms), score: Math.round(score * 100) / 100 });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

function snippet(body, terms) {
  const sentences = body.split(/(?<=[.!?])\s+/);
  const hit = sentences.find((s) => terms.some((t) => s.toLowerCase().includes(t))) ?? sentences[0];
  return hit.length > 180 ? `${hit.slice(0, 177)}…` : hit;
}

/**
 * Extractive summary: the `count` highest-scoring sentences, in their original order.
 * @returns {{ summary: string, sentences: string[], inputSentences: number, inputWords: number }}
 */
export function summarize(text, count = 2) {
  const sentences = String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“'])/)
    .filter(Boolean);
  const frequency = new Map();
  for (const w of words(text)) frequency.set(w, (frequency.get(w) ?? 0) + 1);
  const scored = sentences.map((sentence, index) => {
    const ws = words(sentence);
    const score = ws.reduce((sum, w) => sum + (frequency.get(w) ?? 0), 0) / Math.sqrt(ws.length || 1);
    return { sentence, index, score };
  });
  const chosen = [...scored]
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.sentence);
  return {
    summary: chosen.join(' '),
    sentences: chosen,
    inputSentences: sentences.length,
    inputWords: (String(text).match(/\S+/g) ?? []).length,
  };
}
