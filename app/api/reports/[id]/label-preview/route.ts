import { assertReportAccess } from "@/lib/server/permissions";
import { api, jsonOk } from "@/lib/server/http";
import { parseId } from "@/lib/server/schemas";
import { previewReportLabel } from "@/lib/server/services/printing";

export const GET = api<{ params: Promise<{ id: string }> }>(async (req, { params, actor }) => {
  const id = parseId((await params).id);
  await assertReportAccess(actor, id);
  const workstationId = parseId(req.nextUrl.searchParams.get("workstationId") ?? "");
  return jsonOk(await previewReportLabel(id, workstationId));
});
