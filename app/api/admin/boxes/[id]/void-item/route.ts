import { api, jsonOk, readJson } from "@/lib/server/http";
import { parseId } from "@/lib/server/schemas";
import { voidItemSchema } from "@/lib/server/admin-schemas";
import { voidAcceptedItem } from "@/lib/server/services/administration";
export const POST = api<{ params: Promise<{ id: string }> }>(async (req, { params, actor }) => {
 const boxId = parseId((await params).id);
 return jsonOk(await voidAcceptedItem(actor, { boxId, ...await readJson(req, voidItemSchema) }));
}, { role: "ADMIN" });
