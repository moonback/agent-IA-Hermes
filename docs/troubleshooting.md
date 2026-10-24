# Dépannage

| Symptôme                                                   | Cause probable                                                           | Solution                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| « Service local injoignable » / « n'a pas pu démarrer »    | Node.js absent du PATH ou trop ancien                                    | Installer Node ≥ 22.13 ou définir `HERMES_NODE` vers `node.exe`        |
| Test de connexion : _Configuration manquante_              | aucune clé, ou aucun modèle principal                                    | Enregistrer la clé et choisir un modèle                                |
| _Clé invalide ou accès refusé_                             | clé révoquée / mal copiée                                                | Régénérer la clé sur openrouter.ai                                     |
| _Crédit insuffisant_ (402)                                 | solde ou limite de la clé atteint                                        | Recharger le compte ou relever la limite                               |
| _Modèle indisponible_                                      | identifiant inexact ou modèle retiré                                     | Actualiser le catalogue et choisir un identifiant listé                |
| Planification refusée « n'a pas accès » / « indisponible » | le modèle propose un outil inexistant ou indisponible                    | Vérifier la disponibilité dans _Outils et permissions_ ; reformuler    |
| Navigateur indisponible                                    | Chromium Playwright non installé                                         | `pnpm exec playwright install chromium`                                |
| Recherche Web indisponible                                 | aucun fournisseur choisi                                                 | _Outils et permissions → Recherche Web_                                |
| Action bureau `WINDOW_CHANGED`                             | la fenêtre a changé de titre depuis l'observation                        | normal : l'agent doit réobserver                                       |
| `FOCUS_FAILED`                                             | Windows a refusé d'activer la fenêtre (verrou de premier plan)           | relancer l'action ; ne pas utiliser le clavier/souris pendant l'action |
| Contrôle introuvable (`NOT_FOUND`)                         | application peu accessible (dessin personnalisé, certains jeux/Electron) | non pilotable par UI Automation dans cette version                     |
| Mission « en pause : confirmation requise »                | interruption pendant une action non idempotente                          | vérifier l'état réel, cocher l'étape et **Reprendre**                  |
| Toutes les actions refusées                                | arrêt d'urgence actif                                                    | **Réarmer HERMES**                                                     |

Diagnostic : _Historique et mémoire → Exporter le diagnostic_ (JSON masqué : versions, politique, état des workers, erreurs récentes, intégrité de l'audit). Journaux détaillés : `%APPDATA%\hermes\logs\hermes-AAAA-MM-JJ.log`.
