import { api, jsonOk, readJson } from "@/lib/server/http";
import { parseId, scanSchema } from "@/lib/server/schemas";
import { scanItem } from "@/lib/server/services/boxes";

/** One seat-cover scan. Business rejections are 200 responses with a non-ACCEPTED outcome. */
export const POST = api<{ params: Promise<{ id: string }> }>(async (req, { params, actor }) => {
  const boxId = parseId((await params).id);
  const body = await readJson(req, scanSchema);
  return jsonOk(await scanItem(actor, { boxId, ...body }));
});
