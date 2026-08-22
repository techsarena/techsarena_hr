/**
 * Frappe transport for the HR dashboard.
 *
 * Frappe wraps whitelisted method results in {"message": ...}; the REST
 * resource API wraps rows in {"data": [...]} instead. `unwrap` handles the
 * first, `resource()` reads the second itself — the same split the Flutter
 * client documents in FrappeApiClient._unwrap.
 */

const METHOD_ROOT = '/api/method';

export class ApiError extends Error {
  constructor(message, { status = 0, isUnauthorized = false, exc } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.isUnauthorized = isUnauthorized;
    this.exc = exc;
  }
}

/** Frappe puts user-facing errors in _server_messages as JSON-encoded HTML. */
function readServerMessages(payload) {
  const raw = payload?._server_messages;
  if (!raw) return null;
  try {
    const list = JSON.parse(raw);
    const text = list
      .map((entry) => {
        try {
          const parsed = JSON.parse(entry);
          return parsed.message ?? parsed.title ?? entry;
        } catch {
          return entry;
        }
      })
      .map(stripHtml)
      .filter(Boolean)
      .join('\n');
    return text || null;
  } catch {
    return stripHtml(raw) || null;
  }
}

function stripHtml(value) {
  if (typeof value !== 'string') return '';
  const el = document.createElement('div');
  el.innerHTML = value;
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}

function csrfToken() {
  // Set by www/dashboard.html in production; absent under `vite dev`, where
  // Frappe accepts the request on the session cookie alone in developer mode.
  const token = window.csrf_token;
  return token && token !== '{{ frappe.session.csrf_token }}' ? token : null;
}

async function parse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

async function request(path, { method = 'GET', params, body, signal } = {}) {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }

  const headers = { Accept: 'application/json' };
  const token = csrfToken();
  if (token) headers['X-Frappe-CSRF-Token'] = token;

  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: payload,
      credentials: 'include',
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Could not reach the server. Check your connection.', { status: 0 });
  }

  const data = await parse(response);

  if (!response.ok) {
    const message =
      readServerMessages(data) ||
      stripHtml(data?.message) ||
      data?.exception ||
      response.statusText ||
      'Request failed';
    throw new ApiError(message, {
      status: response.status,
      // 403 from Frappe means "not logged in" as often as "not allowed"; the
      // session guard decides which by re-checking the logged user.
      isUnauthorized: response.status === 401 || response.status === 403,
      exc: data?.exc_type,
    });
  }

  return data;
}

/** Call a whitelisted method and strip the {"message": ...} envelope. */
export async function call(method, params, options = {}) {
  const data = await request(`${METHOD_ROOT}/${method}`, { params, ...options });
  return data && 'message' in data ? data.message : data;
}

/** POST to a whitelisted method. Frappe reads JSON bodies for POST methods. */
export async function post(method, body, options = {}) {
  const data = await request(`${METHOD_ROOT}/${method}`, { method: 'POST', body: body ?? {}, ...options });
  return data && 'message' in data ? data.message : data;
}

/** GET /api/resource/<DocType> — wraps rows in {"data": [...]}, not "message". */
export async function resource(doctype, params, options = {}) {
  const data = await request(`/api/resource/${encodeURIComponent(doctype)}`, { params, ...options });
  return data?.data ?? [];
}

export const auth = {
  login: (usr, pwd) => post('login', { usr, pwd }),
  logout: () => post('logout'),
  currentUser: (options) => call('frappe.auth.get_logged_user', undefined, options),
};
