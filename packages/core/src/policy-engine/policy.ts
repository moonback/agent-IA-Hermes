import { z } from 'zod';
import type { ExecutorAgentId, RiskLevel } from '../shared/contracts';
import { HermesError, errorMessage } from '../shared/errors';
import { assertInsideRoots } from './paths';

export const ApprovalMode = z.enum(['always', 'auto', 'never']);
export type ApprovalMode = z.infer<typeof ApprovalMode>;

export const PolicyConfig = z.object({
  /** Folders the agents may read/write. Everything else is refused. */
  allowedRoots: z.array(z.string()).default([]),
  /** Web hosts; a host also matches its subdomains. */
  allowedDomains: z.array(z.string()).default([]),
  /** What to do with a host that is not in allowedDomains. */
  unknownDomains: z.enum(['deny', 'ask']).default('ask'),
  /** Executables process.run may start (resolved on PATH; no shell). */
  allowedCommands: z.array(z.string()).default(['node', 'npm', 'git']),
  /** Desktop applications (process names) agents may drive without approval. */
  allowedApps: z.array(z.string()).default([]),
  disabledTools: z.array(z.string()).default([]),
  /** Per-tool override: always ask, never ask, or let the tool decide from its risk (auto). */
  approvalRules: z.record(z.string(), ApprovalMode).default({}),
});
export type PolicyConfig = z.infer<typeof PolicyConfig>;

/** Resources a tool call touches, declared by the tool and checked by the policy — never by the model. */
export interface ResourceClaims {
  paths?: { path: string; access: 'read' | 'write' }[];
  urls?: string[];
  command?: string;
  /** Several commands (shell.pipe): each one must be allowed. */
  commands?: string[];
  app?: string;
}

export interface PolicyRequest {
  toolId: string;
  toolKnown: boolean;
  toolAvailable: boolean;
  allowedAgents: readonly string[];
  agent: ExecutorAgentId | 'orchestrator';
  risk: RiskLevel;
  /** Tool-specific reason to ask a human (sensitive button, overwrite…), null otherwise. */
  toolApprovalReason: string | null;
  resources: ResourceClaims;
  stepTools: readonly string[] | null;
  halted: boolean;
}

export type PolicyDecision =
  | { effect: 'allow'; reasons: string[] }
  | { effect: 'deny'; reasons: string[] }
  | { effect: 'approval'; reasons: string[] };

export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowed.some((d) => {
    const a = d.toLowerCase().trim().replace(/^\*\./, '');
    return a.length > 0 && (h === a || h.endsWith(`.${a}`));
  });
}

/**
 * Centralised, deterministic policy. Model output never reaches this function except as
 * already-validated tool input; prompt content cannot change its configuration.
 */
export function evaluatePolicy(cfg: PolicyConfig, req: PolicyRequest): PolicyDecision {
  const deny = (r: string): PolicyDecision => ({ effect: 'deny', reasons: [r] });
  if (req.halted) return deny("Arrêt d'urgence actif : aucune nouvelle action n'est autorisée");
  if (!req.toolKnown) return deny(`Outil inconnu : ${req.toolId}`);
  if (cfg.disabledTools.includes(req.toolId))
    return deny(`Outil désactivé dans les paramètres : ${req.toolId}`);
  if (!req.toolAvailable) return deny(`Outil indisponible sur ce système : ${req.toolId}`);
  if (req.agent !== 'orchestrator' && !req.allowedAgents.includes(req.agent))
    return deny(`L'agent ${req.agent} n'a pas accès à ${req.toolId}`);
  if (req.stepTools && !req.stepTools.includes(req.toolId))
    return deny(`${req.toolId} ne fait pas partie des outils prévus par l'étape`);

  const askReasons: string[] = [];
  for (const p of req.resources.paths ?? []) {
    try {
      assertInsideRoots(p.path, cfg.allowedRoots);
    } catch (err) {
      if (err instanceof HermesError) return deny(errorMessage(err));
      throw err;
    }
  }
  for (const raw of req.resources.urls ?? []) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return deny(`URL invalide : ${raw}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      return deny(`Protocole interdit : ${url.protocol}`);
    if (url.username || url.password) return deny("Identifiants dans l'URL interdits");
    if (!hostAllowed(url.hostname, cfg.allowedDomains)) {
      if (cfg.unknownDomains === 'deny') return deny(`Domaine non autorisé : ${url.hostname}`);
      askReasons.push(`Accès à un domaine non encore autorisé : ${url.hostname}`);
    }
  }
  for (const c of [
    ...(req.resources.command !== undefined ? [req.resources.command] : []),
    ...(req.resources.commands ?? []),
  ])
    if (!cfg.allowedCommands.includes(c)) return deny(`Commande non autorisée : ${c}`);
  if (
    req.resources.app !== undefined &&
    !cfg.allowedApps.map((a) => a.toLowerCase()).includes(req.resources.app.toLowerCase())
  ) {
    askReasons.push(`Application non encore autorisée : ${req.resources.app}`);
  }

  const mode = cfg.approvalRules[req.toolId] ?? 'auto';
  if (mode === 'always') askReasons.push('Règle : approbation systématique pour cet outil');
  if (mode !== 'never') {
    if (req.toolApprovalReason) askReasons.push(req.toolApprovalReason);
    if (req.risk === 'high') askReasons.push('Action à risque élevé');
  }
  // Resource-based reasons (unknown domain/app) cannot be waived by a 'never' rule.
  return askReasons.length
    ? { effect: 'approval', reasons: askReasons }
    : { effect: 'allow', reasons: ['Conforme à la politique'] };
}
