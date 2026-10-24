# DJ Matcher

**Vous passez la musique ? DJ Matcher vous souffle la suite.**

DJ Matcher écoute le morceau qui joue dans la pièce, le reconnaît (reconnaissance musicale d'Apple sur iPhone) et propose aussitôt les titres qui s'enchaînent bien : BPM proche, tonalité compatible sur la roue de Camelot, même famille de style, dansabilité voisine. Chaque suggestion affiche pourquoi elle marche. Pas besoin d'être DJ. Gratuit, sans compte, sans publicité, sans traceur.

- **Essayer dans le navigateur** : https://dj-matcher.vercel.app (recherche par texte, même catalogue, même moteur)
- **Présentation** : https://dj-matcher.vercel.app/decouvrir · English: https://dj-matcher.vercel.app/en
- **iPhone / iPad** : lien TestFlight et App Store à venir (voir la page de présentation)
- **Confidentialité** : https://dj-matcher.vercel.app/confidentialite

## Ce qu'il y a dans ce dépôt

| Partie | Rôle |
|---|---|
| `src/` | Application web (React 19 + Vite). Le score de compatibilité est calculé côté client : BPM (≤ 40 pts), tonalité Camelot (≤ 35), style (10), année (8), dansabilité (7). |
| `server.js` | Backend Express : recherche locale, recherche externe (Deezer), suggestions, ajout d'un titre inconnu, corrections réservées aux profils éditeurs. Déployé sur Render. |
| `knownTracks.json` | Le catalogue partagé : ~5 050 titres, chacun avec BPM et tonalité (pop, dance/house, rock, rap FR/US, variété, soul/funk, latin, reggae ; années 1960 → 2026). |
| `*-import*.js`, `*-enrich*.js`, `catalog-*.js` | Pipeline hors ligne d'import et d'enrichissement du catalogue (Deezer, GetSongBPM, Songstats, ReccoBeats). |
| `public/` | Site statique : page de présentation, politique de confidentialité, manifeste PWA. |

L'application iPhone (SwiftUI, ShazamKit) vit dans un dépôt séparé.

## Lancer en local

```bash
npm install
node server.js          # backend sur :3001
npm run dev             # frontend Vite sur :5173 (VITE_API_URL=http://localhost:3001)
```

## Contribuer au catalogue

Un titre absent ? Dans l'appli iPhone, « Ajouter au catalogue » l'enrichit automatiquement (BPM, tonalité, pochette). Une erreur de BPM ou de tonalité ? Les corrections passent par les profils éditeurs ; écrivez-moi.

## English

DJ Matcher hears the track playing in the room, identifies it (Apple's music recognition on iPhone) and instantly suggests the next tracks that mix well: close BPM, compatible Camelot key, same style family, similar danceability, with the reason shown. No DJ skills needed. Free, no account, no ads, no tracking. Try the web version at https://dj-matcher.vercel.app (text search); the iPhone app is coming to the App Store. Presentation in English: https://dj-matcher.vercel.app/en

---
Projet indépendant d'Olivier Baudet (France). Licence : tous droits réservés sur le catalogue et le code sauf mention contraire.
