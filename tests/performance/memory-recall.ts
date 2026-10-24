// Memory search benchmark: legacy LIKE search (HERMES 0.1) vs BM25 (FTS5) vs hybrid BM25 + embeddings.
// Usage: pnpm bench:memory
// Real embeddings need the optional engine: HERMES_TEST_TRANSFORMERS_DIR (node_modules containing
// @huggingface/transformers) and, offline, HERMES_EMBEDDING_MODEL_PATH (local model folder).
import { mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { HermesStore, MemoryIndex, TransformersEmbedder, type MemoryKind } from '@hermes/core';
import { tempDir } from '../helpers/runtime';

interface Fixture {
  memories: { id: string; kind: MemoryKind; content: string }[];
  queries: { q: string; expect: string[]; type: 'lexical' | 'paraphrase' }[];
}

const fx = JSON.parse(
  readFileSync(join(import.meta.dirname, '../fixtures/memory-recall.json'), 'utf8'),
) as Fixture;
const dir = tempDir('hermes-bench-');
const store = new HermesStore(join(dir, 'h.db'));
const toFixture = new Map<string, string>();
for (const m of fx.memories)
  toFixture.set(store.addMemory({ kind: m.kind, content: m.content, origin: 'bench' }).id, m.id);

/** HERMES 0.1 algorithm: words longer than 3 letters, LIKE … OR …, most recent first. */
function legacy(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/\W+/u)
    .filter((w) => w.length > 3)
    .slice(0, 8);
  if (!words.length) return [];
  const rows = store.db
    .prepare(
      `SELECT id FROM memory_entries WHERE ${words.map(() => 'LOWER(content) LIKE ?').join(' OR ')} ORDER BY updated_at DESC, rowid DESC LIMIT 10`,
    )
    .all(...words.map((w) => `%${w}%`)) as { id: string }[];
  return rows.map((r) => r.id);
}

type Searcher = (q: string) => Promise<string[]> | string[];
async function evaluate(name: string, search: Searcher) {
  const by = { lexical: { r3: 0, mrr: 0, n: 0 }, paraphrase: { r3: 0, mrr: 0, n: 0 } };
  for (const q of fx.queries) {
    const ids = (await search(q.q)).map((id) => toFixture.get(id));
    const rank = ids.findIndex((id) => id !== undefined && q.expect.includes(id));
    const s = by[q.type];
    s.n++;
    if (rank >= 0 && rank < 3) s.r3++;
    if (rank >= 0) s.mrr += 1 / (rank + 1);
  }
  const fmt = (s: { r3: number; mrr: number; n: number }) =>
    `${((100 * s.r3) / s.n).toFixed(0).padStart(3)} %  ${(s.mrr / s.n).toFixed(2)}`;
  console.log(`${name.padEnd(28)} | ${fmt(by.lexical)} | ${fmt(by.paraphrase)}`);
}

console.log(
  `${fx.memories.length} souvenirs, ${fx.queries.length} requêtes (10 lexicales, 10 paraphrases)\n`,
);
console.log(`${'Méthode'.padEnd(28)} | lexicales R@3 MRR | paraphrases R@3 MRR`);
console.log('-'.repeat(72));
await evaluate('LIKE (HERMES 0.1)', legacy);
await evaluate('BM25 (FTS5)', (q) => store.searchMemoryKeyword(q, { limit: 10 }).map((h) => h.entry.id));

const engine = process.env.HERMES_TEST_TRANSFORMERS_DIR;
if (engine) {
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  symlinkSync(engine, join(dir, 'plugins', 'node_modules'));
}
const embedder = new TransformersEmbedder({
  dataDir: dir,
  allowRemoteModels: !process.env.HERMES_EMBEDDING_MODEL_PATH,
  localModelPath: process.env.HERMES_EMBEDDING_MODEL_PATH,
  model: process.env.HERMES_EMBEDDING_MODEL,
});
const index = new MemoryIndex(store, embedder);
try {
  await index.indexPending();
  await evaluate(`Hybride BM25 + ${embedder.model.split('/').pop()}`, async (q) =>
    (await index.search({ text: q, limit: 10 })).map((r) => r.id),
  );
} catch (err) {
  console.log(`Hybride : non mesuré — ${err instanceof Error ? err.message : String(err)}`);
}
store.close();
rmSync(dir, { recursive: true, force: true });
