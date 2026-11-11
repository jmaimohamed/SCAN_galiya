import { api, jsonOk, readJson } from "@/lib/server/http";
import { openBoxSchema } from "@/lib/server/schemas";
import { openBox } from "@/lib/server/services/boxes";

/** Scan of a main GALIA label (raw) or resume by id. */
export const POST = api(async (req, { actor }) => {
  const body = await readJson(req, openBoxSchema);
  return jsonOk(await openBox(actor, body));
});
