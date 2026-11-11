import { api, jsonOk, readJson } from "@/lib/server/http";
import { confirmProfileSchema } from "@/lib/server/schemas";
import { confirmPrinterProfile } from "@/lib/server/services/printing";

/** Confirmation of this workstation's stock, DPI and printer (after a TEST label). Audited. */
export const POST = api(async (req, { actor }) => {
  const body = await readJson(req, confirmProfileSchema);
  return jsonOk({ profile: await confirmPrinterProfile(actor, body) });
});
