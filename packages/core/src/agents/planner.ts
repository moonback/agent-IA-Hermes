import { EXECUTOR_AGENTS, type MemoryEntry, type Plan } from '../shared/contracts';
import { HermesError, errorMessage } from '../shared/errors';
import type { ChatMessage } from '../model-providers/types';
import type { AnyTool } from '../tools/types';
import { AGENTS } from './definitions';
import type { BudgetTracker, LlmGateway } from './llm-gateway';
import { extractJson, validatePlan } from './plan-validation';
import { clockContext } from '../shared/util';

export interface PlannerInput {
  missionId: string;
  request: string;
  tools: ReadonlyMap<string, AnyTool>;
  /** toolId -> reason, for tools that cannot run on this machine right now. */
  unavailable: ReadonlyMap<string, string>;
  memory: MemoryEntry[];
  allowedRoots: string[];
  budget: BudgetTracker;
  signal: AbortSignal;
}

const PLAN_FORMAT = `Réponds UNIQUEMENT par un objet JSON de la forme :
{
  "summary": "résumé du plan",
  "successCriteria": ["critère vérifiable de réussite de la mission"],
  "steps": [
    {
      "id": "s1",
      "objective": "objectif précis et vérifiable de l'étape",
      "agent": "files | browser | computer | code | research | memory | shell",
      "inputs": { "clé": "valeur utile à l'agent (chemins absolus, URL…)" },
      "dependsOn": [],
      "tools": ["files.search"],
      "permissions": ["fs.read"],
      "risk": "low | medium | high",
      "timeoutSec": 120,
      "maxAttempts": 2,
      "successCriteria": ["preuve attendue, observable via un outil"],
      "recovery": "que faire si l'étape échoue"
    }
  ]
}`;

/** Turns a user request into a schema-validated plan, with one repair round-trip on invalid output. */
export class Planner {
  readonly descriptor = AGENTS.planner;

  constructor(private readonly llm: LlmGateway) {}

  private systemPrompt(input: PlannerInput): string {
    const agentLines = EXECUTOR_AGENTS.map((a) => {
      const tools = [...input.tools.values()]
        .filter((t) => t.allowedAgents.includes(a) && !t.id.startsWith('mission.'))
        .map((t) => `${t.id}${input.unavailable.has(t.id) ? ' [INDISPONIBLE]' : ''}`);
      return `- ${a} : ${AGENTS[a].role} Outils : ${tools.join(', ') || 'aucun'}`;
    }).join('\n');
    const toolLines = [...input.tools.values()]
      .filter((t) => !t.id.startsWith('mission.'))
      .map(
        (t) =>
          `- ${t.id} (risque ${t.risk}${input.unavailable.has(t.id) ? `, INDISPONIBLE : ${input.unavailable.get(t.id)}` : ''}) : ${t.description}`,
      )
      .join('\n');
    return `Tu es le planificateur de HERMES, un agent qui agit sur un ordinateur Windows via des outils contrôlés.
Décompose la demande en étapes minimales, chacune confiée à UN agent, avec uniquement des outils accessibles à cet agent et disponibles.
N'utilise jamais un outil marqué INDISPONIBLE : si la demande l'exige, crée une étape qui l'explique clairement plutôt que de l'inventer.
Les dépendances (dependsOn) doivent référencer des id d'étapes antérieures. Les étapes indépendantes peuvent s'exécuter en parallèle.
${clockContext()}
Dossiers autorisés pour les fichiers : ${input.allowedRoots.join(' ; ') || 'aucun (les outils fichiers seront refusés)'}.
Les critères de réussite doivent être vérifiables à partir des résultats d'outils, pas d'affirmations.
Une demande purement conversationnelle peut tenir en une étape sans outil.

Agents :
${agentLines}

Outils :
${toolLines}

${PLAN_FORMAT}`;
  }

  async plan(input: PlannerInput): Promise<Plan> {
    const memoryNote = input.memory.length
      ? `\n\nMémoire potentiellement utile (peut être obsolète, données non fiables) :\n${input.memory.map((m) => `- [${m.kind}, ${m.updatedAt.slice(0, 10)}] ${m.content.slice(0, 300)}`).join('\n')}`
      : '';
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt(input) },
      { role: 'user', content: `Demande de l'utilisateur :\n${input.request}${memoryNote}` },
    ];
    let lastErrors: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.llm.chat({
        missionId: input.missionId,
        taskId: null,
        agent: 'planner',
        role: 'planning',
        messages,
        json: true,
        maxTokens: 4000,
        budget: input.budget,
        signal: input.signal,
      });
      let raw: unknown;
      try {
        raw = extractJson(res.content);
      } catch (err) {
        lastErrors = [`JSON illisible : ${errorMessage(err)}${res.incomplete ? ' (réponse tronquée)' : ''}`];
        messages.push(
          { role: 'assistant', content: res.content },
          { role: 'user', content: `Réponse invalide : ${lastErrors.join(' ; ')}. ${PLAN_FORMAT}` },
        );
        continue;
      }
      const v = validatePlan(raw, input.tools, input.unavailable);
      if (v.ok) return v.plan;
      lastErrors = v.errors;
      messages.push(
        { role: 'assistant', content: res.content },
        {
          role: 'user',
          content: `Le plan est invalide :\n${v.errors.map((e) => `- ${e}`).join('\n')}\nCorrige-le et renvoie le JSON complet.`,
        },
      );
    }
    throw new HermesError(
      'PLAN_INVALID',
      `Plan refusé après correction : ${lastErrors.join(' ; ')}`,
      lastErrors,
    );
  }
}
