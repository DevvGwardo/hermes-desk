/**
 * Nub Agent web shell service worker.
 *
 * Scope of the job: make an installed PWA open without a network round trip,
 * and show the app shell instead of the browser's offline page when the
 * connection drops. It is deliberately NOT an offline chat client — every
 * /api/ request (chat, SSE, fs, pairing) bypasses this worker entirely, so a
 * stale cache can never serve a turn or a transcript.
 *
 * Strategy per request class:
 *   navigate          network-first → cached shell. A new deploy wins as soon
 *                     as it is reachable, so the app is never pinned to an old
 *                     index.html.
 *   same-origin asset stale-while-revalidate. Vite fingerprints these, so a
 *                     cached copy is safe to serve while the fresh one lands.
 *   /api/ and other   never touched — straight to the network.
 *   cross-origin      never touched (fonts, dashboard proxy).
 */

const VERSION = 'v1'
const SHELL_CACHE = `nub-shell-${VERSION}`
const ASSET_CACHE = `nub-assets-${VERSION}`

/** Minimum shell to paint something offline. Hashed chunks are discovered
 *  from index.html at install (see below) — they cannot be listed here
 *  because Vite fingerprints them per build. */
const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
  '/favicon.png',
  '/favicon.svg',
  '/apple-touch-icon.png',
]

/**
 * Entry assets referenced by index.html (the hashed `/assets/*.js|css`).
 *
 * These MUST be pre-cached at install. On the very first visit the page loads
 * before the worker controls it, so no fetch event fires and nothing lands in
 * ASSET_CACHE — an offline relaunch would then serve index.html with no JS and
 * paint a blank screen. Reading the chunk names out of the HTML we just
 * fetched, then following their imports, is what makes the first offline
 * start work.
 */
function entryAssetUrls(html, origin) {
  const urls = new Set()
  const attr = /(?:src|href)\s*=\s*["']([^"']+)["']/gi
  let m
  while ((m = attr.exec(html))) {
    const raw = m[1]
    if (!raw) continue
    let path
    try {
      path = new URL(raw, origin)
    } catch {
      continue
    }
    if (path.origin !== origin) continue
    if (!path.pathname.startsWith('/assets/')) continue
    urls.add(path.pathname + path.search)
  }
  return [...urls]
}

/**
 * Chunks that are large and only reachable from features that need the
 * network anyway (a VM preview, a spreadsheet, a diagram). Precaching them
 * would add megabytes to install for an offline shell that cannot use them;
 * they still land in ASSET_CACHE the first time they are actually imported.
 */
const SKIP_PRECACHE = /^\/assets\/(mermaid|katex|xlsx|pdf|sanitize)-/i

/** Hard ceiling so a pathological build graph can never balloon the install. */
const MAX_PRECACHE_ASSETS = 80

/**
 * Walk the boot import graph from the entry chunks.
 *
 * `modulePreload: false` in vite.config.ts means index.html lists ONLY the
 * entry JS + CSS — every other chunk is discovered by the module loader at
 * runtime, so the offline shell has to follow the edges itself. Both static
 * (`from"./x.js"`) and dynamic (`import("./x.js")`) edges are followed: the
 * shell entry itself is a dynamic import of MobileApp/App.
 */
