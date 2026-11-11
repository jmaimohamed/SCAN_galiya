import { api, jsonOk } from "@/lib/server/http";
import { parseId } from "@/lib/server/schemas";
import { previewTestLabel } from "@/lib/server/services/printing";

export const GET = api(async (req, { actor }) => {
  const workstationId = parseId(req.nextUrl.searchParams.get("workstationId") ?? "");
  return jsonOk(await previewTestLabel(actor, workstationId));
});
