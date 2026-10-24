# Architecture

## Vue d'ensemble

```
┌────────────── Tauri (Rust) ──────────────┐
│ fenêtre WebView2 ── React (9 pages)       │
│ sidecar.rs : lance `node` + jeton aléatoire│
└──────────────┬───────────────────────────┘
               │ HTTP + SSE, 127.0.0.1:port aléatoire, Bearer <jeton>
┌──────────────▼──────────── service local Node (apps/server) ─────────────────┐
│ Orchestrateur ─► Planificateur ─► plan Zod validé ─► tâches (DAG, SQLite)    │
│      ├─► Agents exécutants (fichiers, navigateur, ordinateur, code,           │
│      │    recherche, mémoire) : boucle observe → appel d'outil → résultat      │
│      │          ▼                                                             │
│      │   ToolExecutor : schéma → politique → approbation liée → anti-doublon  │
│      │                 → délai → validation de sortie → post-condition → audit│
│      │          ├─ fichiers / process (enfant sans shell)                     │
│      │          ├─ Playwright Chromium (contexte isolé par mission)           │
│      │          └─ worker PowerShell UI Automation (processus par appel)      │
│      └─► Vérificateur indépendant (contrôles déterministes + modèle)          │
│ LlmGateway ─► fournisseur par rôle : OpenRouterProvider ─► openrouter.ai      │
│                                      GeminiProvider ─► generativelanguage /   │
│                                                        aiplatform.googleapis  │
│ AudioBridge (voix) ─► GeminiLiveProvider ─► wss BidiGenerateContent           │
│      └─► VoiceAgent ─► orchestrateur (jamais d'outil exécuté directement)     │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Choix techniques

- **Un paquet `@hermes/core` découpé en dossiers** (shared, persistence, policy-engine, tools, agents, orchestrator…) plutôt qu'une dizaine de paquets : même séparation des responsabilités, sans paquets vides ni étapes de build supplémentaires. L'interface importe uniquement `@hermes/core/contracts` (Zod, sans Node). `execution-runtime` correspond à `tools/executor.ts` ; `workers/` contient le worker bureau, le navigateur tourne dans le processus Chromium de Playwright, les commandes dans des processus enfants.
- **Service Node séparé du shell Rust** : orchestration IA, Playwright et SQLite en TypeScript ; Rust gère le cycle de vie du service et le jeton. Le service s'arrête si l'application se ferme (stdin fermé).
- **SQLite intégré à Node (`node:sqlite`)** : aucune dépendance native à compiler.
- **Coffre de secrets** : `@napi-rs/keyring` (Gestionnaire d'identification Windows, service « HERMES »). `OPENROUTER_API_KEY` reste prioritaire en développement.
- **Pas de TanStack Query** : `useResource` recharge les données quand un événement persistant arrive (SSE).
- **Composants maison** (Tailwind + lucide) accessibles au clavier, sur un design system à jetons CSS et trois thèmes (Glass Dark, Glass Light, Glass Cyberpunk) : voir [UI_GLASS_IMPLEMENTATION.md](UI_GLASS_IMPLEMENTATION.md).

## Agents

| Agent         | Rôle                                                                                                 | Outils                                |
| ------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------- |
| orchestrateur | crée la mission, ordonne le DAG, budgets, pause/reprise/annulation, consolidation                    | —                                     |
| planificateur | plan JSON validé (schéma + dépendances, cycles, outils autorisés et disponibles), 1 correction       | —                                     |
| ordinateur    | bureau Windows par UI Automation                                                                     | screen.observe, desktop.*             |
| fichiers      | recherche, lecture, écriture, déplacement                                                            | files.*                               |
| navigateur    | pages Web par locators accessibles                                                                   | browser.*                             |
| code          | lecture, modification, commandes                                                                     | files.*, process.run                  |
| recherche     | recherche Web réelle, sources                                                                        | web.search, browser.navigate/extract  |
| mémoire       | consulter / proposer des souvenirs                                                                   | memory.*                              |
| vérificateur  | refuse toute réussite non prouvée                                                                    | —                                     |
| vocal         | conversation Gemini Live ; crée, lance (après confirmation orale), met en pause, annule des missions | outils de contrôle de l'orchestrateur |

Chaque agent exécutant suit la même interface (`Agent.execute`) : boucle bornée (itérations, appels d'outils), prompt de rôle, outil de fin `task__complete`. Les résultats d'outils sont transmis au modèle comme **données non fiables**. Les outils `mission.pause`, `mission.cancel`, `mission.verify` sont toujours accessibles.

## Missions et états

Mission : `planning → planned → running ⇄ paused`, `running → interrupted` (redémarrage, arrêt d'urgence), terminaux `completed | failed | cancelled`.
Tâche : `pending → ready → running ⇄ waiting_approval → completed | failed | blocked | cancelled`, `failed → ready` (nouvelle tentative, avec temporisation progressive et le retour du vérificateur). Toute autre transition est refusée.

Parallélisme : uniquement entre tâches prêtes (dépendances terminées), limité par `maxParallelTasks` ; navigateur et ordinateur jamais en parallèle.

Reprise : au démarrage, les missions `running` passent `interrupted`. Une tâche interrompue pendant une action non idempotente devient `blocked (uncertain_effect)` et ne reprend qu'après confirmation explicite. Une action non idempotente déjà réussie n'est jamais rejouée (clé d'idempotence ; résultat réutilisé et tracé « dédoublonné »).

## Données (SQLite, `%APPDATA%\hermes\hermes.db`)

missions, tasks, task_dependencies, agent_runs, tool_calls, approvals, mission_events (ajout seul, chaînage SHA-256), artifacts, memory_entries, provider_settings, model_assignments, app_settings, schema_migrations. Sauvegarde avant migration et à la demande (`VACUUM INTO`). Purge d'historique uniquement explicite et journalisée.

## API locale (extrait)

`GET /api/status`, `GET /api/stream` (SSE), `POST /api/missions`, `GET /api/missions/:id`, `POST /api/missions/:id/start|pause|cancel`, `GET /api/missions/:id/report`, `POST /api/approvals/:id`, `GET|PUT /api/policy`, `PUT /api/provider/key`, `POST /api/provider/test`, `POST /api/provider/models/refresh`, `PUT /api/provider/assignments/:role`, `POST /api/emergency-stop`, `POST /api/rearm`, `GET /api/diagnostics`, `GET|POST|PATCH|DELETE /api/memory`. Voir `apps/server/src/routes.ts`.

## Voix et Gemini

Voir [VOICE_GEMINI.md](VOICE_GEMINI.md) : fournisseur Gemini (REST et Live), rôle `voice`, fournisseur par rôle, WebSocket `/api/voice/stream` (ticket à usage unique), agent vocal et interface vocale.
