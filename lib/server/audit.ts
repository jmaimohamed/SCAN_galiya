import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Actor } from "./errors";

type Db = PrismaClient | Prisma.TransactionClient;

/** Append-only audit trail (UPDATE/DELETE are blocked by a database trigger). */
export async function audit(
  db: Db,
  event: {
    type: string;
    actor?: Actor | null;
    username?: string | null;
    boxId?: string | null;
    details?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await db.auditEvent.create({
    data: {
      type: event.type,
      userId: event.actor?.userId ?? null,
      username: event.actor?.username ?? event.username ?? null,
      sessionId: event.actor?.sessionId ?? null,
      boxId: event.boxId ?? null,
      details: event.details,
    },
  });
}
