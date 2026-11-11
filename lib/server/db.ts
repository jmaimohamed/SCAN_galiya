import "server-only";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * One PrismaClient per process. The connection string comes only from DATABASE_URL.
 * Prisma's own error logging is opt-in (PRISMA_LOG=error): expected conflicts such as
 * a concurrent duplicate serial are handled in code and should not flood the logs.
 */
export const prisma: PrismaClient =
  globalForPrisma.prisma ?? new PrismaClient({ log: process.env.PRISMA_LOG === "error" ? ["error"] : [] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Interactive transaction options used for every box/print mutation. */
export const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;
