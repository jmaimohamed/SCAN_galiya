import "server-only";
import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id (the @node-rs/argon2 default algorithm) with the OWASP baseline
 * parameters: 19 MiB memory, 2 iterations, 1 lane.
 */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/** Spend the same work for unknown user IDs so response time does not reveal them. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("galia-control-timing-equalizer");
  await verifyPassword(await dummyHash, password);
}
