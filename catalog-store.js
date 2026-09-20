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
let pending = []; // opérations pas encore commitées sur GitHub : { op: "add", entry } | { op: "patch", key, fields }
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
  const r = await fetch(RAW_URL, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(20_000) });
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

/**
 * Démarrage en deux temps pour ne jamais bloquer l'écoute HTTP (Render
 * considère le déploiement échoué si le port n'est pas ouvert à temps) :
 *   1. initLocal() — synchrone, charge le fichier du déploiement ;
 *   2. refreshFromGitHub() — asynchrone, remplace par la version main si
 *      elle est au moins aussi fournie. À lancer après app.listen().
 */
export function initLocal() {
  tracks = readLocal();
  status.source = "local";
  status.loadedAt = new Date().toISOString();
  status.count = tracks.length;
  console.log(`Catalogue local chargé : ${tracks.length} titres${TOKEN ? "" : " — GITHUB_TOKEN absent, ajouts non persistés sur GitHub"}`);
  return tracks;
}

export async function refreshFromGitHub() {
  const local = tracks;
  try {
    const remote = await fetchRemoteCatalog();
    // La version GitHub est la source de vérité : elle contient les ajouts
    // poussés depuis le dernier déploiement. On garde la plus fournie des
    // deux par sécurité (un fichier distant tronqué ne doit pas effacer le local).
    if (remote.length >= local.length) {
      tracks = pending.length ? mergeAdditions(remote, pending) : remote;
      status.source = "github";
      if (tracks.length !== local.length) writeLocal();
    }
  } catch (e) {
    console.warn("catalog-store: GitHub injoignable au démarrage, fichier local conservé :", e.message);
  }
  status.loadedAt = new Date().toISOString();
  status.count = tracks.length;
  console.log(`Catalogue : ${tracks.length} titres (${status.source})`);
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
  pending.push({ op: "add", entry });
  status.count = tracks.length;
  writeLocal();
  schedulePush();
}

/**
 * Modifie des champs d'une entrée existante (ex. correction manuelle du
 * BPM). Même circuit de persistance que append. Renvoie l'entrée à jour.
 */
export function patch(index, fields) {
  const t = tracks[index];
  if (!t) return null;
  tracks[index] = { ...t, ...fields };
  pending.push({ op: "patch", key: canonicalKey(t.artist, t.title), fields });
  writeLocal();
  schedulePush();
  return tracks[index];
}

function schedulePush() {
  if (!TOKEN) return;
  if (pushTimer) return;
  pushTimer = setTimeout(() => { pushTimer = null; pushToGitHub().catch(() => {}); }, PUSH_DEBOUNCE_MS);
}

async function currentSha() {
  const r = await fetch(`${CONTENTS_URL}?ref=${BRANCH}`, { headers: ghHeaders(), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`GitHub contents HTTP ${r.status}`);
  const j = await r.json();
  return j.sha;
}

/** Rejoue les opérations en attente sur `base` (ajouts sans doublons, corrections par clé canonique). */
function mergeAdditions(base, ops) {
  const out = base.slice();
  const index = new Map(out.map((t, i) => [canonicalKey(t.artist, t.title), i]));
  for (const o of ops) {
    if (o.op === "add") {
      const k = canonicalKey(o.entry.artist, o.entry.title);
      if (index.has(k)) continue;
      index.set(k, out.length);
      out.push(o.entry);
    } else if (o.op === "patch") {
      const i = index.get(o.key);
      if (i != null) out[i] = { ...out[i], ...o.fields };
    }
  }
  return out;
}

function describeOps(ops) {
  const adds = ops.filter((o) => o.op === "add").length;
  const patches = ops.filter((o) => o.op === "patch").length;
  return [adds ? `+${adds} titre(s)` : null, patches ? `${patches} correction(s)` : null].filter(Boolean).join(", ");
}

/** Commit des opérations en attente sur GitHub. Exporté pour un déclenchement manuel. */
export async function pushToGitHub() {
  if (!TOKEN || pushing || pending.length === 0) return getStatus();
  pushing = true;
  const batch = pending.slice();
  try {
    let sha = await currentSha();
    let content = tracks;
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = {
        message: `[skip render] [vercel skip] catalog: ${describeOps(batch)} depuis l'app`,
        content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
        sha,
        branch: BRANCH,
      };
      const r = await fetch(CONTENTS_URL, { method: "PUT", headers: ghHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      if (r.ok) {
        const j = await r.json();
        status.lastCommitSha = j.commit?.sha || null;
        status.lastPushAt = new Date().toISOString();
        status.lastPushResult = "ok";
        pending = pending.filter((p) => !batch.includes(p));
        console.log(`catalog-store: ${describeOps(batch)} commité(s) sur GitHub (${status.lastCommitSha?.slice(0, 7)})`);
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
