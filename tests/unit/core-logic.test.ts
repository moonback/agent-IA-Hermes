import { describe, expect, it } from 'vitest';
import {
  BudgetTracker,
  MissionBudget,
  MissionUsage,
  canTransitionMission,
  canTransitionTask,
  assertTaskTransition,
  extractJson,
  globToRegExp,
  hashInput,
  isSafeCommand,
  redact,
  redactString,
  registerSecret,
  validateCommand,
  validatePlan,
  createToolRegistry,
} from '@hermes/core';

describe('machine à états', () => {
  it('autorise les transitions de tâche prévues', () => {
    expect(canTransitionTask('pending', 'ready')).toBe(true);
    expect(canTransitionTask('ready', 'running')).toBe(true);
    expect(canTransitionTask('running', 'waiting_approval')).toBe(true);
    expect(canTransitionTask('waiting_approval', 'running')).toBe(true);
    expect(canTransitionTask('failed', 'ready')).toBe(true);
    expect(canTransitionTask('blocked', 'ready')).toBe(true);
  });
  it('refuse les transitions invalides', () => {
    expect(canTransitionTask('completed', 'running')).toBe(false);
    expect(canTransitionTask('cancelled', 'ready')).toBe(false);
    expect(canTransitionTask('pending', 'completed')).toBe(false);
    expect(() => assertTaskTransition('completed', 'failed')).toThrow(/refusée/);
  });
  it('gère les transitions de mission', () => {
    expect(canTransitionMission('planning', 'planned')).toBe(true);
    expect(canTransitionMission('interrupted', 'running')).toBe(true);
    expect(canTransitionMission('completed', 'running')).toBe(false);
    expect(canTransitionMission('cancelled', 'running')).toBe(false);
  });
});

const tools = createToolRegistry();
const step = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  objective: 'Chercher des fichiers',
  agent: 'files',
  tools: ['files.search'],
  successCriteria: ['liste obtenue'],
  ...over,
});
const plan = (steps: unknown[]) => ({ summary: 'plan de test', successCriteria: ['ok final'], steps });

describe('validation des plans', () => {
  it('accepte un plan valide et applique les valeurs par défaut', () => {
    const r = validatePlan(plan([step(), step({ id: 's2', dependsOn: ['s1'] })]), tools, new Map());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.steps[0]!.timeoutSec).toBe(120);
  });
  it('refuse un schéma invalide (champ inconnu, agent inconnu)', () => {
    expect(validatePlan(plan([step({ agent: 'hacker' })]), tools, new Map()).ok).toBe(false);
    expect(validatePlan(plan([step({ shell: 'rm -rf /' })]), tools, new Map()).ok).toBe(false);
  });
  it('détecte doublons, dépendances inconnues et cycles', () => {
    const dup = validatePlan(plan([step(), step()]), tools, new Map());
    expect(!dup.ok && dup.errors.join()).toMatch(/dupliqué/);
    const unknown = validatePlan(plan([step({ dependsOn: ['zz'] })]), tools, new Map());
    expect(!unknown.ok && unknown.errors.join()).toMatch(/inconnue/);
    const cycle = validatePlan(
      plan([step({ dependsOn: ['s2'] }), step({ id: 's2', dependsOn: ['s1'] })]),
      tools,
      new Map(),
    );
    expect(!cycle.ok && cycle.errors.join()).toMatch(/circulaires/);
  });
  it('refuse les outils inconnus, non autorisés pour l’agent ou indisponibles', () => {
    expect(validatePlan(plan([step({ tools: ['system.format_disk'] })]), tools, new Map()).ok).toBe(false);
    const wrongAgent = validatePlan(plan([step({ tools: ['process.run'] })]), tools, new Map());
    expect(!wrongAgent.ok && wrongAgent.errors.join()).toMatch(/n'a pas accès/);
    const unavailable = validatePlan(
      plan([step({ agent: 'research', tools: ['web.search'] })]),
      tools,
      new Map([['web.search', 'non configuré']]),
    );
    expect(!unavailable.ok && unavailable.errors.join()).toMatch(/indisponible/);
  });
  it('extrait le JSON d’une réponse de modèle', () => {
    expect(extractJson('Voici :\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('blabla {"b":2} fin')).toEqual({ b: 2 });
    expect(() => extractJson('pas de json')).toThrow();
  });
});

describe('budget de mission', () => {
  const make = (b: Partial<MissionBudget>, startedAgoMs = 0) =>
    new BudgetTracker(
      MissionBudget.parse(b),
      MissionUsage.parse({}),
      Date.now() - startedAgoMs,
      () => undefined,
    );
  it('limite les appels IA, le coût, les outils et la durée', () => {
    const t = make({ maxAiCalls: 1, maxCostUsd: 1 });
    t.checkAi();
    t.addAi({ usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.5 } }, 0.5);
    expect(() => t.checkAi()).toThrow(/appels IA/);
    const c = make({ maxCostUsd: 0.1 });
    c.addAi({ usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.2 } }, 0.2);
    expect(() => c.checkAi()).toThrow(/coût/);
    const tl = make({ maxToolCalls: 1 });
    tl.addTool();
    expect(() => tl.checkTool()).toThrow(/outils/);
    expect(() => make({ maxDurationSec: 10 }, 11_000).checkAi()).toThrow(/Durée/);
  });
  it('signale un coût inconnu', () => {
    const t = make({});
    t.addAi({ usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: null } }, null);
    expect(t.usage.costKnown).toBe(false);
  });
});