async function collectBootAssets(seedUrls) {
  const found = new Set()
  const queue = [...seedUrls]
  while (queue.length > 0 && found.size < MAX_PRECACHE_ASSETS) {
    const url = queue.shift()
    if (found.has(url)) continue
    if (!url.endsWith('.js')) {
      found.add(url)
      continue
    }
    if (SKIP_PRECACHE.test(url)) continue
    found.add(url)
    let text
    try {
      const res = await fetch(new Request(url, { cache: 'reload' }))
      if (!res.ok) continue
      text = await res.text()
    } catch {
      continue
    }
    // Chunk edges appear in two shapes and both must be followed:
    //   - sibling-relative module specifiers:  from"./x.js" / import("./x.js")
    //   - Vite's `__vite__mapDeps` table:      "assets/x.css"
    // The mapDeps table has no leading `./`, so a walker that only understands
    // module specifiers silently skips every preloaded stylesheet — which is
    // what left the offline shell unable to preload MobileApp.css.
    const relEdge = /["'(]\.\/([A-Za-z0-9_.-]+\.(?:js|css))/g
    const mapDepEdge = /["']assets\/([A-Za-z0-9_.-]+\.(?:js|css))["']/g
    let m
    while ((m = relEdge.exec(text))) queue.push(`/assets/${m[1]}`)
    while ((m = mapDepEdge.exec(text))) queue.push(`/assets/${m[1]}`)
  }
  return [...found]
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // Individually: one 404 must not abort the whole install.
      await Promise.all(
        SHELL_URLS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {}),
        ),
      )
      // Pull the current build's boot chunks into the ASSET cache so the
      // first offline launch has something to execute.
      try {
        const res = await fetch(new Request('/', { cache: 'reload' }))
        if (res.ok) {
          const html = await res.clone().text()
          const seeds = entryAssetUrls(html, self.location.origin)
          const assets = await collectBootAssets(seeds)
          const assetCache = await caches.open(ASSET_CACHE)
          await Promise.all(
            assets.map((url) =>
              assetCache.add(new Request(url, { cache: 'reload' })).catch(() => {}),
            ),
          )
        }
      } catch {
        /* no network at install — runtime caching still fills in later */
      }
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE])
      const names = await caches.keys()
      await Promise.all(names.map((n) => (keep.has(n) ? undefined : caches.delete(n))))
      await self.clients.claim()
    })(),
  )
})

// Page-driven update flow: the app listens for `updatefound` (a waiting
// worker appeared) and `controllerchange` (the new worker took over) and
// renders the "Update available" pill from the same banner style as the
// native update notice. This handler lets the page tell a waiting worker
// to take over immediately instead of waiting for all tabs to close.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') void self.skipWaiting()
})

/** Never cache or intercept these — a stale chat response is a bug, not a win. */
function isBypassed(url, request) {
  if (request.method !== 'GET') return true
  if (url.origin !== self.location.origin) return true
  if (url.pathname.startsWith('/api/')) return true
  // The deploy probe (src/lib/web-update.ts): a cached copy would hide every
  // new deploy from the "refresh to update" notice.
  if (url.pathname === '/version.json') return true
  // Range requests (media) must reach the network intact.
  if (request.headers.has('range')) return true
  return false
}

async function networkFirstShell(request) {
  try {
    const fresh = await fetch(request)
    if (fresh && fresh.ok) {
      const cache = await caches.open(SHELL_CACHE)
      cache.put('/', fresh.clone()).catch(() => {})
    }
    return fresh
  } catch {
    // Only the CURRENT shell cache (C-4, red-team sweep 3): a lookup without
    // cacheName searches every cache and could serve a stale shell left in a
    // previous version's cache before activate prunes it.
    const cached = await caches.match('/', { cacheName: SHELL_CACHE, ignoreVary: true })
    if (cached) return cached
    throw new Error('offline and no cached shell')
  }
}

function isHtml(res) {
  return (res.headers.get('content-type') || '').includes('text/html')
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE)
  // `ignoreVary` is load-bearing: these responses carry `Vary: Origin`, and the
  // request the precache stored under differs from the page's own request, so a
  // Vary-aware lookup misses a URL whose bytes are sitting right there.
  const cached = await cache.match(request, { ignoreVary: true })
  const network = fetch(request)
    .then((res) => {
      // Never cache an HTML page under an asset URL (an SPA fallback for a
      // chunk that no longer exists); it would keep failing as a module.
      if (res && res.ok && !isHtml(res)) cache.put(request, res.clone()).catch(() => {})
      return res
    })
    .catch(() => null)
  if (cached) {
    // Refresh in the background; the cached bytes answer this request.
    void network
    return cached
  }
  const fresh = await network
  if (fresh) return fresh
  throw new Error('asset unavailable offline')
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (isBypassed(url, request)) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request))
    return
  }
  event.respondWith(staleWhileRevalidate(request))
})
