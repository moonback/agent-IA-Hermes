# Installation et configuration

## Prérequis

- Windows 10 ou 11 x64 (testé sur Windows 10 22H2, build 19045).
- Node.js ≥ 22.13 dans le `PATH` (testé : 24.16). **Requis aussi pour l'application installée** : le service local n'est pas un exécutable autonome. Un autre emplacement peut être fixé avec la variable `HERMES_NODE`.
- Navigateur Playwright : `pnpm exec playwright install chromium` (stocké dans `%LOCALAPPDATA%\ms-playwright`).
- Développement desktop : Rust stable (MSVC), Build Tools Visual Studio 2022, WebView2.

## Développement

```bash
pnpm install
```

```bash
pnpm dev
```

`scripts/dev.mjs` génère un jeton de session, démarre le service puis Vite (proxy `/api` qui ajoute le jeton côté serveur). Un fichier `.env` facultatif (voir `.env.example`) peut définir `OPENROUTER_API_KEY` (prioritaire sur le coffre) et `HERMES_DATA_DIR`.

## Application desktop

```bash
pnpm tauri build
```

Produit `apps/desktop/src-tauri/target/release/bundle/nsis/HERMES_0.1.0_x64-setup.exe`. L'installateur embarque l'interface, le service empaqueté (`apps/server/dist`) et le worker PowerShell. Il n'est pas signé (Windows SmartScreen peut avertir).

## Configuration OpenRouter

1. _Modèles et OpenRouter_ → collez la clé (`sk-or-…`) → **Enregistrer** (Gestionnaire d'identification Windows, entrée « HERMES »).
2. **Actualiser** le catalogue, puis renseignez au moins le modèle **principal** avec un identifiant exact. Un avertissement apparaît si le modèle n'annonce pas les appels d'outils.
3. Optionnel : modèles par rôle (planification, exécution, vérification) et modèles de secours (utilisés seulement si le modèle est indisponible).
4. **Tester la connexion** : appel réel à `/key` puis complétion minimale. Résultats distingués : configuration manquante, clé invalide, réseau, modèle indisponible, crédit insuffisant, limite de débit, succès.
5. Budget par mission : appels IA, coût, durée, appels d'outils, parallélisme.

## Permissions

Par défaut, seul `%APPDATA%\hermes\workspace` est autorisé. Ajoutez vos dossiers dans _Outils et permissions_, ainsi que les domaines Web et les applications bureau autorisés. La recherche Web est désactivée tant qu'un fournisseur n'est pas choisi (« OpenRouter Web », facturé par requête).

## Données

`%APPDATA%\hermes` : `hermes.db` (SQLite), `logs\`, `artifacts\` (captures), `backups\` (copies avant écrasement, sauvegardes), `workspace\`.
