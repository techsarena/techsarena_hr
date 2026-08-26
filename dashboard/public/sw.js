/**
 * Service worker for Techsarena HCM.
 *
 * Scope is deliberately narrow. Three things only:
 *
 *   1. Cache the app shell so the UI opens without a network.
 *   2. Serve a readable offline page instead of the browser's error.
 *   3. Queue attendance punches taken offline and replay them on reconnect.
 *
 * What it does NOT do, on purpose:
 *
 *   * Cache API responses. Payslips, leave balances and profile data are
 *     personal, and a shared or lost device must not hold them in a cache the
 *     app cannot clear on sign-out. The app shell is public code; the data is
 *     not.
 *   * Queue anything other than punches. Replaying a leave application or an
 *     expense claim hours later, against state the user could not see, invites
 *     duplicates and decisions made on stale information. A punch is different:
 *     it is a timestamped fact about a moment that has already happened, and
 *     losing it costs the employee paid time.
 */

const VERSION = 'v1';
const SHELL_CACHE = `techsarena-shell-${VERSION}`;
const BASE = '/assets/techsarena_hr/dashboard';

// The document itself is handled network-first, so only static assets are
// precached here. Hashed bundles are added as they are requested.
const SHELL_ASSETS = [
  `${BASE}/icon-192.png`,
  `${BASE}/icon-512.png`,
  `${BASE}/favicon.svg`,
];

const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline · Techsarena HCM</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#0F172A; color:#E2E8F0; padding:24px; text-align:center; }
  .card { max-width:340px; }
  h1 { font-size:18px; margin:0 0 8px; }
  p { margin:0 0 16px; color:#94A3B8; font-size:13.5px; }
  button { font:inherit; font-weight:600; padding:9px 18px; border:0; border-radius:999px;
           background:#863bff; color:#fff; cursor:pointer; }
</style></head>
<body><div class="card">
  <h1>You're offline</h1>
  <p>Techsarena HCM needs a connection to load. Any attendance punch you made
     while offline is saved and will be sent when you reconnect.</p>
  <button onclick="location.reload()">Try again</button>
</div></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // A single missing asset must not fail the whole install, or the worker
      // never activates and nothing works offline at all.
      .then((cache) => Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('techsarena-') && key !== SHELL_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

/* ---------------------------------------------------------------- Punch queue

   Held in IndexedDB rather than Cache Storage: it is structured data with a
   read-modify-write cycle, and it must survive the worker being terminated
   between the punch and the reconnect. */

const DB_NAME = 'techsarena-offline';
const STORE = 'punches';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result.result ?? result);
    tx.onerror = () => reject(tx.error);
  }));
}

const queuePunch = (record) => withStore('readwrite', (store) => store.add(record));
const readPunches = () => withStore('readonly', (store) => store.getAll());
const dropPunch = (id) => withStore('readwrite', (store) => store.delete(id));

async function tellClients(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

/** Replays queued punches oldest-first. */
async function flushPunches() {
  let punches = [];
  try {
    punches = await readPunches();
  } catch {
    return;
  }
  if (!punches.length) return;

  punches.sort((a, b) => a.punched_at.localeCompare(b.punched_at));

  let sent = 0;
  for (const punch of punches) {
    try {
      const response = await fetch(punch.url, {
        method: 'POST',
        headers: punch.headers,
        body: JSON.stringify(punch.body),
        credentials: 'include',
      });
      // 4xx means the server refused it — already checked in, too old, session
      // gone. Retrying forever would never succeed, so drop it and let the
      // client report it rather than looping.
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        await dropPunch(punch.id);
        if (response.ok) sent += 1;
        else await tellClients({ type: 'punch-rejected', punch: { log_type: punch.body.log_type, punched_at: punch.punched_at } });
      } else {
        break; // server-side failure: keep the queue and try again later
      }
    } catch {
      break; // still offline
    }
  }
  if (sent) await tellClients({ type: 'punch-synced', count: sent });
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'flush-punches') event.waitUntil(flushPunches());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'flush-punches') event.waitUntil(flushPunches());
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});

/* ------------------------------------------------------------------- Fetch */

const isPunch = (url) => url.pathname.includes('techsarena_hr.api.check_in_out')
  || url.pathname.includes('gps_attendance.api.attendance.mark_checkin');

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  // A punch that cannot reach the server is queued rather than lost. Cloned
  // before reading: a request body can only be consumed once.
  if (request.method === 'POST' && isPunch(url)) {
    event.respondWith(handlePunch(request, url));
    return;
  }

  // Everything else that writes goes straight through. Failing loudly while
  // offline is correct for a leave application — the user must know it did not
  // send, not discover it hours later.
  if (request.method !== 'GET') return;

  // API reads are never cached: personal data must not outlive the session on
  // the device. Offline simply fails, and the UI shows its own error state.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network first, falling back to the cached shell, then to a
  // readable offline page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(async () => (await caches.match(request))
          || (await caches.match('/dashboard'))
          || new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })),
    );
    return;
  }

  // Static assets: cache first. Bundle filenames are content-hashed, so a
  // cached hit is always the right version and a new build misses cleanly.
  if (url.pathname.startsWith(BASE)) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })),
    );
  }
});

async function handlePunch(request, url) {
  const clone = request.clone();
  try {
    return await fetch(request);
  } catch {
    // Offline. Record what was punched and when, so the server can stamp the
    // real moment rather than the moment the queue happened to drain.
    let body = {};
    try {
      body = await clone.json();
    } catch {
      /* nothing usable to queue */
    }
    const punchedAt = body.punched_at || new Date().toISOString().slice(0, 19).replace('T', ' ');
    const headers = {};
    for (const [key, value] of clone.headers.entries()) {
      if (key.toLowerCase() !== 'content-length') headers[key] = value;
    }

    try {
      await queuePunch({
        url: url.pathname + url.search,
        headers,
        body: { ...body, punched_at: punchedAt },
        punched_at: punchedAt,
      });
      if ('sync' in self.registration) {
        try { await self.registration.sync.register('flush-punches'); } catch { /* best effort */ }
      }
      return new Response(
        JSON.stringify({ message: { queued: true, punched_at: punchedAt, log_type: body.log_type } }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      );
    } catch {
      return new Response(
        JSON.stringify({ message: 'Could not save your punch offline.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }
}
