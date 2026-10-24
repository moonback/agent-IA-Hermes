import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AGENTS,
  API_KEY_NAME,
  DEFAULT_LIVE_MODEL,
  GEMINI_KEY_NAME,
  GEMINI_LIVE_LANGUAGES,
  GEMINI_VOICES,
  HermesError,
  MODEL_ROLES,
  MemoryKind,
  MissionStatus,
  ModelRole,
  redact,
  registerSecret,
  toolsForAgent,
  type ConnectionTestResult,
  type HermesRuntime,
  type LiveEvent,
  type MissionEvent,
} from '@hermes/core';
import { HANDLED, Router } from './http';
import { VoiceTickets, voiceStream } from './voice';

const startedAt = Date.now();

export function buildRoutes(rt: HermesRuntime, meta: { version: string; startupMs: number }): Router {
  const r = new Router();
  const { store, orchestrator } = rt;

  const keySource = async () => {
    const has = Boolean(await rt.secrets.get(API_KEY_NAME));
    const src =
      'source' in rt.secrets && typeof rt.secrets.source === 'function'
        ? (rt.secrets.source as (n: string) => string)(API_KEY_NAME)
        : rt.secrets.kind;
    return { hasKey: has, source: has ? src : null };
  };
  const lastTest = () => store.getSetting<ConnectionTestResult | null>('provider_settings', 'lastTest', null);
  const geminiTest = (kind: 'rest' | 'live') =>
    store.getSetting<ConnectionTestResult | null>(
      'provider_settings',
      kind === 'rest' ? 'geminiTest' : 'geminiLiveTest',
      null,
    );
  const geminiKeySource = async () => {
    const vault = await rt.secrets.get(GEMINI_KEY_NAME);
    const has = Boolean(vault ?? process.env.GOOGLE_API_KEY);
    const src =
      !vault && process.env.GOOGLE_API_KEY
        ? 'env'
        : 'source' in rt.secrets && typeof rt.secrets.source === 'function'
          ? (rt.secrets.source as (n: string) => string)(GEMINI_KEY_NAME)
          : rt.secrets.kind;
    return { hasKey: has, source: has ? src : null };
  };
  const geminiState = async () => ({
    ...(await geminiKeySource()),
    settings: rt.settings.gemini(),
    lastTest: geminiTest('rest'),
    liveTest: geminiTest('live'),
  });
  /** Model used to test Gemini: the first text role routed to Gemini that has a model. */
  const geminiTestModel = () => {
    const roles = rt.settings.roleProviders();
    const a = rt.settings.assignments();
    for (const role of ['primary', 'planning', 'execution', 'verification'] as const)
      if (roles[role] === 'gemini' && a[role]?.modelId) return a[role]!.modelId;
    return null;
  };

  // ------------------------------------------------------------- system
  r.on('GET', '/api/status', async () => {
    const tools = await rt.unavailableTools();
    const missions = store.listMissions({
      status: ['planning', 'planned', 'running', 'paused', 'interrupted'],
      limit: 100,
    });
    const usage = store.db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(ai_calls),0) AS ai, COALESCE(SUM(cost_usd),0) AS cost FROM agent_runs',
      )
      .get() as Record<string, number>;
    const verified = store.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM missions WHERE status IN ('completed','failed','cancelled') GROUP BY status`,
      )
      .all() as { status: string; n: number }[];
    return {
      version: meta.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      startupMs: meta.startupMs,
      halted: rt.executor.isHalted,
      provider: {
        ...(await keySource()),
        lastTest: lastTest(),
        assignments: rt.settings.assignments(),
        roleProviders: rt.settings.roleProviders(),
        gemini: { ...(await geminiKeySource()), lastTest: geminiTest('rest'), liveTest: geminiTest('live') },
      },
      workers: {
        desktop: await rt.desktop.availability(),
        browser: await rt.browser.availability(),
        search: await rt.search.availability(),
        activeLoops: orchestrator.activeCount(),
      },
      unavailableTools: Object.fromEntries(tools),
      missions: { active: missions, pendingApprovals: store.listApprovals({ status: 'pending' }).length },
      usage: {
        agentRuns: usage.n,
        aiCalls: usage.ai,
        costUsd: usage.cost,
        outcomes: Object.fromEntries(verified.map((v) => [v.status, v.n])),
      },
      recovery: rt.recovery,
      dataDir: rt.dataDir,
    };
  });

  r.on('POST', '/api/emergency-stop', async () => orchestrator.emergencyStop());
  r.on('POST', '/api/rearm', () => (orchestrator.rearm(), { halted: rt.executor.isHalted }));

  r.on('GET', '/api/stream', ({ req, res, query }) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    const missionFilter = query.get('missionId');
    const write = (type: string, data: unknown) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify(redact(data))}\n\n`);
    const onEvent = (e: MissionEvent) =>
      (!missionFilter || e.missionId === missionFilter) && write('event', e);
    const onLive = (e: LiveEvent) => (!missionFilter || e.missionId === missionFilter) && write('live', e);
    rt.telemetry.on('event', onEvent);
    rt.telemetry.on('live', onLive);
    write('hello', { at: new Date().toISOString() });
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      rt.telemetry.off('event', onEvent);
      rt.telemetry.off('live', onLive);
    });
    return HANDLED;
  });

  r.on('GET', '/api/events', ({ query }) =>
    store.listEvents({
      missionId: query.get('missionId') ?? undefined,
      category: query.get('category') ?? undefined,
      level: query.get('level') ?? undefined,
      afterSeq: query.has('afterSeq') ? Number(query.get('afterSeq')) : undefined,
      limit: query.has('limit') ? Number(query.get('limit')) : 200,
    }),
  );
  r.on('GET', '/api/audit/verify', () => store.verifyAuditChain());

  r.on('GET', '/api/diagnostics', async () =>
    redact({
      generatedAt: new Date().toISOString(),
      app: {
        version: meta.version,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        memory: process.memoryUsage(),
      },
      database: { schemaVersion: store.schemaVersion(), audit: store.verifyAuditChain() },
      provider: {
        ...(await keySource()),
        settings: rt.settings.provider(),
        lastTest: lastTest(),
        catalog: {
          count: rt.catalog.get().models.length,
          fetchedAt: rt.catalog.get().fetchedAt,
          error: rt.catalog.get().error,
        },
        assignments: rt.settings.assignments(),
      },
      policy: rt.settings.policy(),
      tools: Object.fromEntries(await rt.unavailableTools()),
      workers: {
        desktop: await rt.desktop.availability(),
        browser: await rt.browser.availability(),
        search: await rt.search.availability(),
      },
      toolStats: store.toolStats(),
      agentStats: store.agentStats(),
      recentErrors: rt.logger.recent(100, 'warn'),
    }),
  );

  r.on('POST', '/api/maintenance/backup', () => {
    const target = join(rt.dataDir, 'backups', `hermes-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    return { path: store.backup(target) };
  });
  r.on('POST', '/api/maintenance/purge', ({ body }) => {
    const { before } = z.object({ before: z.iso.datetime() }).parse(body);
    return store.purgeHistory(before);
  });

  // ------------------------------------------------------------- missions
  r.on('GET', '/api/missions', ({ query }) => {
    const status = query.get('status')?.split(',').filter(Boolean);
    return store.listMissions({
      status: status ? z.array(MissionStatus).parse(status) : undefined,
      search: query.get('search') ?? undefined,
      limit: Number(query.get('limit') ?? 50),
    });
  });
  r.on('POST', '/api/missions', ({ body }) => {
    const b = z
      .object({ request: z.string().min(2).max(8000), budget: z.record(z.string(), z.number()).optional() })
      .parse(body);
    return orchestrator.createMission(b.request, b.budget);
  });
  r.on('GET', '/api/missions/:id', ({ params }) => ({
    mission: store.requireMission(params.id!),
    tasks: store.listTasks(params.id!),
    toolCalls: store.listToolCalls({ missionId: params.id!, limit: 500 }),
    approvals: store.listApprovals({ missionId: params.id! }),
    artifacts: store.listArtifacts({ missionId: params.id! }),
    active: orchestrator.isActive(params.id!),
  }));
  r.on('POST', '/api/missions/:id/start', ({ params, body }) => {
    const b = z.object({ confirmUncertainTaskIds: z.array(z.string()).default([]) }).parse(body ?? {});
    return orchestrator.start(params.id!, b);
  });
  r.on('POST', '/api/missions/:id/pause', ({ params, body }) => {
    const { reason } = z
      .object({ reason: z.string().max(500).default("Demande de l'utilisateur") })
      .parse(body ?? {});
    orchestrator.pause(params.id!, reason);
    return { ok: true };
  });
  r.on('POST', '/api/missions/:id/cancel', ({ params, body }) => {
    const { reason } = z
      .object({ reason: z.string().max(500).default("Annulée par l'utilisateur") })
      .parse(body ?? {});
    return orchestrator.cancel(params.id!, reason);
  });
  r.on('GET', '/api/missions/:id/report', ({ params, res }) => {
    const m = store.requireMission(params.id!);
    const tasks = store.listTasks(m.id);
    const calls = store.listToolCalls({ missionId: m.id, limit: 2000 });
    const lines = [
      `# Rapport de mission HERMES`,
      ``,
      `- Identifiant : ${m.id}`,
      `- Statut : **${m.status}**`,
      `- Créée : ${m.createdAt} — Terminée : ${m.endedAt ?? 'non terminée'}`,
      `- Consommation : ${m.usage.aiCalls} appels IA, ${m.usage.toolCalls} appels d'outils, ${m.usage.promptTokens + m.usage.completionTokens} tokens, ${m.usage.costKnown ? `${m.usage.costUsd.toFixed(4)} USD` : `≥ ${m.usage.costUsd.toFixed(4)} USD (coût partiellement inconnu)`}`,
      ``,
      `## Demande`,
      m.request,
      ``,
      `## Plan`,
      m.plan?.summary ?? '(aucun plan)',
      ``,
      `## Étapes`,
      ...tasks.flatMap((t) => [
        `### ${t.stepId} — ${t.status} (${t.agent}, ${t.attempts} tentative(s))`,
        `Objectif : ${t.objective}`,
        `Résultat : ${t.result?.summary ?? '—'}`,
        t.error ? `Erreur : ${t.error}` : '',
        `Preuves :`,
        ...calls
          .filter((c) => c.taskId === t.id)
          .map(
            (c) =>
              `- \`${c.toolId}\` ${c.status}${c.verified === true ? ' ✔ vérifié' : c.verified === false ? ' ✘ non vérifié' : ''} (${c.id})${c.error ? ` — ${c.error}` : ''}`,
          ),
        ``,
      ]),
      `## Vérification finale`,
      m.result?.verification
        ? `**${m.result.verification.verdict}** — ${m.result.verification.reasons.join(' ; ')}`
        : '(aucune)',
    ];
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="hermes-${m.id}.md"`,
    });
    res.end(redact(lines.filter((l) => l !== '').join('\n')));
    return HANDLED;
  });

  // ------------------------------------------------------------- approvals
  r.on('GET', '/api/approvals', ({ query }) =>
    store.listApprovals({
      status: (query.get('status') as 'pending' | null) ?? undefined,
      missionId: query.get('missionId') ?? undefined,
    }),
  );
  r.on('POST', '/api/approvals/:id', ({ params, body }) => {
    const { decision } = z.object({ decision: z.enum(['approved', 'denied']) }).parse(body);
    return rt.approvals.decide(params.id!, decision);
  });

  // ------------------------------------------------------------- agents & tools
  r.on('GET', '/api/agents', () => {
    const stats = store.agentStats();
    const assignments = rt.settings.assignments();
    const busy = new Map(
      (
        store.db
          .prepare(
            `SELECT agent, COUNT(*) AS n FROM tasks WHERE status IN ('running','waiting_approval') GROUP BY agent`,
          )
          .all() as { agent: string; n: number }[]
      ).map((x) => [x.agent, x.n]),
    );
    const planning = store.listMissions({ status: ['planning'], limit: 100 }).length;
    const running = store.listMissions({ status: ['running'], limit: 100 }).length;
    busy.set('planner', planning);
    busy.set('orchestrator', running);
    return Object.values(AGENTS).map((a) => ({
      activeTasks: busy.get(a.id) ?? 0,
      id: a.id,
      name: a.name,
      role: a.role,
      capabilities: a.capabilities,
      executes: a.executes,
      limits: a.limits,
      modelRole: a.modelRole,
      model: assignments[a.modelRole] ?? assignments.primary,
      tools: a.executes ? toolsForAgent(a.id as never, rt.tools.values()).map((t) => t.id) : [],
      stats: stats.find((s) => s.agent === a.id) ?? null,
    }));
  });
  r.on('GET', '/api/tools', async () => {
    const policy = rt.settings.policy();
    const stats = store.toolStats();
    return Promise.all(
      [...rt.tools.values()].map(async (t) => ({
        id: t.id,
        description: t.description,
        allowedAgents: t.allowedAgents,
        permissions: t.permissions,
        risk: t.risk,
        timeoutMs: t.timeoutMs,
        reversible: t.reversible,
        idempotent: t.idempotent,
        verification: t.verification,
        confirmation: t.confirmation,
        availability: await rt.executor.availability(t),
        enabled: !policy.disabledTools.includes(t.id),
        approvalRule: policy.approvalRules[t.id] ?? 'auto',
        inputSchema: z.toJSONSchema(t.inputSchema, { io: 'input', unrepresentable: 'any' }),
        stats: stats.find((s) => s.toolId === t.id) ?? null,
      })),
    );
  });
  r.on('GET', '/api/tool-calls', ({ query }) =>
    store.listToolCalls({
      missionId: query.get('missionId') ?? undefined,
      limit: Number(query.get('limit') ?? 100),
    }),
  );

  // ------------------------------------------------------------- settings
  r.on('GET', '/api/policy', () => rt.settings.policy());
  r.on('PUT', '/api/policy', ({ body }) => rt.settings.setPolicy(body));
  r.on('GET', '/api/budget', () => rt.settings.budget());
  r.on('PUT', '/api/budget', ({ body }) => rt.settings.setBudget(body));
  r.on('GET', '/api/search-settings', () => rt.settings.search());
  r.on('PUT', '/api/search-settings', ({ body }) => rt.settings.setSearch(body));

  // ------------------------------------------------------------- OpenRouter
  r.on('GET', '/api/provider', async () => ({
    ...(await keySource()),
    settings: rt.settings.provider(),
    lastTest: lastTest(),
    assignments: rt.settings.assignments(),
  }));
  r.on('PUT', '/api/provider/settings', ({ body }) => rt.settings.setProvider(body));
  r.on('PUT', '/api/provider/key', async ({ body }) => {
    const { apiKey } = z
      .object({
        apiKey: z.string().trim().min(20).max(300).regex(/^\S+$/, 'la clé ne doit pas contenir d’espace'),
      })
      .parse(body);
    registerSecret(apiKey);
    await rt.secrets.set(API_KEY_NAME, apiKey);
    store.setSetting('provider_settings', 'lastTest', null);
    rt.executor.invalidateAvailability();
    rt.telemetry.record({
      category: 'security',
      type: 'provider.key_saved',
      message: 'Clé OpenRouter enregistrée dans le coffre du système',
    });
    return keySource();
  });
  r.on('DELETE', '/api/provider/key', async () => {
    await rt.secrets.delete(API_KEY_NAME);
    store.setSetting('provider_settings', 'lastTest', null);
    rt.executor.invalidateAvailability();
    rt.telemetry.record({
      category: 'security',
      level: 'warn',
      type: 'provider.key_deleted',
      message: 'Clé OpenRouter supprimée du coffre',
    });
    return keySource();
  });
  r.on('POST', '/api/provider/test', async () => {
    const result = await rt.provider().testConnection(rt.settings.assignments().primary?.modelId ?? null);
    store.setSetting('provider_settings', 'lastTest', result);
    rt.telemetry.record({
      category: 'provider',
      level: result.ok ? 'info' : 'warn',
      type: 'provider.test',
      message: `Test de connexion : ${result.status} — ${result.message}`,
    });
    return result;
  });
  r.on('GET', '/api/provider/models', () => rt.catalog.get());
  r.on('POST', '/api/provider/models/refresh', () => rt.catalog.refresh());
  r.on('PUT', '/api/provider/assignments/:role', ({ params, body }) => {
    const role = ModelRole.parse(params.role);
    const b = z.object({ modelId: z.string(), fallbacks: z.array(z.string()).default([]) }).parse(body);
    rt.settings.setAssignment(role, b.modelId, b.fallbacks);
    return rt.settings.assignments();
  });
  r.on('GET', '/api/provider/roles', () => MODEL_ROLES);
  r.on('GET', '/api/provider/role-providers', () => rt.settings.roleProviders());
  r.on('PUT', '/api/provider/role-providers', ({ body }) => rt.settings.setRoleProviders(body));

  // ------------------------------------------------------------- Gemini (REST + Live)
  r.on('GET', '/api/provider/gemini', () => geminiState());
  r.on('PUT', '/api/provider/gemini/settings', ({ body }) => rt.settings.setGemini(body));
  r.on('PUT', '/api/provider/gemini/key', async ({ body }) => {
    const { apiKey } = z
      .object({
        // Google API key (AIza…) or, for Vertex AI, an OAuth access token (ya29.…).
        apiKey: z.string().trim().min(30).max(4096).regex(/^\S+$/, 'la clé ne doit pas contenir d’espace'),
      })
      .parse(body);
    registerSecret(apiKey);
    await rt.secrets.set(GEMINI_KEY_NAME, apiKey);
    store.setSetting('provider_settings', 'geminiTest', null);
    store.setSetting('provider_settings', 'geminiLiveTest', null);
    rt.telemetry.record({
      category: 'security',
      type: 'provider.gemini_key_saved',
      message: 'Clé Gemini enregistrée dans le coffre du système',
    });
    return geminiKeySource();
  });
  r.on('DELETE', '/api/provider/gemini/key', async () => {
    await rt.secrets.delete(GEMINI_KEY_NAME);
    store.setSetting('provider_settings', 'geminiTest', null);
    store.setSetting('provider_settings', 'geminiLiveTest', null);
    rt.telemetry.record({
      category: 'security',
      level: 'warn',
      type: 'provider.gemini_key_deleted',
      message: 'Clé Gemini supprimée du coffre',
    });
    return geminiKeySource();
  });
  r.on('POST', '/api/provider/gemini/test', async () => {
    const result = await rt.gemini().testConnection(geminiTestModel());
    store.setSetting('provider_settings', 'geminiTest', result);
    rt.telemetry.record({
      category: 'provider',
      level: result.ok ? 'info' : 'warn',
      type: 'provider.gemini_test',
      message: `Test Gemini : ${result.status} — ${result.message}`,
    });
    return result;
  });
  r.on('POST', '/api/provider/gemini/live-test', async () => {
    const result = await rt
      .geminiLive()
      .testConnection(rt.settings.assignments().voice?.modelId ?? DEFAULT_LIVE_MODEL);
    store.setSetting('provider_settings', 'geminiLiveTest', result);
    rt.telemetry.record({
      category: 'voice',
      level: result.ok ? 'info' : 'warn',
      type: 'provider.gemini_live_test',
      message: `Test Gemini Live : ${result.status} — ${result.message}`,
    });
    return result;
  });
  r.on('GET', '/api/provider/gemini/models', () => rt.geminiCatalog.get());
  r.on('POST', '/api/provider/gemini/models/refresh', () => rt.geminiCatalog.refresh());

  // ------------------------------------------------------------- voice
  const tickets = new VoiceTickets();
  r.on('GET', '/api/voice/settings', () => rt.settings.voice());
  r.on('PUT', '/api/voice/settings', ({ body }) => rt.settings.setVoice(body));
  r.on('GET', '/api/voice/catalog', () => ({
    voices: GEMINI_VOICES.map(([name, style]) => ({ name, style })),
    languages: GEMINI_LIVE_LANGUAGES.map(([code, label]) => ({ code, label })),
    defaultModel: DEFAULT_LIVE_MODEL,
    model: rt.settings.assignments().voice?.modelId ?? DEFAULT_LIVE_MODEL,
  }));
  r.on('POST', '/api/voice/ticket', () => tickets.issue());
  r.ws('/api/voice/stream', voiceStream(rt, tickets));

  // ------------------------------------------------------------- desktop (user-initiated observation)
  r.on('POST', '/api/desktop/observe', async () => {
    const avail = await rt.desktop.availability();
    if (!avail.available)
      throw new HermesError('TOOL_UNAVAILABLE', avail.reason ?? 'Adaptateur bureau indisponible');
    const signal = AbortSignal.timeout(30_000);
    const win = await rt.desktop.call('windows', {}, signal);
    const dir = join(rt.dataDir, 'artifacts', 'manual');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `screen-${Date.now()}.png`);
    const shot = await rt.desktop.call('screenshot', { path }, signal);
    const buf = readFileSync(path);
    const id = store.addArtifact({
      missionId: null,
      taskId: null,
      kind: 'screenshot',
      path,
      mime: 'image/png',
      size: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
      description: 'Capture manuelle',
    });
    rt.telemetry.record({
      category: 'desktop',
      type: 'desktop.observed',
      message: "Observation manuelle du bureau par l'utilisateur",
      data: { artifactId: id },
    });
    return {
      observedAt: new Date().toISOString(),
      windows: win.windows,
      foregroundHandle: win.foregroundHandle,
      screenshot: { artifactId: id, width: shot.width, height: shot.height },
    };
  });
  r.on('GET', '/api/artifacts', ({ query }) =>
    store.listArtifacts({
      missionId: query.get('missionId') ?? undefined,
      kind: query.get('kind') ?? undefined,
      limit: Number(query.get('limit') ?? 20),
    }),
  );
  r.on('GET', '/api/artifacts/:id/file', ({ params, res }) => {
    const a = store.getArtifact(params.id!);
    if (!a || !existsSync(a.path)) throw new HermesError('NOT_FOUND', 'Artefact introuvable');
    res.writeHead(200, { 'Content-Type': a.mime ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(a.path).pipe(res);
    return HANDLED;
  });

  // ------------------------------------------------------------- memory
  r.on('GET', '/api/memory', ({ query }) =>
    store.searchMemory({
      text: query.get('search') ?? undefined,
      kind: query.get('kind') ? MemoryKind.parse(query.get('kind')) : undefined,
      limit: 200,
    }),
  );
  r.on('POST', '/api/memory', ({ body }) => {
    const b = z
      .object({
        kind: MemoryKind,
        content: z.string().min(2).max(4000),
        tags: z.array(z.string().max(40)).max(10).default([]),
      })
      .parse(body);
    return store.addMemory({ ...b, origin: 'user', confidence: 1 });
  });
  r.on('PATCH', '/api/memory/:id', ({ params, body }) => {
    const b = z
      .object({
        content: z.string().min(2).max(4000).optional(),
        confidence: z.number().min(0).max(1).nullable().optional(),
        tags: z.array(z.string().max(40)).max(10).optional(),
        kind: MemoryKind.optional(),
      })
      .parse(body);
    return store.updateMemory(params.id!, b);
  });
  r.on('DELETE', '/api/memory', ({ body }) => {
    const { ids } = z.object({ ids: z.array(z.string()).min(1).max(500) }).parse(body);
    const deleted = store.deleteMemory(ids);
    rt.telemetry.record({
      category: 'persistence',
      type: 'memory.deleted',
      message: `${deleted} souvenir(s) supprimé(s) par l'utilisateur`,
    });
    return { deleted };
  });

  return r;
}
