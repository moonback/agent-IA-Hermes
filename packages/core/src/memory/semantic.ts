import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MemoryEntry, MemoryKind } from '../shared/contracts';
import { errorMessage } from '../shared/errors';
import type { HermesStore } from '../persistence/store';
import type { Logger } from '../observability/telemetry';

/**
 * Semantic memory: BM25 keyword ranking (SQLite FTS5) fused with cosine similarity of local
 * sentence embeddings. Embeddings are optional: without them, search is BM25 only and says so.
 */

export interface EmbedderStatus {
  state: 'idle' | 'loading' | 'ready' | 'unavailable';
  model: string;
  reason?: string;
}

export interface Embedder {
  readonly model: string;
  status(): EmbedderStatus;
  /** Unit-length vectors, one per text. Throws when the engine cannot run. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const TRANSFORMERS = '@huggingface/transformers';

interface TransformersModule {
  env: { cacheDir: string; allowRemoteModels: boolean; allowLocalModels: boolean; localModelPath: string };
  pipeline: (
    task: 'feature-extraction',
    model: string,
    opts: { dtype: string },
  ) => Promise<
    (texts: string[], o: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>
  >;
}

/**
 * Local embeddings with Transformers.js (ONNX Runtime), all-MiniLM-L6-v2 (384 dimensions).
 * The engine (~750 MB with its native runtime) is not bundled: it is loaded only if installed in the
 * application or in `<data>/plugins`. The model is downloaded once from Hugging Face into
 * `<data>/models` (or read from `localModelPath`); no text ever leaves the machine.
 */
export class TransformersEmbedder implements Embedder {
  private state: EmbedderStatus;
  private loading: Promise<Awaited<ReturnType<TransformersModule['pipeline']>>> | null = null;
  private retryAt = 0;

  constructor(
    private readonly opts: {
      dataDir: string;
      model?: string;
      allowRemoteModels?: boolean;
      localModelPath?: string;
      logger?: Logger;
    },
  ) {
    this.state = { state: 'idle', model: opts.model ?? DEFAULT_EMBEDDING_MODEL };
  }

  get model(): string {
    return this.state.model;
  }

  status(): EmbedderStatus {
    return { ...this.state };
  }

  private async importModule(): Promise<TransformersModule> {
    const spec: string = TRANSFORMERS;
    try {
      return (await import(spec)) as TransformersModule;
    } catch {
      const plugins = join(this.opts.dataDir, 'plugins');
      if (existsSync(join(plugins, 'node_modules', ...TRANSFORMERS.split('/')))) {
        const resolved = createRequire(join(plugins, 'package.json')).resolve(TRANSFORMERS);
        return (await import(pathToFileURL(resolved).href)) as TransformersModule;
      }
      throw new Error(
        `moteur d'embeddings non installé (${TRANSFORMERS}) : recherche par mots-clés (BM25) uniquement`,
      );
    }
  }

  private load() {
    if (this.loading) return this.loading;
    this.state = { ...this.state, state: 'loading', reason: undefined };
    this.loading = (async () => {
      const mod = await this.importModule();
      const cache = join(this.opts.dataDir, 'models');
      mkdirSync(cache, { recursive: true });
      mod.env.cacheDir = cache;
      mod.env.allowRemoteModels = this.opts.allowRemoteModels ?? true;
      if (this.opts.localModelPath) {
        mod.env.allowLocalModels = true;
        mod.env.localModelPath = this.opts.localModelPath;
      }
      const extractor = await mod.pipeline('feature-extraction', this.model, { dtype: 'fp32' });
      this.state = { state: 'ready', model: this.model };
      this.opts.logger?.log({
        level: 'info',
        category: 'persistence',
        message: `Embeddings locaux prêts (${this.model})`,
      });
      return extractor;
    })().catch((err: unknown) => {
      this.loading = null;
      // A missing engine or an offline first download is retried later, not at every save.
      this.retryAt = Date.now() + 10 * 60_000;
      this.state = { state: 'unavailable', model: this.model, reason: errorMessage(err).slice(0, 300) };
      throw err;
    });
    return this.loading;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.state.state === 'unavailable' && Date.now() < this.retryAt)
      throw new Error(this.state.reason ?? 'embeddings indisponibles');
    const extractor = await this.load();
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    return out.tolist().map((v) => Float32Array.from(v));
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface RankedMemory extends MemoryEntry {
  score: number;
  matchedBy: ('keyword' | 'semantic')[];
  similarity: number | null;
}

/** Reciprocal-rank fusion constant: dampens the weight of the very first ranks. */
const RRF_K = 60;
/** Below this cosine, a vector neighbour is not considered related. */
const MIN_SIMILARITY = 0.25;

export class MemoryIndex {
  private indexing: Promise<number> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: HermesStore,
    private readonly embedder: Embedder | null,
    private readonly logger?: Logger,
  ) {}

