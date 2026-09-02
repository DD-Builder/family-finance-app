// Finance HQ service worker — stale-while-revalidate for static assets,
// network-first for HTML, never-cached for the price API. Built by hand
// (no Workbox) so the runtime cost is zero and the cache rules are easy
// to audit.
//
// Bump CACHE_NAME on every shape change to the cache rules below so the
// activate handler purges old caches and the next reload re-populates.
//
// History:
//   v5 (2026-04-27) — disabled by boot.js after the broken Option B deploy
//                     left users with a poisoned cache-first SW.
//   v6 (2026-05-01) — re-enabled, rewritten with SWR for assets so a
//                     poisoned asset can be replaced on the very next
//                     navigation instead of persisting indefinitely.
//   v7 (2026-08-05) — precache the self-hosted variable fonts so an
//                     offline first-load renders Inter, not the
//                     system fallback (fonts left Google's CDN).
const CACHE_NAME = 'finance-hq-3.5.2-63082229';
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './fonts/InterVariable.woff2',
  './fonts/InterVariable-Italic.woff2',
  './fonts/JetBrainsMonoVariable.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => {
        // Precache failures shouldn't block installation — the SW will
        // still take over and fall back to network on first request.
      }),
  );
  // Don't auto-skipWaiting; the page asks us to (via SKIP_WAITING) only
  // after the user accepts the "update available" toast. This keeps the
  // running app stable while the new SW is in 'waiting'.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// The page posts { type: 'SKIP_WAITING' } when the user accepts the
// update toast — this is the one path that lets a waiting SW take over.
self.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object') return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  // Phase X · X-1 — vault-key cache. Hold the user's derived CryptoKey
  // (and audit-HMAC key) in service-worker RAM instead of caching the
  // raw passphrase in sessionStorage. SW RAM is not DOM-readable —
  // XSS / malicious extensions / same-origin iframes can post to the
  // SW but cannot read its module-level variables. The "weakest link"
  // moves from "passphrase reachable from DOM" to "key reachable only
  // via a message to this SW from this origin," which is the same
  // origin-isolation guarantee the whole crypto story rides on.
  //
  // Storage shape: a single key bag keyed off `accountId` (which the
  // main thread derives from the account sentinel). One bag at a time
  // — switching accounts overwrites the bag.
  //
  // Lifecycle: the SW is killed on browser quit; on a long-idle interval
  // by the browser; or explicitly by the main thread calling CLEAR.
  // When the SW is killed, the bag is gone and the user re-prompts on
  // next reload. This is the intended UX — no SW persistence layer.
  // closed: F-RT-P0-2 — per-client capability binding. The accountId
  // (== public sentinel salt) is readable from any same-origin
  // context's localStorage, so any popup / iframe / extension content
  // script could previously ask for the live key bag without
  // authenticating. The browser stamps every postMessage with the
  // sender's stable Client ID (`event.source.id`), which is opaque to
  // the page itself and is the same ID across same-Client navigations
  // but DIFFERENT for every distinct Client (top-level tab, iframe,
  // worker, etc.). We bind the bag to the Client that wrote it and
  // refuse reads from any other Client; cross-tab access now requires
  // a re-prompt (intentional UX trade-off vs the silent lift).
  const requesterClientId =
    event.source && typeof event.source.id === 'string' ? event.source.id : null;
  if (event.data.type === 'KEY_CACHE_SET') {
    if (!requesterClientId) {
      respond(event, { ok: false, reason: 'no-client-id' });
      return;
    }
    keyBag = {
      accountId: event.data.accountId,
      clientId: requesterClientId,
      vaultKey: event.data.vaultKey,
      auditHmacKey: event.data.auditHmacKey,
      // No salt / iters / passphrase stored — those stay in the main
      // thread's transient memory during unlock and get discarded.
    };
    respond(event, { ok: true });
    return;
  }
  if (event.data.type === 'KEY_CACHE_GET') {
    if (!keyBag || keyBag.accountId !== event.data.accountId) {
      respond(event, { ok: false, reason: 'no-key' });
      return;
    }
    if (!requesterClientId || keyBag.clientId !== requesterClientId) {
      // F-RT-P0-2: a different same-origin client (iframe / popup /
      // extension) cannot lift the live key bag, even though it
      // knows the public accountId. The unlocking tab is the only
      // Client with the right opaque id.
      respond(event, { ok: false, reason: 'wrong-client' });
      return;
    }
    respond(event, {
      ok: true,
      vaultKey: keyBag.vaultKey,
      auditHmacKey: keyBag.auditHmacKey,
    });
    return;
  }
  if (event.data.type === 'KEY_CACHE_CLEAR') {
    // CLEAR is also client-bound — a hostile same-origin context
    // shouldn't be able to nuke the unlocking tab's session. Only the
    // owning client (or any client when no bag is set) succeeds.
    if (keyBag && keyBag.clientId !== requesterClientId) {
      respond(event, { ok: false, reason: 'wrong-client' });
      return;
    }
    keyBag = null;
    respond(event, { ok: true });
    return;
  }
});

// Module-level RAM only — never written to IndexedDB, Cache API,
// localStorage, or any other persistence layer.
let keyBag = null;

