import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  EXECUTOR_AGENTS,
  MODEL_ROLES,
  MissionBudget,
  type ExecutorAgentId,
  type ModelRole,
} from './shared/contracts';
import { HermesError, errorMessage } from './shared/errors';
import { HermesStore } from './persistence/store';
import { Logger, Telemetry } from './observability/telemetry';
import { KeyringSecretStore, LayeredSecretStore, type SecretStore } from './secrets/vault';
import { OpenRouterProvider } from './model-providers/openrouter';
import { GEMINI_DEFAULT_BASE_URL, GEMINI_LIVE_DEFAULT_URL, GeminiProvider } from './model-providers/gemini';
import { GeminiLiveProvider, type WebSocketFactory } from './model-providers/gemini-live';
import { AudioBridge, type VoiceSink } from './voice/audio-bridge';
import { VoiceAgent } from './voice/voice-agent';
import { DEFAULT_LIVE_MODEL, VoiceSettings } from './voice/catalog';
import { MemoryIndex, TransformersEmbedder, type Embedder } from './memory/semantic';
import type { ModelInfo, ModelProvider } from './model-providers/types';
import { PolicyConfig } from './policy-engine/policy';
import { canonicalize } from './policy-engine/paths';
import { createToolRegistry } from './tools/registry';
import { ToolExecutor } from './tools/executor';
import { ApprovalBroker } from './tools/approvals';
import { PlaywrightBrowserService, type BrowserService } from './tools/browser';
import { PowerShellUiaAdapter, UnavailableDesktopAdapter, type DesktopAdapter } from './tools/desktop';
import { OpenRouterWebSearchProvider, type SearchProvider } from './tools/web-search';
import {
  BRAVE_KEY_NAME,
  BraveSearchProvider,
  SearchProviderRegistry,
  SearchSettings,
  TAVILY_KEY_NAME,
  TavilySearchProvider,
} from './tools/search-providers';
import { killAllProcesses } from './tools/process';
import { SandboxSettings, jobRunnerPath } from './tools/sandbox';
import type { ToolServices } from './tools/types';
import { LlmGateway, ProviderSettings, type ModelAssignment } from './agents/llm-gateway';
import { Planner } from './agents/planner';
import { Verifier } from './agents/verifier';
import { ToolLoopAgent, type Agent } from './agents/tool-agent';
import { Orchestrator } from './orchestrator/orchestrator';
import { Scheduler } from './scheduler/scheduler';
import { ProactiveSettings } from './scheduler/triggers';
import { DesktopNotifier, type Notifier } from './notifications/notifier';

export const API_KEY_NAME = 'OPENROUTER_API_KEY';
/** Vault entry of the Google key; GOOGLE_API_KEY in the environment is also accepted (development). */
export const GEMINI_KEY_NAME = 'GEMINI_API_KEY';