  status() {
    const model = this.embedder?.model ?? DEFAULT_EMBEDDING_MODEL;
    return {
      mode: this.embedder?.status().state === 'ready' ? ('hybrid' as const) : ('keyword' as const),
      embedder: this.embedder?.status() ?? { state: 'unavailable' as const, model, reason: 'désactivé' },
      ...this.store.memoryIndexCounts(model),
    };
  }

  /**
   * Hybrid search: BM25 ranks and cosine ranks fused by RRF, then the top-K re-ranked by score.
   * Falls back to BM25 alone (and reports it) when embeddings are unavailable.
   */
  async search(q: { text: string; kind?: MemoryKind; limit?: number }): Promise<RankedMemory[]> {
    const limit = q.limit ?? 8;
    const keyword = this.store.searchMemoryKeyword(q.text, { kind: q.kind, limit: 50 });
    const scores = new Map<string, RankedMemory>();
    const add = (entry: MemoryEntry, rank: number, by: 'keyword' | 'semantic', similarity: number | null) => {
      const cur = scores.get(entry.id) ?? { ...entry, score: 0, matchedBy: [], similarity: null };
      cur.score += 1 / (RRF_K + rank);
      cur.matchedBy.push(by);
      if (similarity !== null) cur.similarity = similarity;
      scores.set(entry.id, cur);
    };
    keyword.forEach((h, i) => add(h.entry, i + 1, 'keyword', null));

    if (this.embedder) {
      try {
        const [qv] = await this.embedder.embed([q.text]);
        const near = this.store
          .memoryVectors(this.embedder.model, q.kind)
          .map((v) => ({ id: v.id, sim: cosine(qv!, v.vector) }))
          .filter((v) => v.sim >= MIN_SIMILARITY)
          .sort((a, b) => b.sim - a.sim)
          .slice(0, 50);
        near.forEach((n, i) => {
          const e = scores.get(n.id) ?? this.store.getMemory(n.id);
          if (e) add(e, i + 1, 'semantic', n.sim);
        });
      } catch (err) {
        this.logger?.log({
          level: 'debug',
          category: 'persistence',
          message: `Recherche mémoire sans embeddings : ${errorMessage(err)}`,
        });
      }
    }
    return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Computes missing vectors in the background (debounced after saves, batched). */
  schedule(delayMs = 500): void {
    if (!this.embedder || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.indexPending().catch(() => undefined);
    }, delayMs);
    this.timer.unref?.();
  }

  async indexPending(max = 512): Promise<number> {
    if (!this.embedder) return 0;
    if (this.indexing) return this.indexing;
    const embedder = this.embedder;
    this.indexing = (async () => {
      let done = 0;
      while (done < max) {
        const batch = this.store.pendingMemoryEmbeddings(embedder.model, 32);
        if (!batch.length) break;
        const vectors = await embedder.embed(batch.map((b) => b.content));
        batch.forEach((b, i) => this.store.setMemoryEmbedding(b.id, vectors[i]!, embedder.model));
        done += batch.length;
      }
      return done;
    })().finally(() => {
      this.indexing = null;
    });
    return this.indexing;
  }
}
