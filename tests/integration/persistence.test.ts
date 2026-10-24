import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { HermesStore, MissionBudget, Plan } from '@hermes/core';
import { tempDir } from '../helpers/runtime';

const dir = tempDir('hermes-db-');
const store = new HermesStore(join(dir, 'h.db'));
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const plan = Plan.parse({
  summary: 'plan de test',
  successCriteria: ['ok final'],
  steps: [
    { id: 'a', objective: 'étape a', agent: 'files', successCriteria: ['a ok'] },
    { id: 'b', objective: 'étape b', agent: 'files', dependsOn: ['a'], successCriteria: ['b ok'] },
  ],
});

describe('persistance SQLite', () => {
  it('applique les migrations versionnées une seule fois', () => {
    expect(store.schemaVersion()).toBe(1);
    const again = new HermesStore(join(dir, 'h.db'));
    expect(again.schemaVersion()).toBe(1);
    again.close();
  });

  it('crée missions, tâches et dépendances de façon transactionnelle', () => {
    const m = store.createMission('demande', MissionBudget.parse({}));
    store.createTasks(m.id, plan);
    const tasks = store.listTasks(m.id);
    expect(tasks.map((t) => t.stepId)).toEqual(['a', 'b']);
    expect(tasks[1]!.dependsOn).toEqual([tasks[0]!.id]);
    expect(() => store.createTasks(m.id, plan)).toThrow(); // UNIQUE(mission, step) → rollback
    expect(store.listTasks(m.id)).toHaveLength(2);
  });

  it('refuse les transitions invalides en base', () => {
    const m = store.createMission('x', MissionBudget.parse({}));
    expect(() => store.setMissionStatus(m.id, 'completed')).toThrow(/refusée/);
    store.setMissionStatus(m.id, 'planned');
    store.setMissionStatus(m.id, 'running');
    expect(store.requireMission(m.id).startedAt).not.toBeNull();
  });

  it('journal d’audit en ajout seul, chaîné, masqué et vérifiable', () => {
    store.appendEvent({ category: 'application', type: 't1', message: 'un' });
    store.appendEvent({
      category: 'security',
      type: 't2',
      message: 'deux',
      data: { apiKey: 'sk-or-v1-secretsecretsecretsecret', note: 'Bearer abcdefghijklmnopq' },
    });
    expect(() => store.db.exec(`UPDATE mission_events SET message = 'x'`)).toThrow(/ajout seul/);
    expect(() => store.db.exec(`DELETE FROM mission_events`)).toThrow(/interdite/);
    expect(store.verifyAuditChain().ok).toBe(true);
    const last = store.listEvents({ limit: 1 })[0]!;
    expect(JSON.stringify(last.data)).not.toMatch(/secretsecret|abcdefghijklmnopq/);
  });

  it('détecte une falsification effectuée hors de HERMES', () => {
    const path = join(dir, 'tamper.db');
    const s = new HermesStore(path);
    s.appendEvent({ category: 'application', type: 'a', message: 'original' });
    s.appendEvent({ category: 'application', type: 'b', message: 'suivant' });
    s.close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP TRIGGER mission_events_no_update');
    raw.exec(`UPDATE mission_events SET message = 'modifié' WHERE type = 'a'`);
    raw.close();
    const s2 = new HermesStore(path);
    expect(s2.verifyAuditChain()).toMatchObject({ ok: false, brokenAtSeq: 1 });
    s2.close();
  });

  it('purge explicite journalisée qui conserve une chaîne vérifiable', () => {
    const m = store.createMission('ancienne', MissionBudget.parse({}));
    store.setMissionStatus(m.id, 'cancelled');
    store.appendEvent({
      missionId: m.id,
      category: 'orchestration',
      type: 'x',
      message: 'événement de la mission',
    });
    store.appendEvent({ category: 'application', type: 'y', message: 'autre' });
    const r = store.purgeHistory(new Date(Date.now() + 60_000).toISOString());
    expect(r.missions).toBeGreaterThanOrEqual(1);
    expect(store.getMission(m.id)).toBeNull();
    expect(store.listEvents({ limit: 1 })[0]!.type).toBe('history.purged');
    expect(store.verifyAuditChain().ok).toBe(true);
  });

  it('approbation liée à un outil et une entrée précis, consommable une seule fois', () => {
    const m = store.createMission('appro', MissionBudget.parse({}));
    const a = store.createApproval({
      missionId: m.id,
      taskId: null,
      toolId: 'files.move',
      inputHash: 'h1',
      input: {},
      description: 'd',
      consequences: 'c',
    });
    expect(() => store.consumeApproval(a.id, 'files.move', 'h1')).toThrow(/ne correspond pas/); // still pending
    store.decideApproval(a.id, 'approved');
    expect(() => store.consumeApproval(a.id, 'files.move', 'AUTRE')).toThrow(/ne correspond pas/);
    expect(() => store.consumeApproval(a.id, 'files.write', 'h1')).toThrow(/ne correspond pas/);
    store.consumeApproval(a.id, 'files.move', 'h1');
    expect(() => store.consumeApproval(a.id, 'files.move', 'h1')).toThrow(/déjà été utilisée/);
    expect(() => store.decideApproval(a.id, 'approved')).toThrow(/déjà traitée/);
  });

  it('mémoire : ajout masqué, recherche, modification, suppression', () => {
    const e = store.addMemory({
      kind: 'preference',
      content: 'Rapports en Markdown, token=abcd1234secret',
      origin: 'user',
    });
    expect(e.content).not.toContain('abcd1234secret');
    expect(store.searchMemory({ text: 'rapports markdown' }).some((x) => x.id === e.id)).toBe(true);
    expect(store.updateMemory(e.id, { confidence: 0.2 }).confidence).toBe(0.2);
    expect(store.deleteMemory([e.id])).toBe(1);
  });

  it('sauvegarde cohérente de la base', () => {
    const target = store.backup(join(dir, 'backup', 'copy.db'));
    const b = new HermesStore(target);
    expect(b.listMissions().length).toBeGreaterThan(0);
    b.close();
    expect(() => store.backup(target)).toThrow(/existe déjà/);
  });
});
