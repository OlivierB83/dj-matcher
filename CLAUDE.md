# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DJ Matcher — a tool that suggests harmonically and rhythmically compatible tracks for a DJ set. The user searches Spotify (or the local catalog), picks a "current" track, and the app ranks suggestions from a locally-enriched catalog of tracks with BPM/key/danceability/genre metadata.

Two halves:
- **App** — Vite + React 19 frontend (`src/App.jsx`) + Express backend (`server.js`). Runs interactively for DJs.
- **Catalog pipeline** — Node scripts that import Spotify playlists and enrich tracks with audio features from external APIs into `knownTracks.json`.

**Deployment**: same git repo (`github.com/OlivierB83/dj-matcher`) deploys to two places — frontend on Vercel (`dj-matcher.vercel.app`), backend on Render. Pushing to `main` redeploys both. Local dev mirrors this split (Vite on :5173, Express on :3001).

## Commands

```
npm run dev              # Vite frontend (default port 5173)
npm run build
npm run preview
npm run lint             # ESLint flat config (eslint.config.js)
node server.js           # Backend, port 3001 (override with PORT)

# Catalog pipeline (backend must be running for the importer step)
node catalog-pipeline.js          # full pipeline: import playlists then enrich
node playlist-batch-importer.js   # just the playlist import step
node catalog-builder.js           # just the enrichment step
node merge-manual-import.js       # merge manual-import.json into knownTracks.json
```

There is no test suite.

## Architecture

### Frontend (`src/App.jsx`)

Single-file React component. The matching logic lives entirely client-side:

- `keyMap` / `toCamelot()` — converts musical keys (e.g. `C`, `F#m`, `Bb`) to Camelot wheel notation (e.g. `8B`, `11A`).
- `scoreTrack(current, candidate)` — produces a 0–100 score: BPM proximity (≤40), key compatibility via Camelot (≤35), genre overlap (10), year proximity (8), danceability proximity (7). Output includes a French human-readable `reason` string.
- `searchSpotify()` calls **both** `/api/local-search` and `/api/search`, deduplicates Spotify results that overlap the local catalog, and enriches the remaining Spotify items via `/api/enrich`. Local items are pre-enriched.
- Frontend reads `VITE_API_URL` (defaults to `http://localhost:3001`).

### Backend (`server.js`)

Express server, stateful in-memory only. Routes:

- `GET /login` → `GET /callback` — Spotify OAuth (Authorization Code flow). Access + refresh tokens are persisted to `.spotify-token.json` (gitignored). On startup the server reloads them; expired access tokens are auto-refreshed via the refresh token, so `/login` only needs to be re-run if the token file is lost (e.g. cold start on an ephemeral host).
- `GET /api/search?q=` — Spotify public search via client-credentials token (cached in `spotifyAppToken`).
- `GET /api/local-search?q=` — substring search over `knownTracks.json`.
- `GET /api/enrich?artist=&title=` — pure lookup in `knownTracks.json` (matches via `normalize(artist) + normalize(title)`). Never writes. Returns `{found: false, message: "Titre absent du catalogue local"}` on miss.
- `GET /api/known-tracks` — dump of the local catalog.
- `GET /api/import-playlist/:playlistId` — paginates the Spotify playlist API and **overwrites `catalog-input.json`** with the imported tracks.

### Catalog pipeline

Data flows: `playlists.json` → (importer hits backend) → `catalog-input.json` → (builder) → `knownTracks.json` (+ `catalog-failures.json`).

- `playlist-batch-importer.js` calls the **running backend** at `http://127.0.0.1:3001/api/import-playlist/:id` for each playlist ID/URL in `playlists.json`, then dedupes and writes `catalog-input.json`. Note: each call to the backend overwrites `catalog-input.json`, and the importer reads it back after each call — so the importer's own merge step depends on this back-and-forth file I/O via the backend.
- `catalog-builder.js` enriches `catalog-input.json` entries that aren't already in `knownTracks.json`. Tries **GetSongBPM first**, falls back to **Songstats** (which is metered/paid — see `logSongstatsRequest` and `songstats-usage-log.json`). Throttled at 120ms/track, capped at 500 tracks/run. BPM is auto-normalized to the 70–180 range (halved if >180, doubled if <70).
- `catalog-pipeline.js` orchestrates the two above and pre-flights the backend with a fetch to `/api/known-tracks`.

### Data files (canonical)

- `knownTracks.json` — the catalog. Written by `catalog-builder.js` and `merge-manual-import.js` (the backend only reads it). Avoid running enrichment scripts in parallel.
- `catalog-input.json` — staging area between import and enrichment. Overwritten freely.
- `playlists.json` — list of Spotify playlist IDs or URLs to import.
- `manual-import.json` — hand-curated tracks merged via `merge-manual-import.js`.
- `songstats-usage-log.json` / `catalog-failures.json` — operational logs.

## Environment

`.env` (loaded via `dotenv` in `server.js` and `catalog-builder.js`):

- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI` — Spotify OAuth + client credentials. `SPOTIFY_REDIRECT_URI` differs by environment (local: `http://127.0.0.1:3001/callback`; Render: the public Render URL + `/callback`) and must be whitelisted in the Spotify app dashboard.
- `GETSONGBPM_API_KEY`, `SONGSTATS_API_KEY` — used by the enrichment pipeline (`catalog-builder.js`).
- `PORT` — backend port (default 3001).
- `VITE_API_URL` — frontend → backend base URL (default `http://localhost:3001`; the Vercel deploy points this at the Render backend).

Note: `.env` and `knownTracks.json` are tracked in git. The `.gitignore` lists `.env.env` (likely a typo) rather than `.env`, so `.env` is **not** ignored. Be aware before committing changes that touch these files.

## Conventions

- ES modules everywhere (`"type": "module"` in `package.json`).
- User-facing strings (status messages, score reasons, log output) are in French — preserve the language when editing.
- Track identity across the codebase is `normalize(artist) + normalize(title)`, with `normalize()` stripping accents, parentheticals, "feat./ft./with", remix/edit/version suffixes, and punctuation. Several files duplicate this function — keep them in sync when changing matching behavior.
