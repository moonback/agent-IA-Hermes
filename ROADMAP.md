# ROADMAP — HERMES vers l'Autonomie Totale + Vocal Gemini 3.8 Live

> **Version cible :** HERMES 1.0 — Agent Totalement Autonome  
> **Modèle vocal :** `gemini-3.8-live` (GA — bidirectionnel WebSocket, 16 kHz PCM entrée / 24 kHz PCM sortie, avatar 24 FPS)  
> **Base de départ :** HERMES 0.1 — opérationnel le 24/10/2026  
> **Horizon :** 4 phases sur ~12 mois

---

## Contexte et état de l'art à date

HERMES 0.1 est un agent desktop Windows fonctionnel : planificateur, orchestrateur, vérificateur, 9 agents spécialisés (computer, files, browser, code, research, memory), 20 outils, politique de sécurité déterministe, coffre OS, persistance SQLite auditée, interface React 8 pages, shell Tauri 2.

Ce qui **manque** pour atteindre l'autonomie totale et l'interaction vocale :

| Lacune | Impact |
|---|---|
| Un seul provider LLM (OpenRouter) | Dépendance unique, pas de fallback local |
| Agent `computer` sans vision (screenshots non envoyés au modèle) | Ne peut pas piloter des apps non-accessibles UIA |
| Recherche Web non testée en réel, un seul fournisseur | Agent `research` bridé |
| Aucune interface vocale | Interaction 100% clavier |
| Aucun provider Gemini Live | Lacune majeure pour l'UX conversationnelle |
| `process.run` sans sandbox réseau/processus | Risque d'exécution non isolée |
| Mémoire keyword-only | Rappel de contexte approximatif |
| Pas d'autonomie proactive (missions déclenchées uniquement par l'utilisateur) | Agent réactif, non proactif |
| CI jamais exécutée, installateur non signé | Déploiement fragile |

---

## Vision HERMES 1.0

Un agent desktop autonome qui :
- **s'active à la voix** (`gemini-3.8-live` — WebSocket bidirectionnel, latence < 1 s) ;
- **voit et agit** sur n'importe quelle application Windows, y compris non-accessibles (vision par captures) ;
- **planifie, exécute et vérifie** des missions complexes multi-étapes sans intervention humaine sauf validation explicite ;
- **apprend** de ses missions précédentes grâce à une mémoire sémantique ;
- **s'améliore** en déclenchant ses propres missions de fond (proactivité) ;
- **se déploie** via un installateur signé qui embarque Node.js et configure Windows automatiquement.

---

## Phase 1 — Fondations robustes et CI (Mois 1–2)

**Objectif :** rendre le projet déployable et maintenable avant d'ajouter de la complexité.

### 1.1 CI/CD opérationnelle

- [ ] Pousser le dépôt sur GitHub (ou GitLab)
- [ ] Valider le workflow `.github/workflows/ci.yml` existant (typecheck → lint → test:unit → test:integration → test:security)
- [ ] Ajouter un job `release` : `pnpm tauri build` → artefact NSIS signé uploadé sur GitHub Releases
- [ ] Ajouter `dependabot.yml` (pnpm) pour les mises à jour de sécurité
- [ ] Badge CI vert dans le README

### 1.2 Installateur self-contained

- [ ] **Embarquer Node.js 22 LTS** dans le bundle NSIS (téléchargement depuis `nodejs.org/dist` au moment du build → `resources/node/`)
- [ ] Mettre à jour `src-tauri/build.rs` pour résoudre `NODE_PATH` vers le Node embarqué
- [ ] **Signer l'installateur** avec un certificat EV code-signing (ou self-signed pour dev)
- [ ] Installer Chromium Playwright automatiquement au premier lancement (`playwright install chromium`)
- [ ] Test d'installation sur machine vierge (VM Windows 11)

### 1.3 Politique de rétention et sauvegarde

- [ ] **Sauvegarde automatique périodique** de `hermes.db` toutes les 24 h vers `backups/` (Cron intégré ou `setInterval` au démarrage du runtime)
- [ ] **Purge automatique des logs** : conserver 30 jours, supprimer `hermes-YYYY-MM-DD.log` plus vieux
- [ ] Exposer `GET /api/maintenance/backups` pour lister les sauvegardes disponibles

