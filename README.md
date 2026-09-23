# Otaku FAMILY
POWERED BY Mr Dracula Dev

Site de publication d'animes : fiches, épisodes vidéo, téléchargement, recherche par genre,
commentaires, notes, comptage des visiteurs, gestion des membres (promotion / bannissement)
et sauvegarde GitHub.

## Lancer en local
```bash
npm install
ADMIN_USER=dracula ADMIN_PASS=unMotDePasseSolide SESSION_SECRET=unePhrase node server.js
```
Puis ouvre http://localhost:3000

## Variables d'environnement (Render)
| Clé | Rôle |
|---|---|
| `ADMIN_USER` / `ADMIN_PASS` | compte propriétaire créé au premier démarrage |
| `SESSION_SECRET` | phrase secrète des sessions |
| `DATA_DIR` | `/data` (disque persistant Render) |
| `GITHUB_TOKEN` | token fine-grained, Contents : Read and write, uniquement sur le dépôt de sauvegarde |
| `GITHUB_BACKUP_REPO` | `TON_PSEUDO/otaku-backup` (dépôt PRIVÉ) |
| `BACKUP_INTERVAL_HOURS` | fréquence de la sauvegarde de sécurité (défaut 6) |

Ne mets jamais le token ni les mots de passe dans le code ou sur GitHub.

## Sauvegarde GitHub
Fichier `data.json` dans le dépôt privé : membres, fiches d'animes, commentaires, notes.
Mise à jour à chaque changement (regroupée sur 15 s) et toutes les 6 h.
Si la base est vide au démarrage (disque perdu), tout est restauré automatiquement.
Les vidéos et les couvertures ne sont PAS sauvegardées sur GitHub (trop lourdes) :
elles restent sur le disque persistant Render. Garde tes MP4 d'origine de ton côté.

## Vidéos
MP4 uniquement (H.264 + AAC), 2 Go max, pour la compatibilité Android et iPhone.
```bash
ffmpeg -i episode.mkv -c:v libx264 -c:a aac -movflags +faststart episode.mp4
```
