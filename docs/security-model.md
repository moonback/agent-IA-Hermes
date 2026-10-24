# Modèle de sécurité et permissions

## Principes

1. Le modèle propose, le **code** décide. Aucun appel d'outil n'atteint le système sans passer par `ToolExecutor` et `evaluatePolicy`.
2. Refus par défaut : outil inconnu, outil désactivé ou indisponible, agent non autorisé, outil absent de l'étape planifiée, chemin hors des dossiers autorisés, commande hors liste, arrêt d'urgence actif.
3. Le contenu observé (pages, fichiers, fenêtres, sorties de commandes) est une donnée non fiable : il ne peut ni accorder une permission, ni modifier une règle, ni contourner une approbation. Test : `tests/security` (« injection de prompt dans une page »).

## Ce qui est contrôlé

| Ressource         | Contrôle                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fichiers          | chemin absolu canonicalisé (liens/jonctions résolus), refus UNC, périphériques, flux alternatifs, noms réservés ; doit être sous un dossier autorisé. Aucun outil de suppression. Écrasement : approbation + copie de l'original. Déplacements : approbation (règle modifiable), jamais d'écrasement.                                         |
| Commandes         | liste d'exécutables (défaut : node, npm, git), lancement **sans shell** avec arguments séparés, options dangereuses refusées (git -c, --upload-pack…), environnement épuré (aucun secret), délai et sortie bornés, arrêt de l'arbre de processus. Toute commande hors lecture seule (git status/diff/log, npm test…) demande une approbation. |
| Réseau navigateur | domaines autorisés ; domaine inconnu : approbation (ou refus selon la politique) ; toute navigation de premier niveau est filtrée dans le contexte Playwright (liens, redirections) ; téléchargements désactivés ; champs mot de passe/paiement refusés.                                                                                      |
| Bureau            | actions sémantiques UI Automation uniquement (pas de coordonnées) ; fenêtre revérifiée (handle + titre + processus observés) avant chaque action ; application non autorisée → approbation ; raccourcis limités à une liste, ALT+F4/CTRL+W/SUPPR → approbation.                                                                               |
| Clé OpenRouter    | coffre du système, jamais renvoyée à l'interface ; URL de base limitée à `https://openrouter.ai/api/v1` ; masquage dans journaux, événements, erreurs, base.                                                                                                                                                                                  |
| Service local     | écoute 127.0.0.1, jeton de 256 bits par lancement, contrôle de l'en-tête Host (rebinding DNS) et de l'Origin, corps ≤ 1 Mo.                                                                                                                                                                                                                   |

## Approbations

Une approbation est liée à **un outil et au hachage exact de ses arguments**, consommée une seule fois (`consumeApproval`). Elle présente l'action, les paramètres exacts et les conséquences. Déclencheurs : risque élevé, règle « toujours », écrasement de fichier, déplacement, commande non en lecture seule, domaine ou application non autorisés, libellé sensible (envoyer, publier, acheter, payer, supprimer, confirmer, valider…) — détection heuristique par libellé, signalée comme telle.

Règles par outil (page _Outils et permissions_) : _Selon le risque_ (défaut), _Toujours_, _Jamais_ — « Jamais » ne lève pas les approbations liées à une ressource non autorisée.

## Limites d'isolation (honnêtes)

- Les processus lancés par `process.run` s'exécutent **avec vos droits utilisateur**. Il n'y a ni limitation réseau, ni limitation mémoire stricte sous Windows dans cette version : la protection repose sur la liste de commandes, l'absence de shell, l'approbation et le délai. Un `npm test` exécute du code du projet.
- Le worker bureau est un processus PowerShell séparé et non élevé (`-ExecutionPolicy Bypass` ne s'applique qu'à ce processus pour exécuter le script fourni).
- La détection d'actions sensibles par libellé est heuristique.

## Arrêt d'urgence

Bouton permanent en haut de l'interface : bloque toute nouvelle action, annule les tâches, tue les processus lancés, ferme les navigateurs, passe les missions en `interrupted`, expire les approbations et liste les actions au résultat incertain. Reprise uniquement après **Réarmer**.

## Audit

`mission_events` est en ajout seul (déclencheurs SQLite) et chaîné par SHA-256 ; _Vérifier l'intégrité_ détecte une modification faite hors de HERMES. Sont journalisés : création de mission, changements d'état, appels d'outils, décisions de politique, approbations, résultats, erreurs, verdicts.

## Mémoire

Les souvenirs sont masqués avant stockage ; les entrées créées par un agent sont « non validées » (confiance 0,3) ; les préférences ne sont ajoutées que par l'utilisateur ; tout est modifiable et supprimable dans _Historique et mémoire_.

## Voix (Gemini Live)

- L'agent vocal **n'exécute aucun outil** : il passe par l'orchestrateur. Toute action reste une mission planifiée, soumise à la politique, aux approbations, aux budgets et à l'audit.
- Lancer ou annuler une mission demande une confirmation orale explicite (`confirmed: true`). Les **approbations ne se donnent jamais à la voix**, seulement à l'écran.
- Les commandes spéciales ne se déclenchent que si l'énoncé entier est la commande. L'arrêt d'urgence vocal est immédiat, car il ne fait que réduire ce que HERMES peut faire.
- Les transcriptions sont des données non fiables : nettoyées, plafonnées et étiquetées comme telles quand elles accompagnent une mission. Le texte prononcé n'est pas écrit dans le journal d'audit (seulement des compteurs).
- Le WebSocket vocal suit les mêmes contrôles d'hôte et d'origine que l'API. Il exige un ticket à usage unique de 30 s obtenu avec le jeton de session. Une seule session à la fois, trames limitées à 64 Kio.
- La clé Google est stockée dans le coffre (`GEMINI_API_KEY`) et envoyée uniquement en en-tête vers `*.googleapis.com` (URL validées). Elle est masquée dans les journaux et jamais renvoyée à l'interface.
