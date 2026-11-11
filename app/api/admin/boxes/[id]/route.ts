import { api, jsonOk, readJson } from "@/lib/server/http";
import { parseId } from "@/lib/server/schemas";
import { notesSchema } from "@/lib/server/admin-schemas";
import { updateBoxNotes } from "@/lib/server/services/administration";
export const PATCH = api<{ params: Promise<{ id: string }> }>(async (req, { params, actor }) => {
 const id = parseId((await params).id);
 const body = await readJson(req, notesSchema);
 return jsonOk(await updateBoxNotes(actor, id, body.notes, body.reason));
}, { role: "ADMIN" });
