import { api, jsonOk, readJson } from "@/lib/server/http";
import { finalizeSchema, parseId } from "@/lib/server/schemas";
import { finalizeBox } from "@/lib/server/services/boxes";

/** "Terminer le contrôle". The OK/NOK result is computed on the server. */
export const POST = api<{ params: Promise<{ id: string }> }>(async (req, { params, actor }) => {
  const boxId = parseId((await params).id);
  const body = await readJson(req, finalizeSchema);
  return jsonOk(await finalizeBox(actor, { boxId, ...body }));
});