### 1.4 Corrections et hardening connus

- [ ] Approbation interactive des redirections vers domaines inconnus (navigateur)
- [ ] Tester `web.search` en réel avec la clé OpenRouter (bloquer la mission Bitcoin si le domaine n'est pas autorisé, vérification corrigée depuis)
- [ ] Audit d'accessibilité axe sur les 8 pages (CI : `axe-playwright`)
- [ ] Couverture de test : atteindre > 80 % sur `packages/core`

**Livrables :** installateur signé, CI verte, logs rétentionnés, audit axe.

---

## Phase 2 — Provider Gemini + Interface Vocale (Mois 3–5)

**Objectif :** intégrer Gemini 3.8 Live comme provider LLM et vocal natif de HERMES.

### 2.1 GeminiProvider — complétion classique

Créer `packages/core/src/model-providers/gemini.ts` qui implémente l'interface `ModelProvider` :

```
interface ModelProvider {
  chat(req, opts): Promise<ChatResponse>
  listModels(signal?): Promise<ModelInfo[]>
  testConnection(modelId?): Promise<ConnectionTestResult>
  hasKey(): Promise<boolean>
}
```

- [ ] Authentification via `GOOGLE_API_KEY` (coffre OS, nom `GEMINI_API_KEY`)
- [ ] Support de l'API Gemini AI Studio REST (`https://generativelanguage.googleapis.com/v1beta/models/:model:generateContent`)
- [ ] Support de Vertex AI REST (`https://LOCATION-aiplatform.googleapis.com/v1/projects/PROJECT/...`) — optionnel mais recommandé pour quota et SLA
- [ ] Streaming SSE via `streamGenerateContent`
- [ ] Function calling : conversion `AnyTool` → `FunctionDeclaration` Gemini, retour `FunctionCall` → `ToolCall` HERMES
- [ ] Grounding/citations (si disponible) → `UrlCitation`
- [ ] Classement d'erreurs HTTP en `ProviderErrorKind` (cohérent avec `openrouter.ts`)
- [ ] `validateGeminiKey()` analogue à `validateBaseUrl()` — refuse les URLs hors `googleapis.com` et `aiplatform.googleapis.com`
- [ ] 23+ tests unitaires (simulé) cohérents avec `openrouter.test.ts`
- [ ] Test de connexion réel dans la page Models de l'UI

### 2.2 GeminiLiveProvider — vocal WebSocket

Créer `packages/core/src/model-providers/gemini-live.ts` :

**Protocole (d'après la doc Google) :**
- WebSocket persistant vers `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`
- Message d'ouverture `BidiGenerateContentSetup` : modèle `gemini-3.8-live`, `responseModalities: ["AUDIO"]`, `speechConfig` (voix, langue), `tools`, `systemInstruction`
- Envoi audio : `BidiGenerateContentRealtimeInput` avec `audio: { data: base64(PCM 16 kHz 16-bit mono) }`
- Réception : `BidiGenerateContentServerContent` (audio PCM 24 kHz, transcription, tool calls), `BidiGenerateContentSetupComplete`
- Interruption (barge-in) : `BidiGenerateContentClientContent` avec `turnComplete: false` puis fermeture partielle
- Tool call non-bloquant (`auto-canceling BLOCKING`) : le modèle continue l'audio pendant l'exécution

```typescript
interface GeminiLiveSession {
  sendAudioChunk(pcm16: Buffer): void
  sendText(text: string): void
  sendToolResult(callId: string, result: unknown): void
  interrupt(): void
  onAudioChunk: (pcm24: Buffer) => void
  onTranscript: (text: string, final: boolean) => void
  onToolCall: (call: ToolCall) => void
  onTurnEnd: () => void
  close(): void
}
```

- [ ] Classe `GeminiLiveProvider` avec `openSession(config): Promise<GeminiLiveSession>`
- [ ] Gestion de reconnexion automatique (backoff exponentiel, max 3 tentatives)
- [ ] Timeout de session (30 min max côté Google) → reconnexion transparente avec reprise du contexte
- [ ] Conversion tool calls Gemini ↔ HERMES (réutilise `createToolRegistry`)
- [ ] Affective dialogue activé par défaut (3.8 Live) → paramètre `affectiveDialogue: boolean`
- [ ] Streaming des transcriptions vers `telemetry.live()` (catégorie `voice`)
- [ ] Tests unitaires avec WebSocket mock

### 2.3 Intégration dans le runtime

- [ ] Ajouter `GEMINI_API_KEY` dans `.env.example` et dans `KeyringSecretStore` (nom `GEMINI_API_KEY`)
- [ ] Mettre à jour `runtime.ts` : `providerKind: 'openrouter' | 'gemini' | 'gemini-live'` dans les settings
- [ ] `LlmGateway` : sélectionner le provider selon le rôle de modèle (`voice` → `GeminiLiveProvider`, `planning`/`execution`/`verification` → `GeminiProvider` ou `OpenRouterProvider`)
- [ ] Ajouter un rôle de modèle `voice` dans `MODEL_ROLES` et `contracts.ts`
- [ ] Page Models de l'UI : section "Gemini" avec champ clé, sélection du provider par rôle, statut de connexion Live

### 2.4 Interface vocale dans l'application desktop

**Architecture audio :**

```
Microphone (Tauri Web API)
  → AudioWorklet (resampling → 16 kHz PCM 16-bit mono)
  → WebSocket vers /api/voice/stream (HERMES server)
  → GeminiLiveSession.sendAudioChunk()
  → ToolExecutor (tool calls non-bloquants)
  → GeminiLiveSession.sendToolResult()
  → AudioChunk (24 kHz PCM 24-bit)
  → /api/voice/stream (SSE inverse)
  → AudioContext.decodeAudioData()
  → Haut-parleur
```

- [ ] Endpoint WebSocket `ws://127.0.0.1:PORT/api/voice/stream` dans `apps/server/src/routes.ts`
- [ ] `AudioBridge` dans le core : gère la session Gemini Live, route les tool calls vers `ToolExecutor`, streame l'audio retour
- [ ] Nouveau composant React `VoicePanel` :
  - Bouton micro (push-to-talk et VAD continu)
  - Indicateur d'activité vocale (waveform animée)
  - Transcription en temps réel (user + agent)
  - Affichage de la mission en cours déclenchée par la voix
  - Option avatar 24 FPS (vidéo MP4 stream via `response_modalities: ["VIDEO"]`)
- [ ] VAD (Voice Activity Detection) côté client pour ne pas envoyer le silence
- [ ] Barge-in : l'utilisateur peut interrompre la réponse vocale en cours
- [ ] Commandes vocales spéciales : "Pause", "Annule", "Arrêt d'urgence", "Rapport"
- [ ] Persistance de la session vocale : toutes les missions déclenchées par la voix apparaissent dans l'historique normal
- [ ] Paramètre de voix (30 voix HD, 24 langues) dans la page Paramètres

### 2.5 Agent conversationnel vocal

- [ ] Ajouter un agent `voice` (non-exécutant) dans `definitions.ts` : reçoit la transcription, décide si c'est une mission à créer, une question, une commande de contrôle
- [ ] System prompt `voice` : concis et naturel (réponses courtes, confirmation vocale des actions risquées)
- [ ] Intégration avec l'orchestrateur : `voice` peut appeler `orchestrator.createMission()`, `orchestrator.pause()`, `orchestrator.cancel()`, interroger `store`
- [ ] Multi-tour : l'agent se souvient du contexte de la conversation vocale courante (window de 20 tours)

**Livrables :** GeminiProvider + GeminiLiveProvider fonctionnels, VoicePanel, agent vocal, tests 30+.

---

## Phase 3 — Vision, Autonomie et Capacités Avancées (Mois 6–9)

**Objectif :** donner à HERMES une autonomie réelle — vision, proactivité, sandbox, mémoire sémantique.

### 3.1 Vision pour l'agent `computer`

L'agent `computer` ne peut actuellement pas piloter les apps sans accessibilité UIA. La vision résout cela.

- [ ] **Envoi des screenshots au modèle** : `screen.observe` produit déjà un PNG → l'inclure dans le message LLM (base64 JPEG resizé à 1024px max) si le modèle supporte `supportsImages`
- [ ] Outil `desktop.vision_click` : le modèle fournit une description textuelle de la cible (couleur, forme, texte) → HERMES cherche la zone dans l'image via template matching ou un modèle vision dédié → clique aux coordonnées
- [ ] Outil `desktop.ocr` : extraction de texte depuis la capture (Tesseract.js ou Windows.Media.Ocr via PowerShell)
- [ ] Mode fallback automatique : si `desktop.inspect` échoue (app non-accessible UIA) → bascule vers `desktop.vision_click` + `desktop.ocr`
- [ ] Streamer les captures vers l'interface (Computer page) avec annotation des zones détectées
- [ ] Gemini 3.8 Live comme modèle vision pour l'agent `computer` (1 FPS JPEG en entrée Live API)

### 3.2 Sandbox processus (Windows Job Objects)

- [ ] Encapsuler `process.run` dans un **Windows Job Object** :
  - Limite CPU et mémoire
  - Kill automatique du sous-arbre à la fin (déjà partiellement fait)
  - Option : restreindre les processus enfants (JOBOBJECT_BASIC_LIMIT_INFORMATION)
- [ ] Option **AppContainer** pour les processus non-fiables (niveau de confiance `medium`/`high`) — isolation réseau partielle
- [ ] Timeout renforcé : signal `SIGTERM` puis `SIGKILL` après 2 s
- [ ] Audit : chaque exécution loggue argv, exit code, durée, allocations mémoire (via `process.resourceUsage()`)

### 3.3 Mémoire sémantique

- [ ] **Embeddings locaux** : intégrer `@xenova/transformers` (modèle `all-MiniLM-L6-v2`, ~25 MB) pour produire des vecteurs de 384 dimensions en local, sans requête externe
- [ ] **Stockage vectoriel** dans SQLite via `sqlite-vec` (extension SQLite pour la recherche cosinus) ou table `memory_embeddings` (BLOB float32 + BM25 hybride)
- [ ] Mise à jour de `memory.search` : requête hybride (BM25 keyword + similarité cosinus) → top-K résultats re-rankés
- [ ] Mise à jour de `memory.save` : calcul de l'embedding à la sauvegarde (async background)
- [ ] Migration SQL : ajout de la colonne `embedding` dans `memory_entries`
- [ ] Benchmark : comparer précision recall avant/après sur les scénarios de test existants

### 3.4 Proactivité — Missions autonomes déclenchées par planification

- [ ] **Scheduler** dans `runtime.ts` : cron-like (syntaxe cron ou intervalle) persisté dans SQLite (table `scheduled_triggers`)
- [ ] API :
  - `POST /api/triggers` : créer un déclencheur (expression cron, mission template, conditions)
  - `GET /api/triggers` : lister
  - `DELETE /api/triggers/:id` : supprimer
- [ ] Types de déclencheurs :
  - `cron` : ex. "Tous les matins à 8h, résume les actualités tech et enregistre en mémoire"
  - `event` : ex. "Si un fichier est modifié dans le dossier X, analyser et notifier"
  - `condition` : ex. "Si la dernière mission a échoué, réessayer avec stratégie alternative"
- [ ] Notification desktop (Windows Toast) quand une mission proactive démarre ou se termine
- [ ] Page "Planification" dans l'UI : calendrier des déclencheurs, historique des missions automatiques
- [ ] Politique : les missions proactives ne peuvent pas dépasser un budget réduit par défaut (0,20 $ max)

### 3.5 Providers supplémentaires pour la recherche Web

- [ ] Intégrer **Tavily** (`tavily.com/api`) comme provider de recherche alternatif à OpenRouter Web Search
- [ ] Intégrer **Brave Search API** comme 3ème option
- [ ] `SearchProviderRegistry` : sélection automatique selon la disponibilité et le quota
- [ ] Tests réels pour les 3 providers

### 3.6 Lecture de documents

- [ ] `files.read` : support **PDF** via `pdf-parse` (extraction texte, métadonnées, nombre de pages)
- [ ] Support **DOCX** via `mammoth` (extraction Markdown)
- [ ] Support **XLSX** via `xlsx` (extraction JSON des feuilles)
- [ ] Limite : max 100 pages ou 500 Ko de texte extrait (pour ne pas exploser le contexte LLM)
- [ ] Tests : 3 fichiers types (PDF, DOCX, XLSX) dans `tests/fixtures/`

### 3.7 Agent `shell` dédié (remplace `code` pour les scripts longs)

- [ ] Nouvel agent `shell` : spécialisé scripts PowerShell multi-étapes, git workflows, CI locale
- [ ] Outils supplémentaires : `shell.pipe` (pipeline de commandes sans shell injection — via stdio chain), `shell.env` (lire/écrire variables d'environnement dans la session)
- [ ] Isolation renforcée via Job Objects (voir 3.2)

**Livrables :** vision agent computer, sandbox, mémoire sémantique, scheduler, lecture PDF/DOCX/XLSX.

---

## Phase 4 — Production, Multi-providers et Écosystème (Mois 10–12)

**Objectif :** HERMES 1.0 — robuste, multi-providers, multi-utilisateurs préparé, prêt pour la distribution publique.

### 4.1 Support multi-providers LLM

- [ ] **Ollama** (`http://localhost:11434`) comme provider local (zéro coût, privacy maximale)
  - Implémente `ModelProvider` via l'API REST Ollama
  - Auto-détecte les modèles installés (`ollama list`)
  - Fallback : si Ollama est down → provider cloud configuré
- [ ] **LM Studio** (compatible OpenAI API sur `http://localhost:1234`) — compatible avec l'implémentation OpenAI d'OpenRouter
- [ ] **Anthropic Claude** (direct, sans passer par OpenRouter) — clé `ANTHROPIC_API_KEY`
- [ ] `ProviderRouter` dans `LlmGateway` : routage par rôle (ex. Ollama pour `execution`, Gemini pour `voice` et `planning`, Claude pour `verification`)
- [ ] UI page Models : sélecteur de provider par rôle, statut de santé en temps réel, coût estimé

### 4.2 Évaluation automatisée des capacités (benchmarks)

- [ ] Suite de **40 missions de référence** couvrant les 6 agents exécutants (fichiers, navigateur, bureau, code, recherche, mémoire)
- [ ] Métriques : taux de succès, coût moyen, durée, nombre d'approbations requises
- [ ] Comparaison automatique entre providers/modèles (openai/gpt-6-luna vs gemini-3.8-live vs llama-3 local)
- [ ] Rapport HTML généré dans `test-results/eval/`
- [ ] Job CI hebdomadaire sur GitHub Actions

### 4.3 Sécurité avancée

- [ ] **Audit de l'injection de prompt** : red team automatisé — 20 scénarios d'injection via fichiers, pages Web, sorties de commandes → vérifier que 0 permission n'est accordée
- [ ] **Rotation automatique du jeton d'accès** HTTP (actuellement statique au démarrage)
- [ ] **Chiffrement de la base SQLite** (`SQLCipher`) avec clé dérivée du coffre OS
- [ ] **Rate limiting** sur l'API HTTP locale (max 100 req/min par IP)
- [ ] Rapport de sécurité automatisé (SARIF) dans la CI

### 4.4 Expérience utilisateur complète

- [ ] **Onboarding** : assistant de configuration au premier lancement (clé API, sélection modèle, test de connexion, installation Chromium)
- [ ] **Notifications** : Windows Toast pour fin de mission, approbations en attente, budget proche du maximum
- [ ] **Thème adaptatif** : respect du thème Windows (clair/sombre/accent color) via `prefers-color-scheme` + API Tauri
- [ ] **Raccourcis clavier globaux** Windows : `Win+Shift+H` pour activer/désactiver l'écoute vocale
- [ ] **Tray icon** : HERMES dans la barre de notification, accès rapide à "Nouvelle mission", "Activer micro", "Stop d'urgence"
- [ ] **Tour guidé** interactif pour les nouveaux utilisateurs (composant `Joyride`)

### 4.5 API publique et SDK

- [ ] **SDK TypeScript** `@hermes/client` : wrape l'API HTTP locale, expose des types générés depuis Zod
- [ ] **Webhooks sortants** : notifier une URL externe à la fin d'une mission (configurable dans Settings)
- [ ] **MCP compatible** : exposer les agents HERMES comme outils MCP (Model Context Protocol) pour que d'autres assistants (Claude Desktop, Kiro, etc.) puissent déléguer des missions à HERMES
- [ ] Documentation API (OpenAPI 3.1 auto-générée depuis `routes.ts`)

### 4.6 Tests d'accessibilité et internationalisation

- [ ] Audit complet axe + NVDA + VoiceOver : correction de tous les défauts WCAG 2.2 AA
- [ ] i18n : extraction des chaînes françaises → `i18next`, support Anglais + Français au lancement
- [ ] Interface vocale : Gemini 3.8 Live supporte 24 langues → détection automatique de la langue de l'utilisateur

**Livrables :** HERMES 1.0, multi-providers, SDK public, MCP compatible, installateur signé distribué.

---

## Tableau de bord des jalons

| Jalon | Phase | Date cible | Critère de succès |
|---|---|---|---|
| CI verte | 1 | M+2 | Tous les jobs passent sur push |
| Installateur self-contained | 1 | M+2 | Installation sur VM vierge en < 5 min |
| GeminiProvider opérationnel | 2 | M+3 | Test de connexion réel + 3 missions complètes |
| Gemini 3.8 Live WebSocket | 2 | M+4 | Session ouverte, audio bidirectionnel < 500 ms latence |
| VoicePanel + Agent vocal | 2 | M+5 | "Hey HERMES, cherche X" → mission créée et exécutée |
| Vision agent computer | 3 | M+6 | App non-accessible UIA pilotée par vision |
| Sandbox Job Objects | 3 | M+7 | process.run isolé en mémoire + réseau |
| Mémoire sémantique | 3 | M+7 | Recall > 90 % sur 50 requêtes de test |
| Scheduler proactif | 3 | M+8 | Mission cron exécutée automatiquement |
| Multi-providers LLM | 4 | M+10 | Ollama local + Gemini + OpenRouter commutables |
| MCP compatible | 4 | M+11 | HERMES visible comme outil dans Claude Desktop |
| HERMES 1.0 | 4 | M+12 | 40 missions benchmark > 85 % succès |

---

## Architecture cible — Vue d'ensemble

```
┌─────────────────────────────────────────────────────────┐
│                    HERMES Desktop (Tauri 2)              │
│  ┌─────────────┐  ┌────────────┐  ┌──────────────────┐  │
│  │  React 19   │  │ VoicePanel │  │   Tray + Notifs  │  │
│  │  8+ pages   │  │ (Gemini    │  │   (Toast/Win32)  │  │
│  │  Zustand 5  │  │  3.8 Live) │  │                  │  │
│  └──────┬──────┘  └─────┬──────┘  └──────────────────┘  │
└─────────┼───────────────┼─────────────────────────────┘
          │  HTTP + SSE   │  WebSocket (audio PCM)
          ▼               ▼
┌─────────────────────────────────────────────────────────┐
│              HERMES Server (Node.js 22, 127.0.0.1)      │
│  ┌─────────────────────────────────────────────────┐    │
│  │                  Runtime                        │    │
│  │  ┌───────────┐  ┌──────────┐  ┌─────────────┐  │    │
│  │  │Orchestrat.│  │AudioBrid.│  │  Scheduler  │  │    │
│  │  │  (async)  │  │(Live WS) │  │  (cron)     │  │    │
│  │  └─────┬─────┘  └─────┬────┘  └─────────────┘  │    │
│  │        │              │                          │    │
│  │  ┌─────▼──────────────▼──────────────────────┐  │    │
│  │  │           LlmGateway (ProviderRouter)      │  │    │
│  │  │  ┌────────────┐ ┌──────────┐ ┌──────────┐ │  │    │
│  │  │  │ OpenRouter │ │ Gemini   │ │  Ollama  │ │  │    │
│  │  │  │  Provider  │ │ Provider │ │  Local   │ │  │    │
│  │  │  └────────────┘ └──────────┘ └──────────┘ │  │    │
│  │  │         ┌───────────────────────┐          │  │    │
│  │  │         │  GeminiLiveProvider   │          │  │    │
│  │  │         │  (WebSocket 3.8 Live) │          │  │    │
│  │  │         └───────────────────────┘          │  │    │
│  │  └───────────────────────────────────────────┘  │    │
│  │                                                  │    │
│  │  ┌────────────────────────────────────────────┐  │    │
│  │  │               ToolExecutor                 │  │    │
│  │  │  Policy → Approval → Exec → Verify → Log  │  │    │
│  │  │  20+ outils (desktop/browser/files/code/  │  │    │
│  │  │   process/web/memory/mission/shell)        │  │    │
│  │  └────────────────────────────────────────────┘  │    │
│  │                                                  │    │
│  │  ┌────────────┐  ┌─────────────────────────────┐ │    │
│  │  │  SQLite    │  │    Coffre OS (Keyring)       │ │    │
│  │  │  (WAL)     │  │  OPENROUTER + GEMINI keys    │ │    │
│  │  │  + vec     │  │  + secrets mission           │ │    │
│  │  └────────────┘  └─────────────────────────────┘ │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
          │
          │  PowerShell stdin/stdout
          ▼
┌────────────────────────┐    ┌────────────────────────┐
│  uia-worker.ps1        │    │  Playwright (Chromium) │
│  UI Automation Windows │    │  Browser Agent         │
│  + Vision (Phase 3)    │    │                        │
└────────────────────────┘    └────────────────────────┘
```

---

## Intégration Gemini 3.8 Live — Détails techniques

### Protocole WebSocket

D'après la [documentation officielle](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-live), Gemini 3.8 Live opère sur une connexion WebSocket bidirectionnelle persistante avec les caractéristiques suivantes :

| Attribut | Valeur |
|---|---|
| Model ID | `gemini-3.8-live` |
| Input audio | PCM 16 kHz, 16-bit, mono |
| Output audio | PCM 24 kHz, 24-bit |
| Output vidéo (avatar) | MP4 24 FPS (optionnel) |
| Affective dialogue | Activé par défaut |
| Barge-in | Interruption polie (attend que l'utilisateur finisse) |
| Function calling | Asynchrone non-bloquant (audio continue pendant l'exécution) |
| Langues | Commutation dynamique mid-stream |

### Séquence d'initialisation HERMES

```
Client                    HERMES Server              Gemini 3.8 Live
  │                           │                           │
  │── WS connect ────────────►│                           │
  │                           │── WS connect ────────────►│
  │                           │◄─ SetupComplete ──────────│
  │◄─ ready ─────────────────│                           │
  │                           │                           │
  │── PCM 16kHz chunks ──────►│── RealtimeInput ─────────►│
  │                           │◄─ ServerContent(audio) ───│
  │◄─ PCM 24kHz chunks ──────│                           │
  │                           │                           │
  │                           │◄─ ToolCall ───────────────│
  │                           │── ToolExecutor ──────────►│ (local)
  │                           │◄─ result ─────────────────│ (local)
  │                           │── ToolResponse ──────────►│
  │◄─ audio continue ────────│◄─ audio continue ─────────│
```

### Commandes vocales natives HERMES

| Commande | Action |
|---|---|
| "Nouvelle mission : [description]" | `orchestrator.createMission()` + démarrage automatique |
| "Pause" / "Mets en pause" | `orchestrator.pause()` |
| "Continue" / "Reprends" | `orchestrator.start()` |
| "Annule" / "Stop" | `orchestrator.cancel()` |
| "Arrêt d'urgence" | `orchestrator.emergencyStop()` |
| "Rapport" / "Résume" | Lecture vocale du rapport de la dernière mission |
| "Approuve" / "Refuse" | Résolution de l'approbation en attente |
| "Combien ça a coûté ?" | Lecture des métriques de la dernière mission |

---

## Risques et mitigations

| Risque | Probabilité | Impact | Mitigation |
|---|---|---|---|
| Latence WebSocket Gemini 3.8 Live > 1 s en conditions réelles | Moyenne | Élevé | Buffer audio adaptatif, fallback text-to-speech local (edge-tts) |
| Quota Google AI Studio insuffisant pour les missions longues | Moyenne | Élevé | Vertex AI (quota plus élevé), cache des réponses idempotentes |
| Apps non-accessibles UIA résistantes à la vision | Faible | Moyen | Coordonnées absolues en dernier recours avec double confirmation |
| Injection de prompt via réponse vocale de l'utilisateur | Faible | Élevé | Sanitisation des transcriptions avant passage au planificateur |
| Consommation mémoire de `@xenova/transformers` (~200 Mo) | Moyenne | Moyen | Chargement lazy, désactivable, modèle plus léger possible |
| Interruption barge-in coupe une tool call critique | Faible | Élevé | `auto-canceling BLOCKING` tools pour les actions irréversibles |
| Node.js embarqué alourdit l'installateur (> 80 Mo) | Certaine | Faible | Accepté — comparé à Electron c'est raisonnable |

---

## État de départ — Composants HERMES 0.1 (24/10/2026)

Rappel de ce qui est **déjà opérationnel** et ne sera pas retouché sauf bug :

| Composant | Statut |
|---|---|
| Monorepo TS strict, ESLint, Prettier | ✅ Opérationnel |
| SQLite + migrations + audit chaîné | ✅ Opérationnel |
| Coffre OS (Windows Credential Manager) | ✅ Opérationnel |
| OpenRouterProvider (streaming, retry, fallback, catalog) | ✅ Opérationnel |
| Orchestrateur (plan/exec/verify, parallélisme, pause, recovery, emergency stop) | ✅ Opérationnel |
| Policy engine déterministe + approbations | ✅ Opérationnel |
| 20 outils (desktop UIA, browser Playwright, files, process, web.search, memory, mission) | ✅ Opérationnel |
| Mémoire persistante (4 types, keyword search) | ✅ Opérationnel |
| Service HTTP local sécurisé (jeton + Origin + validation) | ✅ Opérationnel |
| Interface React 8 pages (thèmes, clavier, SSE) | ✅ Opérationnel |
| Shell Tauri 2 + installateur NSIS (4,95 Mo sans Node) | ✅ Opérationnel |
| Observabilité JSONL masquée + diagnostic | ✅ Opérationnel |
| CI GitHub Actions (non exécutée — pas de dépôt distant) | ⚠️ Préparé, non validé |
| Recherche Web (OpenRouter Web Search) | ⚠️ Partiel — non testé en réel |
| Bureau Windows (Vision) | ❌ Non implémenté |
| Sandbox process.run | ❌ Partiel — sans Job Objects |
| Mémoire sémantique | ❌ Non implémenté |
| Gemini 3.8 Live | ❌ Non implémenté |
| Scheduler proactif | ❌ Non implémenté |

---

## Prochaine action recommandée

**Avant de commencer la Phase 1**, exécuter en réel :
1. Une mission **navigateur** (ex. : "Va sur github.com/trending et résume les 5 premiers projets")
2. Une mission **bureau** (ex. : "Ouvre le Bloc-notes, écris 'Test HERMES', sauvegarde sur le bureau")
3. Une mission **recherche** (ex. : "Cherche le cours BTC aujourd'hui")

Ces 3 validations en conditions réelles confirmeront que la base 0.1 est saine avant d'engager les travaux de la roadmap.

---

*Document généré le 24/10/2026 — HERMES 0.1 → 1.0*  
*Sources : analyse du codebase complet, [Gemini 3.8 Live Developer Guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-live), [Gemini Live API overview](https://ai.google.dev/gemini-api/docs/live-api), [Native Audio Vertex AI](https://cloud.google.com/blog/topics/developers-practitioners/how-to-use-gemini-live-api-native-audio-in-vertex-ai)*
