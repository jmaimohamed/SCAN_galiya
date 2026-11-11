import { audit } from "@/lib/server/audit";
import { prisma, TX_OPTIONS } from "@/lib/server/db";
import { assertPrintableReport } from "@/lib/server/services/printing";
import { assertReportAccess } from "@/lib/server/permissions";
import { api, jsonOk } from "@/lib/server/http";
import { parseId } from "@/lib/server/schemas";

/** Audit an A4 fallback print request (opening the dialog does not prove paper was printed). */
export const POST = api<{ params: Promise<{ id: string }> }>(async (_req, { params, actor }) => {
  const id = parseId((await params).id);
  await assertReportAccess(actor, id);
  return prisma.$transaction(async (tx) => {
    const report = await assertPrintableReport(tx, id);
    const previous = await tx.auditEvent.count({ where: { boxId: report.boxId, type: "A4_PRINT_REQUESTED" } });
    await audit(tx, { type: "A4_PRINT_REQUESTED", actor, boxId: report.boxId, details: { reportId: id, reprint: previous > 0 } });
    return jsonOk({ reprint: previous > 0, count: previous + 1 });
  }, TX_OPTIONS);
});
