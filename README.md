# HERMES

Agent IA desktop pour Windows 10/11 : il reçoit une mission en langage naturel, établit un plan validé, confie chaque étape à un agent spécialisé qui agit **uniquement** via des outils contrôlés (fichiers, commandes, navigateur, bureau Windows), puis fait vérifier le résultat par un vérificateur indépendant. Tous les appels IA passent par **OpenRouter**.

> État : version 0.1 fonctionnelle et testée localement. Voir [PROGRESS.md](PROGRESS.md) pour ce qui est opérationnel, partiel ou bloqué.

## Démarrage rapide (développement)

Prérequis : Windows 10/11, Node.js ≥ 22.13 (testé avec 24.16), pnpm 10, Rust stable + Build Tools Visual Studio (pour l'application Tauri), WebView2.

```bash
pnpm install
```

```bash
pnpm exec playwright install chromium
```

```bash
pnpm dev
```

Ouvrez http://127.0.0.1:1420 (interface dans le navigateur, service local réel). Pour la fenêtre desktop Tauri :

```bash
pnpm tauri dev
```

Puis dans **Modèles et OpenRouter** : enregistrez la clé API (stockée dans le Gestionnaire d'identification Windows), choisissez un modèle principal (identifiant exact, issu du catalogue actualisé) et cliquez sur **Tester la connexion**.

## Commandes

| Commande                                     | Rôle                                                |
| -------------------------------------------- | --------------------------------------------------- |
| `pnpm dev`                                   | service local + interface Vite (port 1420)          |
| `pnpm tauri dev` / `pnpm tauri build`        | application desktop / installateur NSIS             |
| `pnpm typecheck`                             | TypeScript strict (cœur, serveur, tests, interface) |
| `pnpm lint` / `pnpm format:check`            | ESLint / Prettier                                   |
| `pnpm test`                                  | tests unitaires, intégration et sécurité (Vitest)   |
| `pnpm test:e2e`                              | tests end-to-end de l'interface (Playwright)        |
| `pnpm bench`                                 | mesures de performance (modèle simulé)              |
| `cargo test` (dans `apps/desktop/src-tauri`) | tests du shell Rust                                 |

## Arborescence

```
apps/
  desktop/            Interface React + Tauri (src-tauri : shell Rust qui lance le service local)
  server/             Service local Node (API HTTP + SSE sur 127.0.0.1, jeton de session) ; build.mjs l'empaquette
packages/core/src/
  shared/             Contrats Zod, machine à états, erreurs, masquage des secrets
  observability/      Logger JSONL masqué + bus d'événements
  persistence/        SQLite (node:sqlite), migrations, journal d'audit chaîné
  secrets/            Coffre du système (Gestionnaire d'identification Windows)
  model-providers/    OpenRouterProvider
  policy-engine/      Politique centralisée, chemins canoniques
  tools/              Registre, exécuteur contrôlé, approbations, outils
  agents/             Planificateur, agents exécutants, vérificateur, passerelle LLM et budgets
  orchestrator/       Moteur de missions persistant
  runtime.ts          Assemblage
workers/desktop-windows/  Worker PowerShell UI Automation (processus séparé)
tests/                unit, integration, security, e2e, performance, helpers
docs/                 architecture, modèle de sécurité, installation, dépannage, tests
```

Documentation : [architecture](docs/architecture.md) · [sécurité](docs/security-model.md) · [installation](docs/setup.md) · [dépannage](docs/troubleshooting.md) · [tests](docs/testing.md).
