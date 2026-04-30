export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Read the session token written by AuthContext after login. Many API
 * handlers gate on `Authorization: Bearer <token>` (see hub/src/web/auth.ts —
 * `requireAuth`), so every call needs to send this when present. Returning
 * null when the slot is empty / unavailable lets unauthenticated and
 * standalone-mode setups keep working.
 */
function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem('insightd-token');
  } catch {
    return null;
  }
}

export async function api<T>(path: string): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new ApiError(res.status, data.error || `API ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiAuth<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string | null,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Caller-supplied token wins (used by login flow before sessionStorage is
  // populated); otherwise fall back to the stored session token so callers
  // don't need to thread `token` through every hook.
  const effectiveToken = token ?? getStoredToken();
  if (effectiveToken) headers['Authorization'] = `Bearer ${effectiveToken}`;
  const opts: RequestInit = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api${path}`, opts);
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `API ${res.status}`);
  return data;
}
