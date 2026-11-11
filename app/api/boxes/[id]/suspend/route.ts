import { api, jsonOk, readJson } from "@/lib/server/http";
import { parseId, suspendSchema } from "@/lib/server/schemas";
import { suspendBox } from "@/lib/server/services/boxes";

export const POST = api<{ params: Promise<{ id: string }> }>(async (req, { params, actor }) => {
  const boxId = parseId((await params).id);
  const body = await readJson(req, suspendSchema);
  return jsonOk({ box: await suspendBox(actor, { boxId, ...body }) });
});
