import { api, jsonOk, readJson } from "@/lib/server/http";
import { createPrintJobSchema } from "@/lib/server/schemas";
import { createPrintJob } from "@/lib/server/services/printing";

/** Save one immutable label and a DIALOG_REQUESTED job. Physical output is unconfirmed. */
export const POST = api(async (req, { actor }) => {
  const body = await readJson(req, createPrintJobSchema);
  return jsonOk(await createPrintJob(actor, body));
});