function respond(event, payload) {
  // Prefer the dedicated MessagePort if the caller supplied one;
  // otherwise broadcast on the source client (rare path).
  const port = event.ports && event.ports[0];
  if (port) {
    try {
      port.postMessage(payload);
    } catch {
      // SW message ports can throw if the page has navigated away
      // between request and response; swallow.
    }
    return;
  }
  if (event.source && typeof event.source.postMessage === 'function') {
    try {
      event.source.postMessage(payload);
    } catch {
      // Same — swallow.
    }
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET (POST/PUT/DELETE etc. don't belong in a cache).
  if (request.method !== 'GET') return;

  // Never intercept the version manifest. The runtime version-check fetches
  // it with `cache: 'no-store'` to learn what's deployed RIGHT NOW; if the SW
  // served it stale-while-revalidate from the Cache API, a tab could keep
  // reading its own old buildId and never notice a newer deploy — the exact
  // caching trap the version-check exists to break. Let it hit the network
  // untouched (bypassing this SW entirely).
  if (new URL(request.url).pathname.endsWith('/version.json')) return;

  // Phase U Sprint 7-D — close P0-AMP-D-10 / upgrade-priority Tier C #39.
  // GitHub Pages does not honor public/_headers, so the three audit-
  // named security headers (X-Frame-Options, Referrer-Policy,
  // Permissions-Policy) are unenforced in prod. Inject them here for
  // every same-origin GET response served from the service worker —
  // this catches every navigation + asset fetch.
  //
  // Per W3C spec these headers can also be sent via service-worker
  // response rewriting; same-origin only (cross-origin responses are
  // opaque to the SW). Cf. mdn:Service_Worker_API.
  function withSecurityHeaders(res) {
    if (!res || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
    const url = (() => {
      try {
        return new URL(res.url || request.url);
      } catch {
        return null;
      }
    })();
    if (url && url.origin !== self.location.origin) return res;
    try {
      const headers = new Headers(res.headers);
      if (!headers.has('X-Frame-Options')) headers.set('X-Frame-Options', 'DENY');
      if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'no-referrer');
      if (!headers.has('Permissions-Policy')) {
        headers.set(
          'Permissions-Policy',
          'accelerometer=(), camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()',
        );
      }
      if (!headers.has('X-Content-Type-Options')) {
        headers.set('X-Content-Type-Options', 'nosniff');
      }
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    } catch {
      return res;
    }
  }

  // Never cache user-specific or freshness-critical endpoints. The
  // price API was already here; Phase R · Sprint 6 / SEC-INJ P1 added
  // the Ethereum balance providers (Alchemy / Cloudflare / Ankr / Infura)
  // whose responses contain per-user wallet balances. The SWR cache
  // would otherwise persist them in the SW Cache long after sign-out.
  //
  // Phase U Sprint 6 — F-OPS-P0-3 fix. Phase S landed five additional
  // price/oracle providers (coingecko, treasury, stooq, finnhub,
  // coinbase) and one streaming endpoint (advanced-trade-ws). All of
  // them either carry freshness-critical quotes or could carry per-
  // session correlation IDs in headers; SW caching is wrong for all.
  if (
    request.url.includes('api.crypto.com') ||
    request.url.includes('alchemy.com') ||
    request.url.includes('alchemyapi.io') ||
    request.url.includes('cloudflare-eth.com') ||
    request.url.includes('ankr.com') ||
    request.url.includes('infura.io') ||
    request.url.includes('api.coingecko.com') ||
    request.url.includes('home.treasury.gov') ||
    request.url.includes('stooq.com') ||
    request.url.includes('finnhub.io') ||
    request.url.includes('advanced-trade-ws.coinbase.com') ||
    request.url.includes('api.coinbase.com') ||
    // FIX-11 — these two joined connect-src after the list above was written.
    // FMP carries the user's API KEY in the query string, so the SWR catch-all
    // was persisting the key on disk in the Cache Storage URL index past
    // sign-out. alternative.me is freshness-critical sentiment.
    request.url.includes('financialmodelingprep.com') ||
    request.url.includes('api.alternative.me')
  ) {
    return;
  }

  // Network-first for HTML so app updates propagate immediately on
  // reload; on offline, fall back to the cached document.
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          return withSecurityHeaders(res);
        })
        .catch(() =>
          caches
            .match(request)
            .then((r) => r || caches.match('./index.html'))
            .then((cached) => (cached ? withSecurityHeaders(cached) : cached)),
        ),
    );
    return;
  }

  // Stale-while-revalidate for static assets. The cached response (if
  // any) is served immediately; the network revalidation happens in
  // parallel and updates the cache for the NEXT load. This is the key
  // contrast with v5's cache-first: a poisoned asset is replaced on the
  // following request, not pinned forever.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((res) => {
            if (res && res.ok) {
              cache.put(request, res.clone()).catch(() => {});
              // Phase R · Sprint 6 finisher / OPS P1. Cap the cache
              // at MAX_CACHE_ENTRIES so a long-running session
              // can't grow it unbounded. Eviction is FIFO over the
              // request keys, which approximates LRU well enough
              // for our access pattern (assets are write-once,
              // read-many during a session).
              capCacheSize(cache, MAX_CACHE_ENTRIES).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached
          ? Promise.resolve(withSecurityHeaders(cached))
          : networkFetch.then((res) => (res ? withSecurityHeaders(res) : res));
      }),
    ),
  );
});

const MAX_CACHE_ENTRIES = 100;

async function capCacheSize(cache, max) {
  const keys = await cache.keys();
  if (keys.length <= max) return;
  // Evict the oldest entries (FIFO over insertion order, which the
  // Cache API preserves). We keep the most-recent `max` keys.
  const toEvict = keys.slice(0, keys.length - max);
  await Promise.all(toEvict.map((k) => cache.delete(k)));
}
