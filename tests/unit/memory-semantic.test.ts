import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HermesStore,
  MemoryIndex,
  TransformersEmbedder,
  cosine,
  ftsQuery,
  type Embedder,
  type EmbedderStatus,
} from '@hermes/core';
import { tempDir } from '../helpers/runtime';

/**
 * Deterministic stand-in for a sentence-embedding model: words are mapped to "concepts", so
 * synonyms share a direction. It proves the hybrid pipeline, not the quality of a real model.
 */
const CONCEPTS: Record<string, number> = {
  voiture: 0,
  automobile: 0,
  véhicule: 0,
  auto: 0,
  facture: 1,
  paiement: 1,
  comptabilité: 1,
  dépenses: 1,
  photo: 2,
  image: 2,
  capture: 2,
  rapport: 3,
  synthèse: 3,
  compte: 3,
};
class ConceptEmbedder implements Embedder {
  readonly model = 'test/concepts';
  calls = 0;
  constructor(private readonly fail = false) {}
  status(): EmbedderStatus {
    return this.fail
      ? { state: 'unavailable', model: this.model, reason: 'moteur absent' }
      : { state: 'ready', model: this.model };
  }
  async embed(texts: string[]) {
    this.calls++;
    if (this.fail) throw new Error('moteur absent');
    return texts.map((t) => {
      const v = new Float32Array(8);
      for (const raw of t.toLowerCase().split(/[^\p{L}]+/u)) {
        const w = raw.replace(/s$/, ''); // naive plural folding
        if (w in CONCEPTS) v[CONCEPTS[w]!]! += 1;
      }
      v[7] = 0.05; // small shared component so no vector is null
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    });
  }
}

