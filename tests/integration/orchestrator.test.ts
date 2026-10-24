// Orchestrator ↔ agents ↔ tools with a SIMULATED model: proves the coordination logic, not model quality.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestRuntime,
  filesPlan,
  waitForEvent,
  waitForMissionStatus,
  type TestRuntime,
} from '../helpers/runtime';

let t: TestRuntime | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

const planned = async (rt: TestRuntime['rt'], request: string) => {
  const m = rt.orchestrator.createMission(request);
  return waitForMissionStatus(rt, m.id, ['planned', 'failed']);
};

describe('orchestrateur multi-agents', () => {
  it('planifie, exécute avec un vrai outil, vérifie et termine', async () => {
    t = await createTestRuntime((ws) => ({
      plan: filesPlan(join(ws, 'rapport.txt')),
      agent: [
        { call: { name: 'files.write', args: { path: join(ws, 'rapport.txt'), content: 'Bonjour' } } },
        { complete: { summary: 'Fichier écrit et relu' } },
      ],
    }));
    const m = await planned(t.rt, 'Écris un rapport');
    expect({ status: m.status, error: m.error }).toEqual({ status: 'planned', error: null });
    expect(m.plan?.steps).toHaveLength(1);
    t.rt.orchestrator.start(m.id);
    const done = await waitForMissionStatus(t.rt, m.id, ['completed', 'failed']);
    expect(done.status).toBe('completed');
    expect(readFileSync(join(t.workspace, 'rapport.txt'), 'utf8')).toBe('Bonjour');
    expect(done.result?.verification?.verdict).toBe('pass');
    expect(done.usage.aiCalls).toBeGreaterThanOrEqual(5); // plan + agent×2 + task verification + mission verification
    expect(t.rt.store.listTasks(m.id)[0]!.result?.evidence[0]?.verified).toBe(true);
    expect(t.rt.store.searchMemory({ kind: 'mission_summary' })).toHaveLength(1);
    const runs = t.rt.store.agentStats();
    expect(runs.find((r) => r.agent === 'files')?.runs).toBe(1);
  });

  it('le vérificateur refuse une réussite non prouvée (aucun appel d’outil)', async () => {
    t = await createTestRuntime((ws) => ({
      plan: filesPlan(join(ws, 'x.txt'), { maxAttempts: 2 }),
      agent: [{ complete: { summary: "J'ai écrit le fichier." } }],
    }));
    const m = await planned(t.rt, 'Écris un fichier');
    t.rt.orchestrator.start(m.id);
    const done = await waitForMissionStatus(t.rt, m.id, ['completed', 'failed']);
    expect(done.status).toBe('failed');
    const task = t.rt.store.listTasks(m.id)[0]!;
    expect(task.status).toBe('failed');
    expect(task.attempts).toBe(2); // a targeted retry happened, then the claim was refused again
    expect(task.error).toMatch(/n'est pas prouvée/);
  });

  it('le vérificateur (modèle) peut refuser malgré des appels réussis', async () => {
    t = await createTestRuntime((ws) => ({
      plan: filesPlan(join(ws, 'y.txt'), { maxAttempts: 1 }),
      agent: [
        { call: { name: 'files.write', args: { path: join(ws, 'y.txt'), content: 'incomplet' } } },
        { complete: { summary: 'Rapport complet' } },
      ],
      verdict: (body) =>
        JSON.stringify(body).includes('Demande initiale')
          ? { verdict: 'fail', reasons: ['mission non conforme'] }
          : { verdict: 'partial', reasons: ['contenu incomplet'] },
    }));
    const m = await planned(t.rt, 'Rapport');
    t.rt.orchestrator.start(m.id);
    const done = await waitForMissionStatus(t.rt, m.id, ['completed', 'failed']);
    expect(done.status).toBe('failed');
    expect(t.rt.store.listTasks(m.id)[0]!.error).toMatch(/partial/);
  });

  it('un plan invalide est refusé après une tentative de correction', async () => {
    t = await createTestRuntime({
      plan: {
        summary: 'plan invalide',
        successCriteria: ['y y y'],
        steps: [
          { id: 's1', objective: 'rien', agent: 'files', tools: ['shell.exec'], successCriteria: ['z z z'] },
        ],
      },
    });
    const m = await planned(t.rt, 'demande');
    expect(m.status).toBe('failed');
    expect(m.error).toMatch(/outil inconnu shell.exec/);
    expect(t.calls.filter((c) => JSON.stringify(c.body ?? '').includes('planificateur'))).toHaveLength(2);
  });

  it('les étapes dépendantes sont bloquées si une dépendance échoue', async () => {
    t = await createTestRuntime((ws) => {
      const plan = filesPlan(join(ws, 'x.txt'), { maxAttempts: 1 });
      plan.steps.push({ ...plan.steps[0]!, id: 's2', dependsOn: ['s1'] });
      return { plan, agent: [{ complete: { summary: 'rien fait' } }] };
    });
    const m = await planned(t.rt, 'deux étapes');
    t.rt.orchestrator.start(m.id);
    await waitForMissionStatus(t.rt, m.id, ['completed', 'failed']);
    const [s1, s2] = t.rt.store.listTasks(m.id);
    expect(s1!.status).toBe('failed');
    expect(s2).toMatchObject({ status: 'blocked', blockReason: 'dependency_failed' });
  });

  it('exécute en parallèle les étapes indépendantes', async () => {
    t = await createTestRuntime((ws) => {
      const plan = filesPlan(join(ws, 'p.txt'), { tools: ['files.search'] });
      plan.steps.push({ ...plan.steps[0]!, id: 's2' });
      return {
        plan,
        agent: (_b, turn) =>
          turn === 0
            ? { call: { name: 'files.search', args: { root: ws } } }
            : { complete: { summary: 'recherche faite' } },
      };
    });
    const m = await planned(t.rt, 'parallèle');
    expect({ status: m.status, error: m.error }).toEqual({ status: 'planned', error: null });
    const starts: number[] = [];
    t.rt.telemetry.on('event', (e) => e.type === 'task.started' && starts.push(Date.now()));
    t.rt.orchestrator.start(m.id);
    expect((await waitForMissionStatus(t.rt, m.id, ['completed', 'failed'])).status).toBe('completed');
    expect(starts).toHaveLength(2);
    // Both independent steps were started before either finished.
    const firstEnd = t.rt.store
      .listTasks(m.id)
      .map((x) => Date.parse(x.endedAt!))
      .sort()[0]!;
    expect(Math.max(...starts)).toBeLessThanOrEqual(firstEnd + 5);
  });

  it('annulation d’une mission en attente d’approbation', async () => {
    t = await createTestRuntime((ws) => {
      const p = filesPlan(join(ws, 'a.txt'));
      p.steps[0] = { ...p.steps[0]!, tools: ['files.move'], objective: 'Déplacer a.txt' };
      return {
        plan: p,
        agent: [
          {
            call: {
              name: 'files.move',
              args: { moves: [{ from: join(ws, 'a.txt'), to: join(ws, 'b.txt') }] },
            },
          },
        ],
      };
    });
    const from = join(t.workspace, 'a.txt');
    writeFileSync(from, 'x');
    const m = await planned(t.rt, 'déplacer');
    t.rt.orchestrator.start(m.id);
    await waitForEvent(t.rt, (e) => e.type === 'approval.requested');
    expect(t.rt.store.listTasks(m.id)[0]!.status).toBe('waiting_approval');
    t.rt.orchestrator.cancel(m.id, 'test');
    await t.rt.orchestrator.idle(m.id);
    expect(t.rt.store.requireMission(m.id).status).toBe('cancelled');
    expect(t.rt.store.listTasks(m.id)[0]!.status).toBe('cancelled');
    expect(t.rt.store.listApprovals({ missionId: m.id })[0]!.status).toBe('expired');
    expect(existsSync(from)).toBe(true);
  });

  it('approbation accordée : l’action s’exécute et la mission se termine', async () => {
    t = await createTestRuntime((ws) => {
      const p = filesPlan(join(ws, 'c.txt'));
      p.steps[0] = { ...p.steps[0]!, tools: ['files.move'], objective: 'Déplacer c.txt' };
      return {
        plan: p,
        agent: [
          {
            call: {
              name: 'files.move',
              args: { moves: [{ from: join(ws, 'c.txt'), to: join(ws, 'rangé', 'c.txt') }] },
            },
          },
          { complete: { summary: 'déplacé' } },
        ],
      };
    });
    writeFileSync(join(t.workspace, 'c.txt'), 'x');
    const m = await planned(t.rt, 'déplacer');
    t.rt.orchestrator.start(m.id);
    const ev = await waitForEvent(t.rt, (e) => e.type === 'approval.requested');
    t.rt.approvals.decide((ev.data as { approvalId: string }).approvalId, 'approved');
    expect((await waitForMissionStatus(t.rt, m.id, ['completed', 'failed'])).status).toBe('completed');
    expect(existsSync(join(t.workspace, 'rangé', 'c.txt'))).toBe(true);
  });

  it('dépassement de budget : arrêt de la mission', async () => {
    t = await createTestRuntime((ws) => ({ plan: filesPlan(join(ws, 'x.txt')), usageCost: 0.6 }));
    t.rt.settings.setBudget({ ...t.rt.settings.budget(), maxCostUsd: 1 });
    const m = await planned(t.rt, 'chère');
    t.rt.orchestrator.start(m.id);
    const done = await waitForMissionStatus(t.rt, m.id, ['completed', 'failed']);
    expect(done.status).toBe('failed');
    expect(`${done.error} ${done.result?.summary}`).toMatch(/Budget/);
  });

  it('pause puis reprise', async () => {
    t = await createTestRuntime((ws) => ({
      plan: filesPlan(join(ws, 'z.txt')),
      agent: [
        { call: { name: 'files.write', args: { path: join(ws, 'z.txt'), content: 'z' } } },
        { complete: { summary: 'ok' } },
      ],
    }));
    const m = await planned(t.rt, 'pause');
    t.rt.orchestrator.start(m.id);
    t.rt.orchestrator.pause(m.id, 'test');
    expect((await waitForMissionStatus(t.rt, m.id, ['paused', 'completed'])).status).toBe('paused');
    t.rt.orchestrator.start(m.id);
    expect((await waitForMissionStatus(t.rt, m.id, ['completed', 'failed'])).status).toBe('completed');
  });

  it('reprise après interruption : aucune action externe rejouée sans confirmation', async () => {
    t = await createTestRuntime((ws) => ({
      plan: filesPlan(join(ws, 'x.txt')),
      agent: [{ complete: { summary: 'vérifié manuellement' } }],
    }));
    const m = await planned(t.rt, 'interrompue');
    const store = t.rt.store;
    const task = store.listTasks(m.id)[0]!;
    // Simulates a crash in the middle of a non-idempotent action.
    store.setMissionStatus(m.id, 'running');
    store.setTaskStatus(task.id, 'ready');
    store.setTaskStatus(task.id, 'running', { incrementAttempt: true });
    store.startToolCall({
      missionId: m.id,
      taskId: task.id,
      agent: 'files',
      toolId: 'files.write',
      input: {},
      inputHash: 'h',
      idempotencyKey: 'k',
      policyDecision: 'allow',
      approvalId: null,
    });
    expect(t.rt.orchestrator.recoverOnStartup().interrupted).toEqual([m.id]);
    expect(store.requireMission(m.id).status).toBe('interrupted');
    expect(store.requireTask(task.id)).toMatchObject({ status: 'blocked', blockReason: 'uncertain_effect' });
    // Resuming without confirmation keeps the uncertain step blocked.
    t.rt.orchestrator.start(m.id);
    expect((await waitForMissionStatus(t.rt, m.id, ['paused'])).status).toBe('paused');
    expect(store.requireTask(task.id).status).toBe('blocked');
    // With explicit confirmation the step runs again.
    t.rt.orchestrator.start(m.id, { confirmUncertainTaskIds: [task.id] });
    await waitForMissionStatus(t.rt, m.id, ['completed', 'failed']);
    expect(store.listToolCalls({ taskId: task.id }).find((c) => c.inputHash === 'h')?.status).toBe(
      'abandoned',
    );
  });

  it('arrêt d’urgence : bloque les nouvelles actions jusqu’au réarmement', async () => {
    t = await createTestRuntime((ws) => ({ plan: filesPlan(join(ws, 'x.txt')) }));
    const m = await planned(t.rt, 'urgence');
    await t.rt.orchestrator.emergencyStop();
    expect(() => t!.rt.orchestrator.start(m.id)).toThrow(/urgence/);
    expect(() => t!.rt.orchestrator.createMission('nouvelle')).toThrow(/urgence/);
    t.rt.orchestrator.rearm();
    t.rt.orchestrator.start(m.id);
    await waitForMissionStatus(t.rt, m.id, ['completed', 'failed']);
  });
});

// Regressions found during the first REAL run with openai/gpt-6-luna (24/10/2026), replayed with the simulation.
describe('régressions observées en exécution réelle', () => {
  it('une réussite obtenue lors d’une tentative précédente reste une preuve ; une négation n’est pas une affirmation', async () => {
    let taskVerifications = 0;
    t = await createTestRuntime((ws) => ({
      plan: filesPlan(join(ws, 'test.md'), { tools: ['files.write', 'files.search'] }),
      // Attempt 1 writes the file; attempt 2 only checks it and says it did not modify it.
      agent: (body, turn) => {
        const retry = JSON.stringify(body.messages[1]?.content).includes('"tentative\\": 2');
        if (!retry && turn === 0)
          return { call: { name: 'files.write', args: { path: join(ws, 'test.md'), content: '# Test' } } };
        if (retry && turn === 0)
          return { call: { name: 'files.search', args: { root: ws, pattern: 'test.md' } } };
        return {
          complete: {
            summary: retry
              ? "Le fichier existe déjà ; je n'ai pas modifié le fichier existant."
              : 'Fichier créé.',
          },
        };
      },
      verdict: (body) => {
        const text = JSON.stringify(body);
        if (text.includes('Demande initiale')) return { verdict: 'pass', reasons: ['mission conforme'] };
        taskVerifications++;
        // First review: partial (as observed); second: pass only if the earlier write is visible as evidence.
        if (taskVerifications === 1) return { verdict: 'partial', reasons: ['date non vérifiable'] };
        return text.includes('files.write') && text.includes('tentativePrecedente\\":true')
          ? { verdict: 'pass', reasons: ['écriture de la tentative 1 prouvée'] }
          : { verdict: 'fail', reasons: ['preuve de la tentative 1 absente'] };
      },
    }));
    const m = await planned(t.rt, 'Crée test.md');
    t.rt.orchestrator.start(m.id);
    const done = await waitForMissionStatus(t.rt, m.id, ['completed', 'failed']);
    expect({ status: done.status, error: done.error }).toEqual({ status: 'completed', error: null });
    expect(t.rt.store.listTasks(m.id)[0]!.attempts).toBe(2);
  });

  it('la vérification finale reçoit les sorties réelles des outils (URL des sources)', async () => {
    t = await createTestRuntime((ws) => ({
      plan: filesPlan(join(ws, 'r.md')),
      agent: [
        {
          call: {
            name: 'files.write',
            args: { path: join(ws, 'r.md'), content: 'Source : https://source.example/prix' },
          },
        },
        { complete: { summary: 'rapport écrit' } },
      ],
      verdict: (body) => {
        const text = JSON.stringify(body);
        if (!text.includes('Demande initiale')) return { verdict: 'pass', reasons: ['étape prouvée'] };
        return text.includes('r.md') &&
          text.includes('sha256') &&
          text.includes('https://source.example/prix')
          ? { verdict: 'pass', reasons: ['sorties visibles'] }
          : { verdict: 'fail', reasons: ['aucune sortie réelle transmise'] };
      },
    }));
    const m = await planned(t.rt, 'rapport');
    t.rt.orchestrator.start(m.id);
    expect((await waitForMissionStatus(t.rt, m.id, ['completed', 'failed'])).status).toBe('completed');
  });

  it('la date locale fiable est fournie au planificateur, aux agents et au vérificateur', async () => {
    t = await createTestRuntime((ws) => ({
      plan: filesPlan(join(ws, 'd.md')),
      agent: [
        { call: { name: 'files.write', args: { path: join(ws, 'd.md'), content: 'x' } } },
        { complete: { summary: 'ok' } },
      ],
    }));
    const m = await planned(t.rt, 'date');
    t.rt.orchestrator.start(m.id);
    await waitForMissionStatus(t.rt, m.id, ['completed', 'failed']);
    const today = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const chats = t.calls
      .filter((c) => c.url.endsWith('/chat/completions'))
      .map((c) => JSON.stringify(c.body));
    for (const role of ['planificateur', "Tu es l'agent fichiers", 'vérificateur']) {
      expect(chats.find((c) => c.includes(role))).toContain(`Date locale du système (fiable) : ${today}`);
    }
  });
});
