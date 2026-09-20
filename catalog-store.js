/**
 * catalog-store.js — le catalogue en mémoire, avec GitHub comme stockage
 * durable (option gratuite retenue le 2026-09-20 pour la bêta).
 *
 * Problème : le disque de Render est éphémère, tout ajout fait par l'app
 * ("Ajouter au catalogue") disparaissait au redéploiement.
 *
 * Principe :
 *   - au démarrage, on charge knownTracks.json depuis la branche main de
 *     GitHub (source de vérité), avec le fichier local du déploiement en
 *     secours si GitHub ne répond pas ;
 *   - le catalogue vit ensuite en mémoire (plus de relecture/parse de 4 Mo
 *     à chaque requête) ;
 *   - chaque ajout est écrit localement ET mis en file ; au plus une fois
 *     par PUSH_DEBOUNCE_MS, la file est commitée sur main via l'API GitHub
 *     (message "[skip render] [vercel skip]" pour ne pas redéployer à
 *     chaque titre). En cas de conflit (le cron hebdo a commité entre
 *     temps), on repart de la version distante et on y rejoue les ajouts.
 *
 * Config (variables d'environnement sur Render) :
 *   GITHUB_TOKEN  — fine-grained PAT, dépôt dj-matcher, permission
 *                   "Contents: read & write". Sans lui : mode local seul
 *                   (dev), les ajouts ne sont pas persistés au-delà du disque.
 *   GITHUB_REPO   — "OlivierB83/dj-matcher" par défaut
 *   GITHUB_BRANCH — "main" par défaut
 */

import fs from "fs";
import { canonicalKey } from "./track-identity.js";

const DB_FILE = "./knownTracks.json";
const REPO = process.env.GITHUB_REPO || "OlivierB83/dj-matcher";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const TOKEN = process.env.GITHUB_TOKEN || "";
const PUSH_DEBOUNCE_MS = 60_000;
const RAW_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/knownTracks.json`;
const CONTENTS_URL = `https://api.github.com/repos/${REPO}/contents/knownTracks.json`;

let tracks = [];
let pending = []; // ajouts pas encore commités sur GitHub
let pushTimer = null;
let pushing = false;
const status = {
  source: "none",        // "github" | "local"
  loadedAt: null,
  count: 0,
  githubEnabled: Boolean(TOKEN),
  pendingCount: 0,
  lastPushAt: null,
  lastPushResult: null,  // "ok" | message d'erreur
  lastCommitSha: null,
};

function ghHeaders(extra = {}) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    ...extra,
  };
}

async function fetchRemoteCatalog() {
  const r = await fetch(RAW_URL, { headers: { "Cache-Control": "no-cache" } });
  if (!r.ok) throw new Error(`GitHub raw HTTP ${r.status}`);
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error("catalogue distant illisible");
  return data;
}

function readLocal() {
  if (!fs.existsSync(DB_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { return []; }
}

function writeLocal() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(tracks, null, 2)); } catch (e) {
    console.error("catalog-store: écriture locale impossible :", e.message);
  }
}

/** À appeler une fois au démarrage du serveur. */
export async function init() {
  const local = readLocal();
  try {
    const remote = await fetchRemoteCatalog();
    // La version GitHub est la source de vérité : elle contient les ajouts
    // poussés depuis le dernier déploiement. On garde la plus fournie des
    // deux par sécurité (un fichier distant tronqué ne doit pas effacer le local).
    if (remote.length >= local.length) {
      tracks = remote;
      status.source = "github";
      if (remote.length !== local.length) writeLocal();
    } else {
      tracks = local;
      status.source = "local";
    }
  } catch (e) {
    console.warn("catalog-store: GitHub injoignable au démarrage, fichier local utilisé :", e.message);
    tracks = local;
    status.source = "local";
  }
  status.loadedAt = new Date().toISOString();
  status.count = tracks.length;
  console.log(`Catalogue chargé : ${tracks.length} titres (${status.source})${TOKEN ? "" : " — GITHUB_TOKEN absent, ajouts non persistés sur GitHub"}`);
  return tracks;
}

/** Tableau en mémoire (ne pas muter : utiliser append). */
export function getTracks() {
  return tracks;
}

export function getStatus() {
  return { ...status, pendingCount: pending.length };
}

/** Ajoute une entrée, écrit le fichier local, programme le commit GitHub. */
export function append(entry) {
  tracks.push(entry);
  pending.push(entry);
  status.count = tracks.length;
  writeLocal();
  schedulePush();
}

function schedulePush() {
  if (!TOKEN) return;
  if (pushTimer) return;
  pushTimer = setTimeout(() => { pushTimer = null; pushToGitHub().catch(() => {}); }, PUSH_DEBOUNCE_MS);
}

async function currentSha() {
  const r = await fetch(`${CONTENTS_URL}?ref=${BRANCH}`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GitHub contents HTTP ${r.status}`);
  const j = await r.json();
  return j.sha;
}

/** Rejoue `added` sur `base` sans doublons (clé canonique artiste|titre). */
function mergeAdditions(base, added) {
  const seen = new Set(base.map((t) => canonicalKey(t.artist, t.title)));
  const out = base.slice();
  for (const t of added) {
    const k = canonicalKey(t.artist, t.title);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** Commit des ajouts en attente sur GitHub. Exporté pour un déclenchement manuel. */
export async function pushToGitHub() {
  if (!TOKEN || pushing || pending.length === 0) return getStatus();
  pushing = true;
  const batch = pending.slice();
  try {
    let sha = await currentSha();
    let content = tracks;
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = {
        message: `[skip render] [vercel skip] catalog: +${batch.length} titre(s) ajouté(s) depuis l'app`,
        content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
        sha,
        branch: BRANCH,
      };
      const r = await fetch(CONTENTS_URL, { method: "PUT", headers: ghHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) });
      if (r.ok) {
        const j = await r.json();
        status.lastCommitSha = j.commit?.sha || null;
        status.lastPushAt = new Date().toISOString();
        status.lastPushResult = "ok";
        pending = pending.filter((p) => !batch.includes(p));
        console.log(`catalog-store: ${batch.length} ajout(s) commité(s) sur GitHub (${status.lastCommitSha?.slice(0, 7)})`);
        return getStatus();
      }
      if (r.status === 409 || r.status === 422) {
        // Quelqu'un (le cron hebdo, toi) a commité entre temps : on repart
        // de la version distante et on y rejoue tous les ajouts en attente.
        const remote = await fetchRemoteCatalog();
        content = mergeAdditions(remote, pending);
        tracks = content;
        status.count = tracks.length;
        writeLocal();
        sha = await currentSha();
        continue;
      }
      throw new Error(`GitHub PUT HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    throw new Error("conflits GitHub répétés");
  } catch (e) {
    status.lastPushAt = new Date().toISOString();
    status.lastPushResult = e.message;
    console.error("catalog-store: push GitHub échoué :", e.message);
    // On réessaiera au prochain ajout ou via /api/catalog-status?push=1
    return getStatus();
  } finally {
    pushing = false;
    if (pending.length) schedulePush();
  }
}
