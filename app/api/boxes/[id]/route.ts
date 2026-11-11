import { api, jsonOk } from "@/lib/server/http";
import { parseId } from "@/lib/server/schemas";
import { getBoxDetail } from "@/lib/server/services/history";

/** Full traceability detail for the history drawer. */
export const GET = api<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const id = parseId((await params).id);
  return jsonOk(await getBoxDetail(id));
}, { role: "ADMIN" });
