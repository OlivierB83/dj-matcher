/* DJ Matcher — service worker minimal.
 *
 * - Incrémenter CACHE_VERSION à chaque changement de stratégie (les anciens
 *   caches sont purgés à l'activation).
 * - Navigations : réseau d'abord, repli sur le cache (puis sur « / »).
 * - /assets/* (fichiers hachés par Vite) : cache d'abord.
 * - Jamais de cache pour le backend (dj-matcher.onrender.com, /api/) ni pour
 *   les origines tierces (pochettes iTunes/Deezer, etc.).
 */
const CACHE_VERSION = 'v1';
const CACHE_NAME = `dj-matcher-${CACHE_VERSION}`;
const PRECACHE = ['/', '/manifest.webmanifest'];
const BACKEND_HOSTS = ['dj-matcher.onrender.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

function isBackend(url) {
  return BACKEND_HOSTS.includes(url.hostname) || url.pathname.startsWith('/api/');
}

function isCacheable(response) {
  // Pas de réponse d'erreur ni de redirection en cache : une réponse redirigée
  // servie à une navigation est refusée par le navigateur.
  return response && response.ok && !response.redirected;
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const fallback = fallbackUrl ? await cache.match(fallbackUrl) : null;
    if (fallback) return fallback;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (isBackend(url)) return; // API : toujours le réseau, jamais de cache
  if (url.origin !== self.location.origin) return; // tiers : on laisse passer
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, '/'));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});
