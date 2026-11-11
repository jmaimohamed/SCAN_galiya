import { api, jsonOk } from "@/lib/server/http";
import { parseId } from "@/lib/server/schemas";
import { getJobLabel } from "@/lib/server/services/printing";

export const GET = api<{ params: Promise<{ id: string }> }>(async (_req, { params, actor }) => {
  const id = parseId((await params).id);
  const { job } = await getJobLabel(id, actor);
  return jsonOk({ job });
});