export const PROVIDER_KINDS = ['openrouter', 'gemini', 'gemini-live'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
/** Text roles are served by OpenRouter or Gemini; the voice role always by Gemini Live. */
export const RoleProviders = z
  .object({
    primary: z.enum(['openrouter', 'gemini']).default('openrouter'),
    planning: z.enum(['openrouter', 'gemini']).default('openrouter'),
    execution: z.enum(['openrouter', 'gemini']).default('openrouter'),
    verification: z.enum(['openrouter', 'gemini']).default('openrouter'),
    voice: z.literal('gemini-live').default('gemini-live'),
  })
  .strict();
export type RoleProviders = z.infer<typeof RoleProviders>;

export const GeminiSettings = z.object({
  backend: z.enum(['ai-studio', 'vertex']).default('ai-studio'),
  baseUrl: z.string().default(GEMINI_DEFAULT_BASE_URL),
  vertexProject: z.string().max(30).default(''),
  vertexLocation: z.string().max(30).default('us-central1'),
  timeoutMs: z.number().int().min(5_000).max(600_000).default(90_000),
  maxRetries: z.number().int().min(0).max(5).default(2),
});
export type GeminiSettings = z.infer<typeof GeminiSettings>;

export const BrowserSettings = z.object({ headless: z.boolean().default(true) });

export const MemorySettings = z.object({
  /** Local embeddings for semantic search (BM25 keyword search always works). */
  semantic: z.boolean().default(true),
  /** First use downloads the model from Hugging Face into the data folder. */
  allowModelDownload: z.boolean().default(true),
});
export type MemorySettings = z.infer<typeof MemorySettings>;

const ModelId = z.string().regex(/^~?[\w.:/-]{3,120}$/, 'identifiant de modèle invalide');

export interface RuntimeOptions {
  dataDir: string;
  secrets?: SecretStore;
  fetchImpl?: typeof fetch;
  /** Allows http://127.0.0.1 as OpenRouter base URL. Only for automated tests with a local mock. */
  allowLoopbackProviderForTests?: boolean;
  desktop?: DesktopAdapter;
  browser?: BrowserService;
  /** Tests only: Gemini Live WebSocket replacement and endpoint (loopback needs allowLoopbackProviderForTests). */
  geminiWebSocketFactory?: WebSocketFactory;
  geminiLiveUrl?: string;
  /** Tests only: Gemini REST endpoint on loopback. */
  geminiBaseUrl?: string;
  /** Embedding engine; undefined = local Transformers.js engine if installed, null = keyword search only. */
  embedder?: Embedder | null;
  /** Directory holding the embedding model files (offline installs). */
  embeddingModelPath?: string;
  /** Tests: replaces the Windows toast notifier; scheduler tick period. */
  notifier?: Notifier;
  schedulerTickMs?: number;
  /** false: triggers are stored but nothing fires (tests that drive the scheduler by hand). */
  startScheduler?: boolean;
  logToConsole?: boolean;
}

export interface CatalogState {
  models: ModelInfo[];
  fetchedAt: string | null;
  error: string | null;
}

export type HermesRuntime = Awaited<ReturnType<typeof createRuntime>>;

export async function createRuntime(opts: RuntimeOptions) {
  mkdirSync(opts.dataDir, { recursive: true });
  const logger = new Logger({ dir: join(opts.dataDir, 'logs'), console: opts.logToConsole });
  const store = new HermesStore(join(opts.dataDir, 'hermes.db'));
  const telemetry = new Telemetry(store, logger);
  let secrets: SecretStore;
  try {
    secrets = opts.secrets ?? new LayeredSecretStore(new KeyringSecretStore());
  } catch (err) {
    throw new HermesError('CONFIG', `Coffre de secrets du système indisponible : ${errorMessage(err)}`);
  }

  // Late-bound pieces referenced by settings and tool services.
  let providerInstance: OpenRouterProvider | null = null;
  let geminiInstance: GeminiProvider | null = null;
  let liveInstance: GeminiLiveProvider | null = null;
  let executor: ToolExecutor | null = null;
  let orchestrator: Orchestrator | null = null;

  // ---------------------------------------------------------------- settings (non-secret, in SQLite)
  const workspace = join(opts.dataDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const settings = {
    policy: (): PolicyConfig =>
      PolicyConfig.parse(store.getSetting('app_settings', 'policy', { allowedRoots: [workspace] })),
    setPolicy(input: unknown): PolicyConfig {
      const p = PolicyConfig.parse(input);
      // Roots are stored canonical so later comparisons cannot be fooled by casing or links.
      const out: PolicyConfig = {
        ...p,
        allowedRoots: [...new Set(p.allowedRoots.map((r) => canonicalize(r)))],
        allowedDomains: [...new Set(p.allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean))],
      };
      store.setSetting('app_settings', 'policy', out);
      executor?.invalidateAvailability();
      telemetry.record({
        category: 'security',
        level: 'warn',
        type: 'policy.updated',
        message: 'Politique de sécurité modifiée par l’utilisateur',
        data: out,
      });
      return out;
    },
    provider: (): ProviderSettings =>
      ProviderSettings.parse(store.getSetting('provider_settings', 'openrouter', {})),
    setProvider(input: unknown): ProviderSettings {
      const s = ProviderSettings.parse(input);
      // Validates the base URL now: a bad URL is refused instead of silently redirecting the key.
      new OpenRouterProvider({
        ...s,
        getApiKey: async () => null,
        allowLoopbackForTests: opts.allowLoopbackProviderForTests,
      });
      store.setSetting('provider_settings', 'openrouter', s);
      providerInstance = null;
      telemetry.record({
        category: 'provider',
        type: 'provider.settings_updated',
        message: 'Paramètres OpenRouter mis à jour',
        data: s,
      });
      return s;
    },
    gemini: (): GeminiSettings => {
      const s = GeminiSettings.parse(store.getSetting('provider_settings', 'gemini', {}));
      return opts.geminiBaseUrl ? { ...s, baseUrl: opts.geminiBaseUrl } : s;
    },
    setGemini(input: unknown): GeminiSettings {
      const s = GeminiSettings.parse(input);
      // Validates endpoint, project and region now: a bad value is refused instead of redirecting the key.
      geminiFrom(s);
      store.setSetting('provider_settings', 'gemini', s);
      geminiInstance = null;
      telemetry.record({
        category: 'provider',
        type: 'provider.gemini_settings_updated',
        message: `Paramètres Gemini mis à jour (${s.backend === 'vertex' ? `Vertex AI ${s.vertexProject}/${s.vertexLocation}` : 'Google AI Studio'})`,
      });
      return s;
    },
    roleProviders: (): RoleProviders =>
      RoleProviders.parse(store.getSetting('app_settings', 'role_providers', {})),
    setRoleProviders(input: unknown): RoleProviders {
      const r = RoleProviders.parse({ ...settings.roleProviders(), ...(input as object) });
      store.setSetting('app_settings', 'role_providers', r);
      telemetry.record({
        category: 'provider',
        type: 'provider.roles_updated',
        message: `Fournisseurs par rôle : ${Object.entries(r)
          .map(([k, v]) => `${k} → ${v}`)
          .join(', ')}`,
      });
      return r;
    },
    voice: (): VoiceSettings => VoiceSettings.parse(store.getSetting('app_settings', 'voice', {})),
    setVoice(input: unknown): VoiceSettings {
      const v = VoiceSettings.parse(input);
      store.setSetting('app_settings', 'voice', v);
      return v;
    },
    memory: (): MemorySettings => MemorySettings.parse(store.getSetting('app_settings', 'memory', {})),
    setMemory(input: unknown): MemorySettings {
      const m = MemorySettings.parse(input);
      store.setSetting('app_settings', 'memory', m);
      return m;
    },
    sandbox: (): SandboxSettings => SandboxSettings.parse(store.getSetting('app_settings', 'sandbox', {})),
    setSandbox(input: unknown): SandboxSettings {
      const s = SandboxSettings.parse(input);
      store.setSetting('app_settings', 'sandbox', s);
      telemetry.record({
        category: 'security',
        level: s.enabled ? 'info' : 'warn',
        type: 'sandbox.updated',
        message: s.enabled
          ? `Bac à sable des processus : ${s.memoryMb} Mo, ${s.cpuPercent} % CPU, ${s.maxProcesses} processus`
          : 'Bac à sable des processus désactivé par l’utilisateur',
        data: s,
      });
      return s;
    },
    budget: (): MissionBudget => MissionBudget.parse(store.getSetting('app_settings', 'budget', {})),
    setBudget(input: unknown): MissionBudget {
      const b = MissionBudget.parse(input);
      store.setSetting('app_settings', 'budget', b);
      return b;
    },
    search: (): SearchSettings => SearchSettings.parse(store.getSetting('app_settings', 'search', {})),
    setSearch(input: unknown): SearchSettings {
      const s = SearchSettings.parse(input);
      store.setSetting('app_settings', 'search', s);
      executor?.invalidateAvailability();
      return s;
    },
    proactive: (): ProactiveSettings =>
      ProactiveSettings.parse(store.getSetting('app_settings', 'proactive', {})),
    setProactive(input: unknown): ProactiveSettings {
      const p = ProactiveSettings.parse(input);
      store.setSetting('app_settings', 'proactive', p);
      telemetry.record({
        category: 'security',
        level: 'warn',
        type: 'proactive.updated',
        message: p.enabled
          ? `Missions proactives : ${p.maxCostUsd.toFixed(2)} $ max. par mission, ${p.maxRunsPerDay} par 24 h`
          : 'Missions proactives désactivées',
        data: p,
      });
      return p;
    },
    browser: () => BrowserSettings.parse(store.getSetting('app_settings', 'browser', {})),
    assignments(): Record<ModelRole, ModelAssignment | null> {
      const rows = store.getModelAssignments();
      return Object.fromEntries(
        MODEL_ROLES.map((r) => {
          const row = rows.find((x) => x.role === r);
          return [r, row ? { modelId: row.modelId, fallbacks: row.fallbacks } : null];
        }),
      ) as Record<ModelRole, ModelAssignment | null>;
    },
    setAssignment(role: ModelRole, modelId: string, fallbacks: string[]): void {
      const id = ModelId.parse(modelId);
      const fb = z.array(ModelId).max(3).parse(fallbacks);
      store.setModelAssignment(role, id, fb);
      telemetry.record({
        category: 'provider',
        type: 'model.assigned',
        message: `Rôle ${role} → ${id}${fb.length ? ` (secours : ${fb.join(', ')})` : ''}`,
      });
    },
  };

  // ---------------------------------------------------------------- provider & catalog
  const provider = (): OpenRouterProvider => {
    if (!providerInstance) {
      const s = settings.provider();
      providerInstance = new OpenRouterProvider({
        baseUrl: s.baseUrl,
        timeoutMs: s.timeoutMs,
        maxRetries: s.maxRetries,
        getApiKey: () => secrets.get(API_KEY_NAME),
        fetchImpl: opts.fetchImpl,
        allowLoopbackForTests: opts.allowLoopbackProviderForTests,
        logger,
      });
    }
    return providerInstance;
  };
  const geminiKey = async (): Promise<string | null> =>
    (await secrets.get(GEMINI_KEY_NAME)) ?? process.env.GOOGLE_API_KEY ?? null;
  const geminiFrom = (s: GeminiSettings) =>
    new GeminiProvider({
      backend: s.backend,
      baseUrl: s.baseUrl,
      vertex: s.backend === 'vertex' ? { project: s.vertexProject, location: s.vertexLocation } : undefined,
      timeoutMs: s.timeoutMs,
      maxRetries: s.maxRetries,
      getApiKey: geminiKey,
      fetchImpl: opts.fetchImpl,
      allowLoopbackForTests: opts.allowLoopbackProviderForTests,
      logger,
    });
  const gemini = (): GeminiProvider => (geminiInstance ??= geminiFrom(settings.gemini()));
  const geminiLive = (): GeminiLiveProvider =>
    (liveInstance ??= new GeminiLiveProvider({
      getApiKey: geminiKey,
      url: opts.geminiLiveUrl ?? GEMINI_LIVE_DEFAULT_URL,
      webSocketFactory: opts.geminiWebSocketFactory,
      allowLoopbackForTests: opts.allowLoopbackProviderForTests,
      telemetry,
      logger,
    }));
  /** Text provider of a role; an unassigned role follows the primary role's provider, like its model. */
  const providerFor = (role: ModelRole): ModelProvider => {
    const kinds = settings.roleProviders();
    const effective = role !== 'voice' && settings.assignments()[role] ? role : 'primary';
    return kinds[effective as Exclude<ModelRole, 'voice'>] === 'gemini' ? gemini() : provider();
  };
  const loadCatalog = (): CatalogState =>
    store.getSetting<CatalogState>('provider_settings', 'catalog', {
      models: [],
      fetchedAt: null,
      error: null,
    });
  const loadGeminiCatalog = (): CatalogState =>
    store.getSetting<CatalogState>('provider_settings', 'gemini_catalog', {
      models: [],
      fetchedAt: null,
      error: null,
    });
  // OpenRouter ids are "vendor/model" and Gemini ids bare ("gemini-…"): one map holds both catalogs.
  let catalogMap = new Map([...loadCatalog().models, ...loadGeminiCatalog().models].map((m) => [m.id, m]));
  const refreshGeminiCatalog = async (): Promise<CatalogState> => {
    const prev = loadGeminiCatalog();
    try {
      const models = await gemini().listModels();
      const state: CatalogState = { models, fetchedAt: new Date().toISOString(), error: null };
      store.setSetting('provider_settings', 'gemini_catalog', state);
      for (const m of models) catalogMap.set(m.id, m);
      telemetry.record({
        category: 'provider',
        type: 'catalog.gemini_refreshed',
        message: `${models.length} modèles récupérés depuis Gemini`,
      });
      return state;
    } catch (err) {
      const state = { ...prev, error: errorMessage(err) };
      store.setSetting('provider_settings', 'gemini_catalog', state);
      return state;
    }
  };
  const refreshCatalog = async (): Promise<CatalogState> => {
    const prev = loadCatalog();
    try {
      const models = await provider().listModels();
      const state: CatalogState = { models, fetchedAt: new Date().toISOString(), error: null };
      store.setSetting('provider_settings', 'catalog', state);
      catalogMap = new Map([...models, ...loadGeminiCatalog().models].map((m) => [m.id, m]));
      telemetry.record({
        category: 'provider',
        type: 'catalog.refreshed',
        message: `${models.length} modèles récupérés depuis OpenRouter`,
      });
      return state;
    } catch (err) {
      const state = { ...prev, error: errorMessage(err) };
      store.setSetting('provider_settings', 'catalog', state);
      telemetry.record({
        category: 'provider',
        level: 'error',
        type: 'catalog.failed',
        message: `Catalogue indisponible : ${errorMessage(err)}`,
      });
      return state;
    }
  };

  // ---------------------------------------------------------------- tools & services
  const tools = createToolRegistry();
  const approvals = new ApprovalBroker(store, telemetry);
  const desktop =
    opts.desktop ??
    (process.platform === 'win32'
      ? new PowerShellUiaAdapter()
      : new UnavailableDesktopAdapter('Windows requis'));
  const browser =
    opts.browser ??
    new PlaywrightBrowserService({
      headless: settings.browser().headless,
      getPolicy: settings.policy,
      onBlocked: (missionId, url) =>
        telemetry.record({
          missionId,
          category: 'security',
          level: 'warn',
          type: 'browser.navigation_blocked',
          message: `Navigation bloquée vers un domaine non autorisé : ${url}`,
        }),
    });
  const gateway = new LlmGateway({
    provider: providerFor,
    settings: settings.provider,
    assignment: (r) => settings.assignments()[r],
    catalog: () => catalogMap,
    telemetry,
  });
  const webSearch = new OpenRouterWebSearchProvider(
    {
      id: 'openrouter',
      chat: (r, o) => provider().chat(r, o),
      listModels: (s) => provider().listModels(s),
      testConnection: (m) => provider().testConnection(m),
      hasKey: () => provider().hasKey(),
    },
    () => settings.assignments().primary?.modelId ?? null,
  );
  const searchRegistry = new SearchProviderRegistry(
    new Map<string, SearchProvider>([
      [
        'tavily',
        new TavilySearchProvider({ getKey: () => secrets.get(TAVILY_KEY_NAME), fetchImpl: opts.fetchImpl }),
      ],
      [
        'brave',
        new BraveSearchProvider({ getKey: () => secrets.get(BRAVE_KEY_NAME), fetchImpl: opts.fetchImpl }),
      ],
      ['openrouter-web', webSearch],
    ]),
    settings.search,
  );
  const search: SearchProvider = searchRegistry;

  const memorySettings = settings.memory();
  const embedder: Embedder | null =
    opts.embedder !== undefined
      ? opts.embedder
      : memorySettings.semantic
        ? new TransformersEmbedder({
            dataDir: opts.dataDir,
            allowRemoteModels: memorySettings.allowModelDownload,
            localModelPath: opts.embeddingModelPath ?? process.env.HERMES_EMBEDDING_MODEL_PATH,
            logger,
          })
        : null;
  const memoryIndex = new MemoryIndex(store, embedder, logger);
  // Existing memories (and those saved while the engine was unavailable) get their vectors lazily.
  memoryIndex.schedule(5_000);

  const services: ToolServices = {
    store,
    telemetry,
    dataDir: opts.dataDir,
    getPolicy: settings.policy,
    browser,
    desktop,
    search,
    memoryIndex,
    sandbox: settings.sandbox,
    sessionEnv: new Map(),
    missionControl: {
      pause: (id, reason) => orchestrator?.pause(id, reason),
      cancel: (id, reason) => void orchestrator?.cancel(id, reason),
      verifyTask: (taskId, signal) => {
        if (!orchestrator) throw new HermesError('CONFIG', 'Orchestrateur non initialisé');
        return orchestrator.verifyTaskNow(taskId, signal);
      },
    },
  };
  const toolExecutor = new ToolExecutor(tools, services, approvals);
  executor = toolExecutor;
  const unavailableTools = async () => {
    const out = new Map<string, string>();
    const disabled = settings.policy().disabledTools;
    for (const t of tools.values()) {
      if (disabled.includes(t.id)) {
        out.set(t.id, 'désactivé dans les paramètres');
        continue;
      }
      const a = await toolExecutor.availability(t);
      if (!a.available) out.set(t.id, a.reason ?? 'indisponible');
    }
    return out;
  };
  const agents = {} as Record<ExecutorAgentId, Agent>;
  for (const a of EXECUTOR_AGENTS) agents[a] = new ToolLoopAgent(a, gateway, toolExecutor, tools);
  const orch = new Orchestrator({
    store,
    telemetry,
    executor: toolExecutor,
    tools,
    planner: new Planner(gateway),
    verifier: new Verifier(gateway, tools),
    agents,
    getPolicy: settings.policy,
    defaultBudget: settings.budget,
    unavailableTools,
    closeMissionResources: (id) => {
      services.sessionEnv.delete(id);
      return browser.closeMission(id);
    },
    stopAllWorkers: async () => {
      const processes = killAllProcesses();
      await browser.closeAll();
      return { processes };
    },
  });
  orchestrator = orch;

  /** One voice conversation: a Gemini Live session bridged to the client sink and the voice agent. */
  const createVoiceBridge = (sink: VoiceSink): AudioBridge => {
    const v = settings.voice();
    return new AudioBridge({
      live: geminiLive(),
      agent: new VoiceAgent({ orchestrator: orch, store, telemetry }),
      telemetry,
      sink,
      settings: {
        model: settings.assignments().voice?.modelId ?? DEFAULT_LIVE_MODEL,
        voiceName: v.voiceName,
        languageCode: v.languageCode,
        affectiveDialogue: v.affectiveDialogue,
      },
    });
  };
  const recovery = orch.recoverOnStartup();

  const notifier =
    opts.notifier ??
    new DesktopNotifier({
      telemetry,
      logger,
      desktopEnabled: () => settings.proactive().desktopNotifications,
    });
  const scheduler = new Scheduler({
    store,
    telemetry,
    logger,
    notifier,
    missions: {
      createMission: (request, budget) => orch.createMission(request, budget),
      start: (id) => orch.start(id),
      isActive: (id) => orch.isActive(id),
      idle: (id) => orch.idle(id),
      isHalted: () => toolExecutor.isHalted,
    },
    defaultBudget: settings.budget,
    proactive: settings.proactive,
    allowedRoots: () => settings.policy().allowedRoots,
    tickMs: opts.schedulerTickMs,
  });
  if (opts.startScheduler !== false) scheduler.start();
  telemetry.record({
    category: 'application',
    type: 'app.started',
    message: `HERMES démarré (schéma v${store.schemaVersion()}, coffre : ${secrets.kind})`,
    data: recovery,
  });

  return {
    dataDir: opts.dataDir,
    store,
    telemetry,
    logger,
    secrets,
    settings,
    provider,
    catalog: { get: loadCatalog, refresh: refreshCatalog },
    memoryIndex,
    sandboxStatus: () => {
      const runner = jobRunnerPath();
      const s = settings.sandbox();
      return {
        settings: s,
        runner,
        active: s.enabled && runner !== null,
        reason: !s.enabled
          ? 'désactivé dans les paramètres'
          : runner
            ? null
            : process.platform === 'win32'
              ? 'utilitaire hermes-jobrun introuvable'
              : 'Job Objects disponibles sous Windows uniquement',
      };
    },
    gemini,
    geminiLive,
    geminiKey,
    geminiCatalog: { get: loadGeminiCatalog, refresh: refreshGeminiCatalog },
    createVoiceBridge,
    tools,
    executor: toolExecutor,
    approvals,
    browser,
    desktop,
    search,
    searchRegistry,
    orchestrator: orch,
    scheduler,
    notifier,
    unavailableTools,
    recovery,
    async close() {
      scheduler.stop();
      await browser.closeAll();
      killAllProcesses();
      store.close();
    },
  };
}
