# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DJ Matcher — a tool that suggests harmonically and rhythmically compatible tracks for a DJ set. The user searches the local catalog (plus Deezer as an external complement), picks a "current" track, and the app ranks suggestions from a locally-enriched catalog of tracks with BPM/key/danceability/genre metadata.

**No Spotify at runtime** (decided 2026-09-20, before the public iOS release): the web and iOS apps only talk to the backend, and the backend routes they use (`/api/suggestions`, `/api/local-search`, `/api/search`, `/api/add-track`, `/api/enrich`) never call Spotify. Spotify only survives in the offline playlist-import pipeline (`/login`, `/callback`, `/api/import-playlist`) and as an optional deep link in the iOS preview picker. Spotify stopped exposing `popularity` / `preview_url` to this app in 2026, so don't reintroduce it.

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
- `runSearch()` calls **both** `/api/local-search` and `/api/search` (Deezer), deduplicates external results that overlap the local catalog (canonical key), and enriches the remaining items via `/api/enrich`. Local items are pre-enriched. If the backend answers `limited: true`, the status line says the external search is temporarily limited.
- `components/CamelotTile.jsx` — generated fallback cover (hue from the Camelot wheel position, key + BPM text) used wherever a track has no artwork. Same formula as `CamelotTile` in the iOS app.
- Frontend reads `VITE_API_URL` (defaults to `http://localhost:3001`).

### Backend (`server.js`)

Express server. The catalog lives **in memory** via `catalog-store.js`: loaded from GitHub `main` at startup (raw file, the deploy's local copy as fallback), never re-read per request; `/api/add-track` appends in memory, rewrites the local file and commits the batch to GitHub through the Contents API (debounced 60 s, commit message tagged `[skip render] [vercel skip]` so a new title doesn't trigger a redeploy; on a 409/422 conflict it reloads the remote catalog and replays pending additions). This is the free-tier persistence chosen 2026-09-20: Render's disk is ephemeral, GitHub is the source of truth. Needs `GITHUB_TOKEN` on Render (without it: local-only, dev mode). `/api/catalog-status` shows source, pending count and last push result; `?push=1` forces a commit. Responses are gzip-compressed (`compression`). Routes:

- `GET /login` → `GET /callback` — Spotify OAuth (Authorization Code flow). Access + refresh tokens are persisted to `.spotify-token.json` (gitignored). On startup the server reloads them; expired access tokens are auto-refreshed via the refresh token, so `/login` only needs to be re-run if the token file is lost (e.g. cold start on an ephemeral host).
- `GET /api/search?q=` — external search via the **Deezer public API** (`deezer.js`: 6 h in-memory cache + global limiter of 40 req / 5 s, because Deezer's 50 req / 5 s quota is per IP and shared by every user behind Render). Returns `{ source: "deezer", results: [{ artist, title, album, year, image, deezerId, isrc, rank, previewUrl, deezerUrl }], limited?: true }`. Never errors on quota: `limited: true` and an empty list.
- `GET /api/local-search?q=` — substring search over `knownTracks.json`.
- `GET /api/enrich?artist=&title=` — pure lookup in `knownTracks.json` (matches via `normalize(artist) + normalize(title)`). Never writes. Returns `{found: false, message: "Titre absent du catalogue local"}` on miss.
- `GET /api/known-tracks` — dump of the local catalog.
- `POST /api/add-track` `{artist, title}` — iOS "Ajouter au catalogue": `djay-enrich.js#buildNewTrack` cascade **Deezer** (deezerId, ISRC, album, year, cover, popularity) → **getsongbpm** (BPM, key, genres) → **Songstats by ISRC** (paid) → **ReccoBeats** audio-features via the Spotify ids Songstats returns (no Spotify API call). Optional `bpm` / `key` in the body = manual entry by the DJ (source `manual`), used when no source knows a brand-new track. Persisted through `catalog-store.js` (see above).
- `POST /api/track-correct` `{artist, title, bpm?, key?}` + header `X-Editor-Code` — deliberate correction by an authorised DJ (iOS "Corriger" form with recap + confirmation). Gated by the `EDITOR_CODE` env var on Render (503 if unset, 403 if wrong): a careless DJ would pollute the shared catalog. Changed fields become `bpmSource` / `keySource: "manual"` (never overwritten by the pipeline: `djay-ax-import.js` and `normalize-catalog-bpm.js` skip manual values), analyser values kept in `bpmMeasured` / `keyMeasured`, `correctedAt` stamped, persisted via `catalog-store.patch`, answers like `/api/suggestions` re-scored.
- `GET /api/import-playlist/:playlistId` — offline pipeline only: paginates the Spotify playlist API and **overwrites `catalog-input.json`** with the imported tracks.

### Catalog pipeline

Data flows: `playlists.json` → (importer hits backend) → `catalog-input.json` → (builder) → `knownTracks.json` (+ `catalog-failures.json`).

- `playlist-batch-importer.js` calls the **running backend** at `http://127.0.0.1:3001/api/import-playlist/:id` for each playlist ID/URL in `playlists.json`, then dedupes and writes `catalog-input.json`. Note: each call to the backend overwrites `catalog-input.json`, and the importer reads it back after each call — so the importer's own merge step depends on this back-and-forth file I/O via the backend.
- `catalog-builder.js` enriches `catalog-input.json` entries that aren't already in `knownTracks.json`. Tries **GetSongBPM first**, falls back to **Songstats** (which is metered/paid — see `logSongstatsRequest` and `songstats-usage-log.json`). Throttled at 120ms/track, capped at 500 tracks/run. BPM is auto-normalized to the 70–180 range (halved if >180, doubled if <70).
- `catalog-pipeline.js` orchestrates the two above and pre-flights the backend with a fetch to `/api/known-tracks`.
- `refresh-popularity-deezer.js` — weekly popularity refresh from the Deezer public API (`rank` 0–1 000 000 → `popularity` 0–100, "Populaires" threshold raised to 85 in both apps because Deezer ranks skew high). Run by the GitHub Actions cron in `.github/workflows/refresh-popularity.yml` (Sundays 03:00 UTC; GitHub auto-disables it after 60 days without commits — re-enable from the Actions tab). Spotify stopped returning `popularity` and `preview_url` to this app in 2026, so don't try to refresh popularity from Spotify or ReccoBeats. `--cache-only` / `--apply-cache` split the network step from the catalog write when another script is writing `knownTracks.json`.
- `migrate-covers-itunes.js` — one-off, resumable migration of cover URLs from the Spotify CDN to the iTunes Search API (`image` on mzstatic.com, plus `appleUrl` and `imageSource: "itunes"`), so the apps don't touch Spotify at runtime. iTunes hard-blocks (HTTP 403) after ~600 requests per cycle unless throttled to ~2 s/request; the script persists every 25 entries and skips entries already migrated, so just relaunch it after a cooldown.
- `backfill-covers-deezer.js` — complement for entries iTunes could not find: takes the album cover from Deezer via the `deezerId` resolved by the popularity script (`imageSource: "deezer"`). After both scripts (2026-09-13) only ~74 entries still point at i.scdn.co and ~31 have no cover. `imageSource` values: `itunes`, `deezer`, or absent (legacy Spotify CDN).

### Data files (canonical)

- `knownTracks.json` — the catalog. Written by `catalog-builder.js`, `merge-manual-import.js`, the migration scripts, the weekly popularity workflow, and (on Render, via GitHub commits) the backend's `/api/add-track`. Always `git pull` before running a local script that writes it, so you don't overwrite app-side additions. Avoid running enrichment scripts in parallel.
- `catalog-input.json` — staging area between import and enrichment. Overwritten freely.
- `playlists.json` — list of Spotify playlist IDs or URLs to import.
- `manual-import.json` — hand-curated tracks merged via `merge-manual-import.js`.
- `songstats-usage-log.json` / `catalog-failures.json` — operational logs.

## Environment

`.env` (loaded via `dotenv` in `server.js` and `catalog-builder.js`):

- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI` — Spotify OAuth + client credentials. `SPOTIFY_REDIRECT_URI` differs by environment (local: `http://127.0.0.1:3001/callback`; Render: the public Render URL + `/callback`) and must be whitelisted in the Spotify app dashboard.
- `GETSONGBPM_API_KEY`, `SONGSTATS_API_KEY` — used by the enrichment pipeline (`catalog-builder.js`).
- `GITHUB_TOKEN` — fine-grained personal access token scoped to this repo with *Contents: read and write*; lets the Render backend commit app-side catalog additions to `main` (`catalog-store.js`). Optional `GITHUB_REPO` / `GITHUB_BRANCH` override the defaults.
- `EDITOR_CODE` — shared secret typed once in the iOS settings by trusted DJs; required by `/api/track-correct`. Unset = corrections disabled.
- `PORT` — backend port (default 3001).
- `VITE_API_URL` — frontend → backend base URL (default `http://localhost:3001`; the Vercel deploy points this at the Render backend).

Note: `.env` and `knownTracks.json` are tracked in git. The `.gitignore` lists `.env.env` (likely a typo) rather than `.env`, so `.env` is **not** ignored. Be aware before committing changes that touch these files.

## Conventions

- ES modules everywhere (`"type": "module"` in `package.json`).
- User-facing strings (status messages, score reasons, log output) are in French — preserve the language when editing.
- Track identity across the codebase is `normalize(artist) + normalize(title)`, with `normalize()` stripping accents, parentheticals, "feat./ft./with", remix/edit/version suffixes, and punctuation. Several files duplicate this function — keep them in sync when changing matching behavior.