let dir = '';
let store: HermesStore | null = null;
const open = () => {
  dir = tempDir();
  return (store = new HermesStore(join(dir, 'h.db')));
};
afterEach(() => {
  store?.close();
  store = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('recherche par mots-clés (BM25, FTS5)', () => {
  it('classe par pertinence, ignore les accents et accepte les préfixes', () => {
    const store = open();
    const a = store.addMemory({
      kind: 'preference',
      content: 'Rapports mensuels en Markdown, en français',
      origin: 'user',
    });
    const b = store.addMemory({
      kind: 'knowledge',
      content: 'Le serveur de build compile les éléments du projet',
      origin: 'user',
    });
    store.addMemory({ kind: 'knowledge', content: 'Sans rapport avec la question', origin: 'user' });
    expect(store.searchMemoryKeyword('rapport markdown')[0]!.entry.id).toBe(a.id);
    expect(store.searchMemoryKeyword('elements')[0]!.entry.id).toBe(b.id);
    expect(store.searchMemoryKeyword('rapport', { kind: 'knowledge' }).map((h) => h.entry.id)).not.toContain(
      a.id,
    );
    expect(store.searchMemoryKeyword('le la les')).toEqual([]);
  });
  it('reste synchronisé (modification, suppression) et invalide le vecteur modifié', () => {
    const store = open();
    const e = store.addMemory({ kind: 'knowledge', content: 'Première version', origin: 'user' });
    store.setMemoryEmbedding(e.id, Float32Array.from([1, 0]), 'm');
    expect(store.pendingMemoryEmbeddings('m')).toHaveLength(0);
    store.updateMemory(e.id, { content: 'Seconde version corrigée' });
    expect(store.searchMemoryKeyword('première')).toHaveLength(0);
    expect(store.searchMemoryKeyword('corrigée')).toHaveLength(1);
    expect(store.pendingMemoryEmbeddings('m').map((p) => p.id)).toEqual([e.id]);
    store.deleteMemory([e.id]);
    expect(store.searchMemoryKeyword('corrigée')).toHaveLength(0);
  });
  it('neutralise la syntaxe FTS dans la requête (pas d’injection ni d’erreur)', () => {
    const store = open();
    store.addMemory({ kind: 'knowledge', content: 'NEAR content OR démo', origin: 'user' });
    expect(ftsQuery('foo" OR content:* NEAR(')).toBe('"foo"* OR "or"* OR "content"* OR "near"*');
    expect(() => store.searchMemoryKeyword('") OR 1=1 --')).not.toThrow();
    expect(store.searchMemory({ text: 'démo' })).toHaveLength(1);
  });
});

describe('index hybride (BM25 + embeddings)', () => {
  it('retrouve un souvenir par le sens même sans mot commun, et fusionne les deux classements', async () => {
    const store = open();
    const emb = new ConceptEmbedder();
    const index = new MemoryIndex(store, emb);
    const car = store.addMemory({
      kind: 'knowledge',
      content: 'Entretien de la voiture prévu en mars',
      origin: 'user',
    });
    const bill = store.addMemory({
      kind: 'knowledge',
      content: 'Les factures sont rangées par année',
      origin: 'user',
    });
    store.addMemory({ kind: 'knowledge', content: 'Photo de vacances à la montagne', origin: 'user' });
    expect(await index.indexPending()).toBe(3);
    expect(store.pendingMemoryEmbeddings(emb.model)).toHaveLength(0);

    // No shared word with "voiture": only the semantic channel finds it.
    const r1 = await index.search({ text: 'automobile', limit: 3 });
    expect(r1[0]).toMatchObject({ id: car.id, matchedBy: ['semantic'] });
    expect(r1[0]!.similarity).toBeGreaterThan(0.9);

    // Both channels agree: it ranks first with both reasons.
    const r2 = await index.search({ text: 'factures paiement', limit: 3 });
    expect(r2[0]!.id).toBe(bill.id);
    expect(r2[0]!.matchedBy).toEqual(['keyword', 'semantic']);
    expect(index.status()).toMatchObject({ mode: 'hybrid', total: 3, embedded: 3 });
  });
  it('se replie sur BM25 et le signale quand le moteur d’embeddings est indisponible', async () => {
    const store = open();
    const index = new MemoryIndex(store, new ConceptEmbedder(true));
    const car = store.addMemory({ kind: 'knowledge', content: 'Entretien de la voiture', origin: 'user' });
    expect(await index.search({ text: 'automobile' })).toEqual([]);
    expect((await index.search({ text: 'voiture' }))[0]).toMatchObject({
      id: car.id,
      matchedBy: ['keyword'],
    });
    expect(index.status().mode).toBe('keyword');
    await expect(index.indexPending()).rejects.toThrow('moteur absent');
  });
  it('cosinus : vecteurs identiques, orthogonaux, dimensions différentes', () => {
    expect(cosine(Float32Array.from([1, 2]), Float32Array.from([2, 4]))).toBeCloseTo(1);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0);
    expect(cosine(Float32Array.from([1]), Float32Array.from([1, 0]))).toBe(0);
  });
  it('moteur Transformers.js absent : indisponible avec une raison explicite', async () => {
    const d = tempDir();
    const e = new TransformersEmbedder({ dataDir: d, allowRemoteModels: false });
    await expect(e.embed(['x'])).rejects.toThrow(/non installé/);
    expect(e.status()).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/BM25/) });
    rmSync(d, { recursive: true, force: true });
  });
});

// Real engine, opt-in: HERMES_TEST_TRANSFORMERS_DIR = a node_modules folder containing
// @huggingface/transformers, HERMES_EMBEDDING_MODEL_PATH = local model folder (no download).
const engineDir = process.env.HERMES_TEST_TRANSFORMERS_DIR;
describe.runIf(Boolean(engineDir && process.env.HERMES_EMBEDDING_MODEL_PATH))(
  'moteur réel all-MiniLM-L6-v2',
  () => {
    it('calcule des vecteurs de 384 dimensions et rapproche deux paraphrases', async () => {
      const d = tempDir();
      mkdirSync(join(d, 'plugins'), { recursive: true });
      symlinkSync(engineDir!, join(d, 'plugins', 'node_modules'));
      const e = new TransformersEmbedder({
        dataDir: d,
        allowRemoteModels: false,
        localModelPath: process.env.HERMES_EMBEDDING_MODEL_PATH,
      });
      const [a, b, c] = await e.embed([
        'A cat sleeps on the couch',
        'A kitten is napping on the sofa',
        'Quarterly financial report',
      ]);
      expect(a).toHaveLength(384);
      expect(cosine(a!, b!)).toBeGreaterThan(0.6);
      expect(cosine(a!, c!)).toBeLessThan(0.2);
      expect(e.status().state).toBe('ready');
      rmSync(d, { recursive: true, force: true });
    }, 60_000);
  },
);
