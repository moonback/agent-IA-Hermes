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
import type { ModelInfo, ModelProvider } from './model-providers/types';
import { PolicyConfig } from './policy-engine/policy';
import { canonicalize } from './policy-engine/paths';
import { createToolRegistry } from './tools/registry';
import { ToolExecutor } from './tools/executor';
import { ApprovalBroker } from './tools/approvals';
import { PlaywrightBrowserService, type BrowserService } from './tools/browser';
import { PowerShellUiaAdapter, UnavailableDesktopAdapter, type DesktopAdapter } from './tools/desktop';
import { NoSearchProvider, OpenRouterWebSearchProvider, type SearchProvider } from './tools/web-search';
import { killAllProcesses } from './tools/process';
import type { ToolServices } from './tools/types';
import { LlmGateway, ProviderSettings, type ModelAssignment } from './agents/llm-gateway';
import { Planner } from './agents/planner';
import { Verifier } from './agents/verifier';
import { ToolLoopAgent, type Agent } from './agents/tool-agent';
import { Orchestrator } from './orchestrator/orchestrator';

export const API_KEY_NAME = 'OPENROUTER_API_KEY';

export const SearchSettings = z.object({ provider: z.enum(['none', 'openrouter-web']).default('none') });
export type SearchSettings = z.infer<typeof SearchSettings>;

export const BrowserSettings = z.object({ headless: z.boolean().default(true) });

const ModelId = z.string().regex(/^~?[\w.:/-]{3,120}$/, 'identifiant de modèle invalide');

export interface RuntimeOptions {
  dataDir: string;
  secrets?: SecretStore;
  fetchImpl?: typeof fetch;
  /** Allows http://127.0.0.1 as OpenRouter base URL. Only for automated tests with a local mock. */
  allowLoopbackProviderForTests?: boolean;
  desktop?: DesktopAdapter;
  browser?: BrowserService;
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
  const loadCatalog = (): CatalogState =>
    store.getSetting<CatalogState>('provider_settings', 'catalog', {
      models: [],
      fetchedAt: null,
      error: null,
    });
  let catalogMap = new Map(loadCatalog().models.map((m) => [m.id, m]));
  const refreshCatalog = async (): Promise<CatalogState> => {
    const prev = loadCatalog();
    try {
      const models = await provider().listModels();
      const state: CatalogState = { models, fetchedAt: new Date().toISOString(), error: null };
      store.setSetting('provider_settings', 'catalog', state);
      catalogMap = new Map(models.map((m) => [m.id, m]));
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
    provider: (): ModelProvider => provider(),
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
  const noSearch = new NoSearchProvider();
  const search: SearchProvider = {
    get id() {
      return settings.search().provider;
    },
    availability: () =>
      settings.search().provider === 'openrouter-web' ? webSearch.availability() : noSearch.availability(),
    search: (q, n, s) =>
      settings.search().provider === 'openrouter-web' ? webSearch.search(q, n, s) : noSearch.search(),
  };

  const services: ToolServices = {
    store,
    telemetry,
    dataDir: opts.dataDir,
    getPolicy: settings.policy,
    browser,
    desktop,
    search,
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
    closeMissionResources: (id) => browser.closeMission(id),
    stopAllWorkers: async () => {
      const processes = killAllProcesses();
      await browser.closeAll();
      return { processes };
    },
  });
  orchestrator = orch;
  const recovery = orch.recoverOnStartup();
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
    tools,
    executor: toolExecutor,
    approvals,
    browser,
    desktop,
    search,
    orchestrator: orch,
    unavailableTools,
    recovery,
    async close() {
      await browser.closeAll();
      killAllProcesses();
      store.close();
    },
  };
}
