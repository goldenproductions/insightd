export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
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
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts: RequestInit = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api${path}`, opts);
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `API ${res.status}`);
  return data;
}
