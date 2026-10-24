# Gemini et interface vocale (Phase 2 de la roadmap)

Ce document décrit ce qui est implémenté, comment c'est vérifié, et ce qui ne l'est **pas**. Aucune clé Google n'était disponible pendant le développement : tout le comportement fonctionnel est prouvé contre des **simulations** du format documenté de l'API. Deux vérifications ont été faites contre les vrais serveurs Google, avec une fausse clé (24/10/2026) :

- REST : `generateContent` répond `400 INVALID_ARGUMENT` avec `reason: API_KEY_INVALID`. Ce corps exact sert de fixture et est classé `auth_invalid`.
- Live : le WebSocket `BidiGenerateContent` s'ouvre avec l'en-tête `x-goog-api-key` depuis le WebSocket natif de Node, puis ferme avec le code **1007** « API key not valid ». HERMES classe ce code en `auth_invalid` et ne reconnecte pas.

## 1. Architecture

```
Micro (getUserMedia) → AudioWorklet public/audio/capture-worklet.js (trames de 20 ms)
  → Resampler → PCM16 16 kHz → VAD (ou appuyer-pour-parler)          apps/desktop/src/voice/{dsp,engine}.ts
  → WebSocket ws://127.0.0.1:PORT/api/voice/stream?ticket=…           apps/server/src/{routes,voice}.ts
  → AudioBridge → GeminiLiveSession.sendAudioChunk()                  packages/core/src/voice/audio-bridge.ts
       ↘ appels d'outils (NON_BLOCKING) → VoiceAgent → orchestrateur  packages/core/src/voice/voice-agent.ts
       ↙ sendToolResult()
  ← audio PCM16 24 kHz (trames binaires, même WebSocket)
  ← AudioBuffer construit directement (pas decodeAudioData : du PCM brut n'est pas un format de fichier)
  ← haut-parleur, lecture sans coupure ; parler par-dessus coupe la lecture (barge-in)
```

### Fournisseurs

