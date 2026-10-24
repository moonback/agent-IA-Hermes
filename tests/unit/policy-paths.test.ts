import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PolicyConfig,
  assertInsideRoots,
  canonicalize,
  evaluatePolicy,
  hostAllowed,
  isWithin,
  type PolicyRequest,
} from '@hermes/core';
import { tempDir } from '../helpers/runtime';

const root = tempDir('hermes-policy-');
const allowed = join(root, 'allowed');
const outside = join(root, 'outside');
mkdirSync(allowed);
mkdirSync(outside);
writeFileSync(join(outside, 'secret.txt'), 'x');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cfg = (over: Partial<PolicyConfig> = {}) =>
  PolicyConfig.parse({ allowedRoots: [allowed], allowedDomains: ['example.com'], ...over });
const req = (over: Partial<PolicyRequest> = {}): PolicyRequest => ({
  toolId: 'files.read',
  toolKnown: true,
  toolAvailable: true,
  allowedAgents: ['files'],
  agent: 'files',
  risk: 'low',
  toolApprovalReason: null,
  resources: {},
  stepTools: ['files.read'],
  halted: false,
  ...over,
});

describe('normalisation des chemins', () => {
  it('canonicalise et compare sans tenir compte de la casse sous Windows', () => {
    expect(isWithin(allowed, join(allowed, 'a', 'b.txt'))).toBe(true);
    expect(isWithin(allowed, outside)).toBe(false);
    expect(isWithin(allowed, `${allowed}-suffix`)).toBe(false);
    expect(isWithin(allowed, join(allowed, '..foo'))).toBe(true);
    if (process.platform === 'win32') expect(isWithin(allowed.toUpperCase(), join(allowed, 'x'))).toBe(true);
  });
  it('refuse la traversée de chemins', () => {
    expect(() => assertInsideRoots(join(allowed, '..', 'outside', 'secret.txt'), [allowed])).toThrow(
      /hors des dossiers/,
    );
    expect(() => assertInsideRoots(`${allowed}\\..\\outside`, [allowed])).toThrow();
  });
  it('refuse chemins relatifs, caractère nul et chemins spéciaux Windows', () => {
    expect(() => canonicalize('relatif.txt')).toThrow(/absolu/);
    expect(() => canonicalize(`${allowed}\0x`)).toThrow();
    if (process.platform === 'win32') {
      expect(() => canonicalize('\\\\?\\C:\\Windows')).toThrow(/périphérique/);
      expect(() => canonicalize('\\\\serveur\\partage\\f.txt')).toThrow(/UNC/);
      expect(() => canonicalize(`${allowed}\\f.txt:flux`)).toThrow(/alternatifs/);
      expect(() => canonicalize(`${allowed}\\NUL`)).toThrow(/réservé/);
    }
  });
  it('résout les jonctions/liens pour empêcher une évasion', () => {
    const link = join(allowed, 'evasion');
    symlinkSync(outside, link, 'junction');
    expect(() => assertInsideRoots(join(link, 'secret.txt'), [allowed])).toThrow(/hors des dossiers/);
  });
});

describe('moteur de politique', () => {
  it('refuse un outil inconnu, désactivé ou indisponible', () => {
    expect(evaluatePolicy(cfg(), req({ toolKnown: false })).effect).toBe('deny');
    expect(evaluatePolicy(cfg({ disabledTools: ['files.read'] }), req()).effect).toBe('deny');
    expect(evaluatePolicy(cfg(), req({ toolAvailable: false })).effect).toBe('deny');
  });
  it('refuse un agent non autorisé ou un outil hors étape', () => {
    expect(evaluatePolicy(cfg(), req({ agent: 'browser' })).effect).toBe('deny');
    expect(evaluatePolicy(cfg(), req({ stepTools: ['files.search'] })).effect).toBe('deny');
  });
  it('refuse tout pendant un arrêt d’urgence', () => {
    expect(evaluatePolicy(cfg(), req({ halted: true })).effect).toBe('deny');
  });
  it('contrôle les chemins', () => {
    expect(
      evaluatePolicy(cfg(), req({ resources: { paths: [{ path: join(allowed, 'a.txt'), access: 'read' }] } }))
        .effect,
    ).toBe('allow');
    expect(
      evaluatePolicy(
        cfg(),
        req({ resources: { paths: [{ path: join(outside, 'secret.txt'), access: 'read' }] } }),
      ).effect,
    ).toBe('deny');
    expect(
      evaluatePolicy(
        cfg({ allowedRoots: [] }),
        req({ resources: { paths: [{ path: join(allowed, 'a'), access: 'read' }] } }),
      ).effect,
    ).toBe('deny');
  });
  it('contrôle les domaines réseau', () => {
    expect(hostAllowed('docs.example.com', ['example.com'])).toBe(true);
    expect(hostAllowed('example.com.evil.net', ['example.com'])).toBe(false);
    expect(hostAllowed('notexample.com', ['example.com'])).toBe(false);
    const url = (u: string) =>
      req({
        toolId: 'browser.navigate',
        allowedAgents: ['browser'],
        agent: 'browser',
        stepTools: null,
        resources: { urls: [u] },
      });
    expect(evaluatePolicy(cfg(), url('https://example.com/a')).effect).toBe('allow');
    expect(evaluatePolicy(cfg(), url('https://unknown.org')).effect).toBe('approval');
    expect(evaluatePolicy(cfg({ unknownDomains: 'deny' }), url('https://unknown.org')).effect).toBe('deny');
    expect(evaluatePolicy(cfg(), url('file:///C:/Windows/win.ini')).effect).toBe('deny');
    expect(evaluatePolicy(cfg(), url('https://user:pass@example.com')).effect).toBe('deny');
  });
  it('contrôle commandes et applications', () => {
    const cmd = (c: string) =>
      req({
        toolId: 'process.run',
        allowedAgents: ['code'],
        agent: 'code',
        stepTools: null,
        resources: { command: c },
      });
    expect(evaluatePolicy(cfg(), cmd('git')).effect).toBe('allow');
    expect(evaluatePolicy(cfg(), cmd('powershell')).effect).toBe('deny');
    const app = (a: string) =>
      req({
        toolId: 'desktop.click',
        allowedAgents: ['computer'],
        agent: 'computer',
        stepTools: null,
        resources: { app: a },
      });
    expect(evaluatePolicy(cfg(), app('notepad')).effect).toBe('approval');
    expect(evaluatePolicy(cfg({ allowedApps: ['Notepad'] }), app('notepad')).effect).toBe('allow');
  });
  it('applique les règles d’approbation sans permettre de lever une ressource non autorisée', () => {
    expect(evaluatePolicy(cfg({ approvalRules: { 'files.read': 'always' } }), req()).effect).toBe('approval');
    expect(evaluatePolicy(cfg(), req({ risk: 'high' })).effect).toBe('approval');
    expect(
      evaluatePolicy(
        cfg({ approvalRules: { 'files.read': 'never' } }),
        req({ risk: 'high', toolApprovalReason: 'x' }),
      ).effect,
    ).toBe('allow');
    const neverButUnknownDomain = req({
      toolId: 'browser.navigate',
      allowedAgents: ['browser'],
      agent: 'browser',
      stepTools: null,
      resources: { urls: ['https://autre.org'] },
    });
    expect(
      evaluatePolicy(cfg({ approvalRules: { 'browser.navigate': 'never' } }), neverButUnknownDomain).effect,
    ).toBe('approval');
  });
});
