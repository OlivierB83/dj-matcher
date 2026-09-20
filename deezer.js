/**
 * deezer.js — client Deezer partagé par le backend (server.js) et la
 * cascade d'enrichissement (djay-enrich.js).
 *
 * L'API publique Deezer ne demande ni compte ni clé, mais elle est limitée
 * à 50 requêtes / 5 s PAR ADRESSE IP. Comme tous les utilisateurs passent
 * par le même serveur Render, cette limite est partagée : on la protège
 * par un cache mémoire (6 h) et un limiteur global (40 req / 5 s). Quand
 * le limiteur est atteint on lève DeezerLimited : l'appelant répond
 * "catalogue local seulement" plutôt que de se faire bloquer par Deezer.
 */

import {
  normalize, primaryArtist, coreTitle, stripTrunc, unparenthesizeVersionMeta,
  titleMatches, artistMatches,
} from "./track-identity.js";

const BASE = "https://api.deezer.com";
const CACHE_TTL_MS = 6 * 3600 * 1000;
const CACHE_MAX = 5000;
const WINDOW_MS = 5000;
const MAX_PER_WINDOW = 40;

const cache = new Map(); // key → { at, value }
let windowStart = 0;
let windowCount = 0;

export class DeezerLimited extends Error {
  constructor() { super("Limite de requêtes Deezer atteinte"); this.name = "DeezerLimited"; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function takeSlot() {
  const now = Date.now();
  if (now - windowStart >= WINDOW_MS) { windowStart = now; windowCount = 0; }
  if (windowCount >= MAX_PER_WINDOW) return false;
  windowCount++;
  return true;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // le plus ancien
  cache.set(key, { at: Date.now(), value });
}

async function call(path, { retry = true } = {}) {
  const cached = cacheGet(path);
  if (cached !== undefined) return cached;
  if (!takeSlot()) throw new DeezerLimited();
  const r = await fetch(BASE + path);
  const j = await r.json().catch(() => null);
  if (j?.error) {
    if (j.error.code === 4 && retry) { await sleep(1500); return call(path, { retry: false }); }
    cacheSet(path, null);
    return null;
  }
  cacheSet(path, j);
  return j;
}

/** Forme commune renvoyée aux clients et à la cascade d'enrichissement. */
export function normalizeTrack(d) {
  if (!d) return null;
  const contributors = (d.contributors || []).map((c) => c.name).filter(Boolean);
  return {
    artist: contributors.length > 1 ? contributors.join(", ") : d.artist?.name || contributors[0] || "",
    title: d.title || "",
    album: d.album?.title || null,
    year: (d.release_date || "").slice(0, 4) || null,
    image: d.album?.cover_xl || d.album?.cover_big || d.album?.cover_medium || null,
    deezerId: d.id,
    isrc: d.isrc || null,
    rank: d.rank ?? null,
    bpm: d.bpm > 0 ? Math.round(d.bpm) : null,
    previewUrl: d.preview || null,
    deezerUrl: d.link || null,
  };
}

/** Recherche libre (barre de recherche des apps). Résultats lisibles uniquement. */
export async function searchTracks(q, limit = 10) {
  const query = String(q || "").trim();
  if (!query) return [];
  const j = await call(`/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  return (j?.data || [])
    .filter((d) => d.readable !== false && d.rank > 0)
    .map(normalizeTrack);
}

export async function getTrack(id) {
  const j = await call(`/track/${id}`);
  return j && j.readable !== false ? normalizeTrack(j) : null;
}

/**
 * Trouve le morceau Deezer correspondant à (artist, title) : recherche
 * "artiste principal + titre nettoyé", validation par tokens artiste +
 * titre, artiste strictement identique en priorité, puis rang maximum
 * (même logique que refresh-popularity-deezer.js). Renvoie la fiche
 * complète (/track/{id}) pour avoir isrc, bpm, année et contributeurs.
 */
export async function findTrack(artist, title) {
  const core = coreTitle(stripTrunc(unparenthesizeVersionMeta(title)));
  const j = await call(`/search?q=${encodeURIComponent(`${primaryArtist(artist)} ${core}`)}&limit=5`);
  const candidates = (j?.data || []).filter(
    (d) => d.readable !== false && d.rank > 0 &&
      artistMatches(artist, d.artist?.name || "") && titleMatches(title, d.title || "")
  );
  if (!candidates.length) return null;
  const wantArtists = new Set([normalize(artist), normalize(primaryArtist(artist))]);
  const exact = candidates.filter((d) => wantArtists.has(normalize(d.artist?.name || "")));
  const pool = (exact.length ? exact : candidates).sort((a, b) => b.rank - a.rank);
  return getTrack(pool[0].id);
}
