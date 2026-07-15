// API Service Layer for OpenWA-Lab Dashboard
// Centralized API client with TypeScript types

import { warnIfInsecureHttpUrl } from '../utils/urlSecurity';

// Resolve the API base URL. By default this is the same-origin relative path '/api',
// correct when the dashboard and API are served from the same origin (the default
// single-container setup). For a split-origin deployment (dashboard hosted separately
// from the API), set VITE_API_URL at build time to the API ORIGIN — e.g.
// `VITE_API_URL=https://gateway.example.com` — and the '/api' prefix is appended here.
// Previously VITE_API_URL was documented but never read, so the dashboard always called
// same-origin '/api' and a split deployment failed with "Invalid API Key" (#91).
// Exported so direct fetches (e.g. auth/validate in Login.tsx / App.tsx) honor VITE_API_URL
// too — otherwise split-origin deployments break. Empty VITE_API_URL → '/api'.
const API_ORIGIN = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
export const API_BASE_URL = `${API_ORIGIN}/api`;
// Warn (not refuse — would break dev + TLS-terminating-proxy) when the API origin is an
// insecure http:// URL pointing at a non-localhost host (API keys sent in cleartext).
if (API_ORIGIN) warnIfInsecureHttpUrl(API_ORIGIN, 'VITE_API_URL');

// =============================================================================
// API Client
// =============================================================================

export async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  // Get API key from sessionStorage for authentication
  const apiKey = sessionStorage.getItem('openwalab_api_key');

  // For FormData (file uploads) let the browser set multipart/form-data + boundary itself.
  const isFormData = options.body instanceof FormData;
  const headers: HeadersInit = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    // The stored API key is invalid/expired/revoked — clear it and return to login
    // so the user isn't stuck on a dashboard that 401s every request.
    sessionStorage.removeItem('openwalab_api_key');
    if (typeof window !== 'undefined') {
      window.location.assign('/');
      // The page is navigating away — halt this request's promise chain so callers neither
      // throw the generic error below (flashing a toast) nor receive an undefined payload.
      return new Promise<T>(() => {});
    }
  }

  if (!response.ok) {
    // On a non-JSON body (e.g. a reverse-proxy 502/503 HTML page) fall through to `HTTP <status>`
    // rather than statusText: the status code is what the toast connection-lost de-dup matches on,
    // and statusText is empty over HTTP/2 anyway.
    const error = await response.json().catch(() => ({}));
    // Carry the HTTP status on the Error (message unchanged, so the toast de-dup still matches) so
    // callers can tell apart a permission 403 from a real server 5xx instead of guessing from text.
    const err = new Error(error.message || `HTTP ${response.status}`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

/** Like {@link request} but returns the raw response text — e.g. a plugin's HTML config-UI bundle. */
export async function requestText(endpoint: string): Promise<string> {
  const apiKey = sessionStorage.getItem('openwalab_api_key');
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    headers: { ...(apiKey ? { 'X-API-Key': apiKey } : {}) },
  });

  if (response.status === 401) {
    sessionStorage.removeItem('openwalab_api_key');
    if (typeof window !== 'undefined') {
      window.location.assign('/');
      return new Promise<string>(() => {});
    }
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.text();
}
