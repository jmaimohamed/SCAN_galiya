import { api, jsonOk } from "@/lib/server/http";
import { parseId } from "@/lib/server/schemas";
import { assertBoxAccess } from "@/lib/server/permissions";
import { getBoxWorkState } from "@/lib/server/services/boxes";
import { isLeaseHolder } from "@/lib/server/services/boxes";
import { prisma } from "@/lib/server/db";

/** Authoritative live state of a box (used to reconcile the control page). */
export const GET = api<{ params: Promise<{ id: string }> }>(async (req, { params, actor }) => {
  const id = parseId((await params).id);
  await assertBoxAccess(actor, id);
  const state = await getBoxWorkState(id);
  const box = await prisma.box.findUniqueOrThrow({ where: { id } });
  const token = req.headers.get("x-box-lease");
  return jsonOk({ ...state, ...(token ? { leaseValid: !!box.activeAttemptId && isLeaseHolder(box, actor, token) } : {}) });
});
