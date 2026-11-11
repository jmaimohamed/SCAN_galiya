/** Load .env for standalone scripts (Next.js loads it itself for the app). */
export function loadEnv(): void {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env file: rely on the process environment.
  }
}

/** Host/port/database of a connection string, without credentials (safe to print). */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}/${decodeURIComponent(u.pathname.slice(1))}`;
  } catch {
    return "(URL invalide)";
  }
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}
