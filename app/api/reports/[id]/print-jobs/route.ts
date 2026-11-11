import { assertReportAccess } from "@/lib/server/permissions";
import { api, jsonOk } from "@/lib/server/http";
import { parseId } from "@/lib/server/schemas";
import { listReportPrintJobs } from "@/lib/server/services/printing";

export const GET = api<{ params: Promise<{ id: string }> }>(async (_req, { params, actor }) => {
  const id = parseId((await params).id);
  await assertReportAccess(actor, id);
  return jsonOk({ jobs: await listReportPrintJobs(id) });
});
