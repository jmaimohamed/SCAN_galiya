import "server-only";

/** Expected, user-facing failure. `message` is French and safe to show. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Session absente ou expirée — reconnectez-vous.");
export const forbidden = (message = "Action non autorisée pour votre rôle.") => new AppError(403, "FORBIDDEN", message);
export const notFound = (message = "Élément introuvable.") => new AppError(404, "NOT_FOUND", message);
export const badRequest = (message: string, details?: Record<string, unknown>) => new AppError(400, "BAD_REQUEST", message, details);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) => new AppError(409, code, message, details);

export type Role = "OPERATOR" | "ADMIN";

/** Authenticated identity — always derived from the server-side session. */
export interface Actor {
  userId: string;
  username: string;
  displayName: string | null;
  role: Role;
  sessionId: string;
}
