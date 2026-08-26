/**
 * Offline state and the service worker's lifecycle.
 *
 * Two things the UI needs to know: whether we are online, and whether any
 * attendance punch is sitting in the queue waiting to be sent. Both are shown
 * rather than hidden — an employee who punched offline must be able to see that
 * it has not reached the server yet, or they will punch again.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const OfflineContext = createContext(null);

// Served from /dashboard/sw.js rather than the asset path: a worker may only
// control paths at or below where it was served from, and /assets goes through
// Werkzeug's static middleware where no header can be added. www/service_worker
// re-serves the built file here, and an after_request hook supplies the content
// type and Service-Worker-Allowed scope.
const SW_URL = '/dashboard/sw.js';
const SW_SCOPE = '/dashboard';

/** Reads the queue directly so the badge survives a page reload. */
function countQueued() {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve(0);
    let settled = false;
    const done = (n) => { if (!settled) { settled = true; resolve(n); } };
    try {
      const request = indexedDB.open('techsarena-offline', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('punches')) {
          db.createObjectStore('punches', { keyPath: 'id', autoIncrement: true });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('punches')) return done(0);
        const tx = db.transaction('punches', 'readonly');
        const count = tx.objectStore('punches').count();
        count.onsuccess = () => done(count.result || 0);
        count.onerror = () => done(0);
      };
      request.onerror = () => done(0);
    } catch {
      done(0);
    }
  });
}

export function OfflineProvider({ children }) {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [queued, setQueued] = useState(0);
  const [updateReady, setUpdateReady] = useState(false);

  const refreshQueue = useCallback(() => {
    countQueued().then(setQueued).catch(() => {});
  }, []);

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      // Ask the worker to drain immediately rather than waiting for the
      // browser's own Background Sync, which Safari does not implement.
      navigator.serviceWorker?.controller?.postMessage({ type: 'flush-punches' });
    };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    refreshQueue();
    if (!('serviceWorker' in navigator)) return undefined;

    // Registered only for the built app: under `vite dev` the bundle paths the
    // worker caches do not exist, and a stale worker there is pure confusion.
    if (import.meta.env.DEV) return undefined;

    let cancelled = false;
    navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE })
      .then((registration) => {
        if (cancelled) return;
        registration.addEventListener('updatefound', () => {
          const next = registration.installing;
          next?.addEventListener('statechange', () => {
            // A new worker parked in `waiting` means a newer build is ready and
            // the page is still running the old one.
            if (next.state === 'installed' && navigator.serviceWorker.controller) setUpdateReady(true);
          });
        });
      })
      .catch(() => { /* offline support is optional; the app works without it */ });

    const onMessage = (event) => {
      const { type } = event.data || {};
      if (type === 'punch-synced' || type === 'punch-rejected') refreshQueue();
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener('message', onMessage);
    };
  }, [refreshQueue]);

  const value = useMemo(
    () => ({ online, queued, updateReady, refreshQueue }),
    [online, queued, updateReady, refreshQueue],
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline() {
  // Forgiving outside the provider, so a component in a test still renders.
  return useContext(OfflineContext) || { online: true, queued: 0, updateReady: false, refreshQueue: () => {} };
}
