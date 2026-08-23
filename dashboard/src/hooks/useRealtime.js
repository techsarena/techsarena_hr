import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

/**
 * Frappe socket.io transport.
 *
 * Replaces the app's previous model of "fetch once at bootstrap and never look
 * again", where an approver deciding a request in one tab left every other tab
 * showing it as still pending until a manual reload.
 *
 * One shared connection for the whole app: socket.io multiplexes, and opening a
 * socket per subscriber would burn a file descriptor per mounted screen.
 */

const EVENT = 'techsarena_hr';

let socket = null;
let refCount = 0;
const listeners = new Set();

/** Frappe serves socket.io on its own port, proxied under the site host.
 *
 *  In production the page is served by Frappe itself, so the same origin works
 *  and the reverse proxy forwards /socket.io. Under `vite dev` the page is on
 *  Vite's port, so the connection has to name the socketio port explicitly. */
function socketUrl() {
  const { protocol, hostname, host } = window.location;
  if (import.meta.env.DEV) {
    const port = import.meta.env.VITE_SOCKETIO_PORT || 9000;
    return `${protocol}//${hostname}:${port}`;
  }
  return `${protocol}//${host}`;
}

function ensureSocket() {
  if (socket) return socket;
  socket = io(socketUrl(), {
    withCredentials: true,
    // Frappe authenticates the socket from the session cookie. Polling first
    // lets that cookie ride the handshake through proxies that mangle a raw
    // websocket upgrade, then it upgrades.
    transports: ['polling', 'websocket'],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });
  socket.on(EVENT, (payload) => {
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch {
        /* one bad subscriber must not stop the rest */
      }
    }
  });
  return socket;
}

function release() {
  refCount -= 1;
  if (refCount <= 0 && socket) {
    socket.disconnect();
    socket = null;
    refCount = 0;
  }
}

/**
 * Subscribe to app realtime events.
 *
 * `handler` receives `{event, ...payload}` — see `_publish` in api.py for the
 * event names. The handler is held in a ref so a caller passing an inline
 * arrow function does not tear the socket down and rebuild it on every render.
 *
 * `enabled` gates the connection: there is no point holding a socket open for a
 * logged-out visitor sitting on the login screen.
 */
export function useRealtime(handler, { enabled = true } = {}) {
  const handlerRef = useRef(handler);

  // Kept current in an effect rather than assigned during render: a ref write
  // in the render body runs on every attempt, including ones React discards.
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!enabled) return undefined;

    const listener = (payload) => handlerRef.current?.(payload);
    listeners.add(listener);
    refCount += 1;
    ensureSocket();

    return () => {
      listeners.delete(listener);
      release();
    };
  }, [enabled]);
}

export default useRealtime;