describe('masquage des secrets', () => {
  it('masque clés, jetons et champs sensibles', () => {
    expect(redactString('clé sk-or-v1-abcdefabcdefabcdefabcdef1234 fin')).not.toContain('abcdefabcdef');
    expect(redactString('Authorization: Bearer abcdefghijklmnop')).toContain('[REDACTED]');
    expect(redactString('password=hunter22')).toContain('[REDACTED]');
    expect(redact({ apiKey: 'x', nested: { token: 'y', ok: 'visible' } })).toEqual({
      apiKey: '[REDACTED]',
      nested: { token: '[REDACTED]', ok: 'visible' },
    });
  });
  it('masque une valeur secrète enregistrée partout où elle apparaît', () => {
    registerSecret('custom-secret-value-123');
    expect(redactString('erreur avec custom-secret-value-123 dedans')).toBe('erreur avec [REDACTED] dedans');
  });
});

describe('arguments et utilitaires', () => {
  it('hash stable indépendant de l’ordre des clés', () => {
    expect(hashInput('t', { a: 1, b: 2 })).toBe(hashInput('t', { b: 2, a: 1 }));
    expect(hashInput('t', { a: 1 })).not.toBe(hashInput('t', { a: 2 }));
  });
  it('convertit les globs', () => {
    expect(globToRegExp('**/*.pdf').test('docs/2024/a.pdf')).toBe(true);
    expect(globToRegExp('*.pdf').test('docs/a.pdf')).toBe(false);
    expect(globToRegExp('rapport-?.md').test('rapport-1.md')).toBe(true);
  });
  it('refuse les arguments de commande dangereux', () => {
    expect(() => validateCommand('git', ['-c', 'core.sshCommand=calc', 'fetch'])).toThrow(/arbitraire/);
    expect(() => validateCommand('git', ['--upload-pack=evil'])).toThrow();
    expect(() => validateCommand('node', ['a\nb'])).toThrow(/contrôle/);
    expect(() => validateCommand('npm', ['--script-shell=cmd', 'test'])).toThrow();
    expect(() => validateCommand('git', ['status'])).not.toThrow();
  });
  it('classe les commandes en lecture seule', () => {
    expect(isSafeCommand('git', ['status'])).toBe(true);
    expect(isSafeCommand('npm', ['test'])).toBe(true);
    expect(isSafeCommand('git', ['push'])).toBe(false);
    expect(isSafeCommand('git', ['branch', '-D', 'main'])).toBe(false);
    expect(isSafeCommand('node', ['-e', 'process.exit()'])).toBe(false);
  });
});
