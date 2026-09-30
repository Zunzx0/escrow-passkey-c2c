export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * Thin fetch wrapper. Always sends the session cookie (credentials:
 * "include") — the backend uses cookie-based sessions, not tokens. Every
 * non-2xx response is turned into an ApiError with the backend's own
 * message, so callers can show it directly instead of a generic
 * "something went wrong".
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const message = (body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : null) ?? `Yêu cầu thất bại (${res.status})`;
    throw new ApiError(res.status, message, body);
  }

  return body as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path);
}

export function apiPost<T>(path: string, data?: unknown): Promise<T> {
  return apiFetch<T>(path, { method: "POST", body: data !== undefined ? JSON.stringify(data) : undefined });
}
