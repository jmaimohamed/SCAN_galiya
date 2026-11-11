import "server-only";
import { z } from "zod";
import { prisma, TX_OPTIONS } from "../db";
import { assertAdmin } from "../permissions";
import { audit } from "../audit";
import type { Actor } from "../errors";
import { reasonSchema } from "../admin-schemas";
export const adminSettingsSchema = z.strictObject({ workstationId: z.uuid(), name: z.string().trim().min(1).max(64), widthMm: z.number().int().min(50).max(104), heightMm: z.number().int().min(50).max(200), reason: reasonSchema });
export async function updateAdminLabelSettings(actor: Actor, input: z.infer<typeof adminSettingsSchema>) {
  assertAdmin(actor);
  return prisma.$transaction(async (tx) => {
    const before = await tx.printerProfile.findUniqueOrThrow({ where: { workstationId: input.workstationId } });
    const changed = before.widthMm !== input.widthMm || before.heightMm !== input.heightMm;
    const after = await tx.printerProfile.update({ where: { workstationId: before.workstationId }, data: { name: input.name, widthMm: input.widthMm, heightMm: input.heightMm, updatedById: actor.userId, ...(changed ? { confirmedAt: null, confirmedById: null } : {}) } });
    const values = (p: typeof before) => ({ name: p.name, widthMm: p.widthMm, heightMm: p.heightMm, confirmedAt: p.confirmedAt?.toISOString() ?? null });
    await audit(tx, { type: "ADMIN_LABEL_SETTINGS", actor, details: { target: input.workstationId, reason: input.reason, before: values(before), after: values(after) } });
    return { ok: true };
  }, TX_OPTIONS);
}
