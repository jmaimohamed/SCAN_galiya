import { api, jsonOk, readJson } from "@/lib/server/http";
import { parseId } from "@/lib/server/schemas";
import { resetControlSchema } from "@/lib/server/admin-schemas";
import { resetBoxControl } from "@/lib/server/services/administration";
export const POST = api<{ params: Promise<{ id: string }> }>(async (req, { params, actor }) => {
 const boxId = parseId((await params).id);
 return jsonOk(await resetBoxControl(actor, { boxId, ...await readJson(req, resetControlSchema) }));
}, { role: "ADMIN" });