| Fichier                          | Rôle                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model-providers/gemini.ts`      | `GeminiProvider` (`ModelProvider`) : AI Studio (`generativelanguage.googleapis.com/v1beta`) ou Vertex AI (`LOCATION-aiplatform.googleapis.com/v1/projects/…/publishers/google`), `generateContent` et `streamGenerateContent?alt=sse` |
| `model-providers/gemini-live.ts` | `GeminiLiveProvider.openSession()` → `GeminiLiveSession` (WebSocket `BidiGenerateContent`)                                                                                                                                            |
| `voice/voice-agent.ts`           | agent vocal non exécutant : outils de contrôle, commandes spéciales, fenêtre de 20 tours                                                                                                                                              |
| `voice/audio-bridge.ts`          | une conversation : session Live ↔ client ↔ agent vocal, notifications de mission                                                                                                                                                      |
| `voice/catalog.ts`               | 30 voix HD, 24 langues, `VoiceSettings`                                                                                                                                                                                               |

### Choix par rôle

`MODEL_ROLES` comprend désormais `voice`. Le réglage `role_providers` (`runtime.ts`, `RoleProviders`) associe chaque rôle texte (`primary`, `planning`, `execution`, `verification`) à `openrouter` ou `gemini`. Le rôle `voice` est toujours servi par `gemini-live`. Un rôle sans modèle suit le modèle **et** le fournisseur du rôle principal. `LlmGateway` reçoit `provider(role)` et refuse une complétion pour le rôle `voice`. Les deux catalogues (OpenRouter `vendeur/modèle`, Gemini `gemini-…`) sont réunis dans une seule table de capacités.

### Clé Google

Elle est stockée dans le coffre du système sous le nom **`GEMINI_API_KEY`**. En développement, la variable d'environnement `GEMINI_API_KEY` est prioritaire, et `GOOGLE_API_KEY` est acceptée en secours. La clé est envoyée **uniquement en en-tête** (`x-goog-api-key`), jamais dans l'URL. Un jeton OAuth `ya29.…` (Vertex AI) part en `Authorization: Bearer`. Le masquage des journaux reconnaît les clés `AIza…`, les jetons `ya29.…` et l'en-tête `x-goog-api-key`.

`validateGeminiBaseUrl()` est l'équivalent de `validateBaseUrl()` pour OpenRouter. La roadmap la nommait `validateGeminiKey()`, mais elle valide une URL, pas une clé. Elle exige HTTPS/WSS sur `generativelanguage.googleapis.com` ou `(région-)aiplatform.googleapis.com`, sans identifiants, paramètres, fragment ni port exotique, avec un chemin `/v1…` (REST) ou `/ws/` (Live). Le projet et la région Vertex ainsi que les identifiants de modèle sont validés avant d'entrer dans le chemin.

## 2. Gemini REST (`GeminiProvider`)

- **Conversion des messages** : `system` → `systemInstruction` ; `assistant.tool_calls` → `functionCall` ; `tool` → `functionResponse`, nommé d'après l'appel d'origine. Les tours consécutifs de même rôle sont fusionnés. Les images `data:` sont transmises en `inlineData` ; les URL distantes sont décrites, jamais téléchargées.
- **Outils** : `AnyTool` → `toChatToolSpec` (existant) → `FunctionDeclaration` avec `parametersJsonSchema`. `toolChoice` → `functionCallingConfig.mode`.
- **Signatures de pensée** (Gemini 3) : conservées dans `ChatToolCall.thoughtSignature` et renvoyées au tour suivant. Sans elles, l'API refuse la suite de la conversation.
- **Ancrage** : le plugin `web` devient `tools: [{ googleSearch: {} }]`, et `groundingMetadata.groundingChunks[].web` devient `UrlCitation` (dédoublonné).
- **Réponses** : `MAX_TOKENS` donne `length` et `incomplete`. Les arrêts de sécurité (`SAFETY`, `RECITATION`, …) et un flux coupé sans `finishReason` sont aussi `incomplete`. `promptFeedback.blockReason` produit une erreur explicite. Les jetons de réflexion sont comptés en sortie.
- **Erreurs** : `classifyGeminiError` produit les mêmes `ProviderErrorKind` qu'OpenRouter. Il gère les cas propres à Google : clé invalide en 400, facturation, `RetryInfo.retryDelay`, 503 « overloaded » réessayable. Les nouvelles tentatives, le délai, l'annulation et le repli sur un modèle de secours suivent la même logique qu'OpenRouter.
- **Coût** : Google ne publie pas ses prix par l'API. Le coût reste « inconnu » (`costKnown: false`), il n'est jamais estimé au hasard.
- **Vertex AI** : `listModels` renvoie une liste vide (pas d'équivalent public pour une clé), et le test de connexion fait alors directement une génération. Les jetons OAuth expirent au bout d'une heure et ne sont **pas** renouvelés automatiquement.

## 3. Gemini Live (`GeminiLiveProvider`)

- **Ouverture** : `setup` contient `models/<modèle>` (par défaut `gemini-3.8-live`), `responseModalities: ['AUDIO']`, `speechConfig` (voix et langue), `systemInstruction`, `tools` (déclarés `behavior: 'NON_BLOCKING'`), `enableAffectiveDialog` (activé par défaut, paramètre `affectiveDialogue`), les transcriptions entrée/sortie, `sessionResumption` et `contextWindowCompression`. La session n'est prête qu'après `setupComplete` (délai maximal de 15 s).
- **Audio** : `realtimeInput.audio` en base64 PCM 16 kHz, plus `audioStreamEnd` quand la VAD du client détecte la fin de parole. En sortie, `inlineData` `audio/pcm;rate=24000` en 16 bits ; un flux annoncé en 24 bits (`bits=24` / `L24`) est converti en 16 bits. Les trames JSON binaires et texte sont acceptées toutes les deux.
- **Transcriptions** : partielles puis finales (un énoncé utilisateur se termine quand le modèle répond, appelle un outil, ou en fin de tour). Elles sont publiées sur `telemetry.live()` avec `category: 'voice'`.
- **Outils** : `toolCall` → `onToolCall` ; `sendToolResult(id, résultat)` répond avec le nom de la fonction et `scheduling: 'WHEN_IDLE'`. Un appel annulé par `toolCallCancellation` ne reçoit pas de réponse.
- **Interruption** : si le serveur envoie `interrupted` (sa détection de voix a entendu l'utilisateur), la lecture s'arrête. `interrupt()` coupe immédiatement le reste de la réponse côté HERMES.
  **Écart volontaire** : la roadmap proposait d'envoyer `clientContent { turnComplete: false }`. Ce message n'est pas documenté comme interrompant la génération et risquerait une fermeture en erreur. L'interruption réelle vient de la détection de voix du serveur, qui reçoit l'audio de l'utilisateur.
- **Reconnexion** : au plus 3 tentatives avec backoff exponentiel, sauf pour les erreurs d'authentification ou de politique (1007/1008), qui ne se corrigent pas en réessayant. La reprise utilise le jeton `sessionResumption`. Sans jeton, les 20 derniers tours sont rejoués en `clientContent` (`turnComplete: false`, sans demander de réponse).
- **Limite de session** : Google limite une session Live à environ 30 minutes. Une minute avant, ou dès réception de `goAway`, une nouvelle connexion est établie **avant** la fermeture de l'ancienne : l'audio n'est jamais coupé.

## 4. Agent vocal et pont audio

- **Agent `voice`** (`definitions.ts`) : non exécutant, rôle de modèle `voice`. Son invite impose des réponses courtes et naturelles, une confirmation orale avant de lancer ou d'annuler une mission, des approbations uniquement à l'écran, et le traitement des contenus comme de simples données.
- **Outils de l'agent** : `mission_create`, `mission_start` (confirmation obligatoire), `mission_pause`, `mission_cancel` (confirmation obligatoire), `mission_status`, `mission_report`, `missions_recent`, `approvals_pending` (lecture seule), `emergency_stop`. Leurs arguments sont validés par zod et les erreurs sont renvoyées au modèle, jamais levées.
  **Écart volontaire** : la roadmap prévoyait de router les appels d'outils vers `ToolExecutor`. Le pont les envoie à l'agent vocal, qui passe par l'**orchestrateur**. Toute action sur la machine reste donc une mission planifiée, validée, soumise à la politique, aux approbations, aux budgets et à l'audit.
- **Commandes spéciales** : « Pause », « Reprends », « Annule » / « Stop », « Arrêt d'urgence », « Rapport ». Elles ne se déclenchent que si l'énoncé entier est la commande (5 mots au plus). Elles sont exécutées de façon déterministe, sans attendre l'interprétation du modèle, qui est ensuite prévenu pour ne pas les répéter. « Annule » prononcé seul vaut confirmation.
- **Approbations à la voix** : refusées. Une erreur de transcription ou une injection ne doit pas pouvoir approuver une action sensible.
- **Mémoire** : fenêtre de 20 tours (20 énoncés utilisateur et 20 réponses). Une mission créée à la voix porte la mention « (Demande dictée à la voix…) » et les quatre derniers énoncés de l'utilisateur, nettoyés et étiquetés « transcription non fiable ».
- **Historique** : les missions vocales sont des missions ordinaires (historique, rapports, audit). L'événement `voice.mission_created` est lié à la mission. Les événements de session (`voice.session_started/ended/failed`, `voice.command`, `voice.tool`) n'enregistrent **aucun texte prononcé**, seulement des compteurs.
- **Notifications** : plan prêt, plan en échec, approbation requise, mission vérifiée, en pause, annulée, budget dépassé. Le modèle les annonce, et propose de lancer la mission quand le plan est prêt.

## 5. Service local et interface

- **WebSocket `/api/voice/stream`** (`apps/server/src/voice.ts`, enregistré dans `routes.ts` via `Router.ws`) : mêmes contrôles d'hôte et d'origine que le HTTP. Comme un navigateur ne peut pas envoyer `Authorization` sur un WebSocket, l'accès se fait par **ticket à usage unique** de 30 s, obtenu par `POST /api/voice/ticket` (authentifié par le jeton de session). Une seule session vocale à la fois. Trames limitées à 64 Kio. Messages de contrôle validés : `text`, `audio_end`, `interrupt`, `stop`.
- **API** : `GET/PUT /api/provider/role-providers`, `GET /api/provider/gemini`, `PUT/DELETE /api/provider/gemini/key`, `PUT /api/provider/gemini/settings`, `POST /api/provider/gemini/test`, `POST /api/provider/gemini/live-test`, `GET /api/provider/gemini/models`, `POST /api/provider/gemini/models/refresh`, `GET/PUT /api/voice/settings`, `GET /api/voice/catalog`.
- **CSP Tauri** : `connect-src` autorise `ws://127.0.0.1:*`. Le worklet est un fichier de `public/`, la CSP interdisant les `blob:`. Le proxy Vite de développement transmet les WebSocket (`ws: true`).
- **Page « Assistant vocal »** (`VoicePanel`) :
  - micro mains libres (VAD : le silence n'est pas envoyé) ou appuyer-pour-parler (souris, Espace, Entrée) ;
  - onde animée micro/voix, statique toutes les 250 ms si les animations sont réduites ;
  - transcription en direct ;
  - mission déclenchée par la voix, avec ses vraies données ;
  - interruption, saisie texte de secours (également utilisable sans micro) ;
  - aide des commandes.
- **Paramètres → Voix de l'assistant** : 30 voix, 24 langues, dialogue affectif, mode du micro par défaut, sensibilité.
- **Modèles et OpenRouter** :
  - fournisseur par rôle et rôle « Voix (Gemini Live) » ;
  - carte Gemini : clé, point d'accès AI Studio/Vertex, tests réels « Tester Gemini » et « Tester Gemini Live », catalogue.

## 6. Non réalisé, ou non vérifié

| Élément                                                          | État                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appels réels réussis vers Gemini (REST et Live)                  | **Non vérifié** : aucune clé disponible. Seuls les cas « clé invalide » ont été observés contre les vrais serveurs                                                                                                         |
| Modèle `gemini-3.8-live`, voix, langues, `enableAffectiveDialog` | Repris de la roadmap et de la documentation publique de l'API Live ; leur acceptation par le service réel n'est pas vérifiée                                                                                               |
| Avatar vidéo 24 FPS (`response_modalities: ["VIDEO"]`)           | **Non implémenté** : aucune modalité de sortie vidéo n'est documentée dans l'API Live accessible, et la page citée par la roadmap est inaccessible depuis l'environnement de développement. Rien n'a été simulé à la place |
| Approbations à la voix (« Approuve » / « Refuse »)               | Refusées volontairement (voir § 4)                                                                                                                                                                                         |
| Microphone dans la WebView2 de Windows                           | Testé uniquement dans Chromium avec un micro simulé ; l'invite d'autorisation de WebView2 n'a pas été vérifiée                                                                                                             |
| Coût des appels Gemini                                           | Inconnu (prix non publiés par l'API)                                                                                                                                                                                       |
| Renouvellement automatique des jetons OAuth Vertex               | Non implémenté (utiliser une clé API en mode express, ou renouveler le jeton)                                                                                                                                              |

## 7. Tests

| Fichier                           | Nb  | Nature                                                                                                                                                                                                               |
| --------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/gemini.test.ts`       | 35  | **simulé** : URL et Vertex, modèles, 10 statuts d'erreur, clé invalide réelle, retryDelay, conversions, outils, en-têtes, retries, repli, délai, annulation, flux SSE, ancrage, catalogue, test de connexion         |
| `tests/unit/gemini-live.test.ts`  | 21  | **WebSocket simulé** : setup, clé absente ou invalide (1007), délai, audio 16/24 bits, transcriptions, outils NON_BLOCKING, annulation, barge-in, reprise, rejeu du contexte, 3 tentatives, goAway, limite de 30 min |
| `tests/unit/voice-agent.test.ts`  | 22  | commandes spéciales, fenêtre de 20 tours, nettoyage, déclarations, catalogue, confirmations, arguments invalides, refus des approbations à la voix                                                                   |
| `tests/unit/voice-dsp.test.ts`    | 5   | rééchantillonnage 48 → 16 kHz et 44,1 → 16 kHz, PCM16, VAD (pré-roll, délai de grâce, bruit de fond, sensibilité)                                                                                                    |
| `tests/integration/voice.test.ts` | 5   | runtime **réel** et Live **simulé sur un vrai WebSocket** : setup, mission dictée planifiée puis notifiée, arrêt d'urgence vocal, clé refusée, routage planification → Gemini et exécution → OpenRouter              |
| `tests/security/security.test.ts` | +2  | clé Gemini jamais renvoyée, URL Gemini malveillantes refusées ; WebSocket : ticket obligatoire, à usage unique, hôte et origine contrôlés                                                                            |
| `tests/e2e/voice.spec.ts`         | 4   | UI et service réels, Live simulé, **micro simulé de Chromium** : clé et test Live depuis l'UI, conversation écrite, voix → mission → historique, réglages vocaux                                                     |
