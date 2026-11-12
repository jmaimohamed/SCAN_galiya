import "server-only";
import { z } from "zod";
import { prisma, TX_OPTIONS } from "../db";
import { assertAdmin } from "../permissions";
import { audit } from "../audit";
import type { Actor } from "../errors";
import { reasonSchema } from "../admin-schemas";
import { printerProfileSchema } from "../schemas";
import { badRequest } from "../errors";
export const adminSettingsSchema = printerProfileSchema.safeExtend({ reason: reasonSchema }).strict();
export async function updateAdminLabelSettings(actor: Actor, input: z.infer<typeof adminSettingsSchema>) {
  assertAdmin(actor);
  return prisma.$transaction(async (tx) => {
    const before = await tx.printerProfile.findUniqueOrThrow({ where: { workstationId: input.workstationId } });
    const orientation = input.orientation ?? (before.orientation === "NONE" || before.orientation === "ROTATE_90" ? before.orientation : "LANDSCAPE");
    const contentPosition = input.contentPosition ?? before.contentPosition;
    const contentLengthMm = input.contentLengthMm === undefined ? before.contentLengthMm : input.contentLengthMm;
    if (!printerProfileSchema.safeParse({ ...input, contentPosition, contentLengthMm }).success) throw badRequest("La zone imprimée doit rester dans le papier mesuré.");
    const changed = before.widthMm !== input.widthMm || before.heightMm !== input.heightMm || before.orientation !== orientation || before.contentPosition !== contentPosition || before.contentLengthMm !== contentLengthMm;
    const after = await tx.printerProfile.update({ where: { workstationId: before.workstationId }, data: { name: input.name, widthMm: input.widthMm, heightMm: input.heightMm, orientation, contentPosition, contentLengthMm, updatedById: actor.userId, ...(changed ? { confirmedAt: null, confirmedById: null } : {}) } });
    const values = (p: typeof before) => ({ name: p.name, widthMm: p.widthMm, heightMm: p.heightMm, orientation: p.orientation, contentPosition: p.contentPosition, contentLengthMm: p.contentLengthMm, confirmedAt: p.confirmedAt?.toISOString() ?? null });
    await audit(tx, { type: "ADMIN_LABEL_SETTINGS", actor, details: { target: input.workstationId, reason: input.reason, before: values(before), after: values(after) } });
    return { ok: true };
  }, TX_OPTIONS);
}
