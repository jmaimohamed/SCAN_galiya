/** Business error returned by the server (4xx with a JSON error body). Not retried. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The request may or may not have reached the server (offline, timeout, 5xx). Retried with the same key. */
export class NetworkError extends Error {
  constructor(message = "Non confirmé — connexion interrompue") {
    super(message);
    this.name = "NetworkError";
  }
}

export async function apiFetch<T>(url: string, init: { method?: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: { ...init.headers, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.ok) return data as T;
  const err = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
  if (res.status >= 500 || !err) throw new NetworkError(res.status >= 500 ? "Serveur indisponible — non confirmé" : undefined);
  throw new ApiError(res.status, err.code ?? "ERROR", err.message ?? "Erreur", err.details);
}

export const isRetryable = (e: unknown) => e instanceof NetworkError;
