import { api, jsonOk, readJson } from "@/lib/server/http";
import { parseId, printerProfileSchema } from "@/lib/server/schemas";
import { getPrinterProfile, savePrinterProfile } from "@/lib/server/services/printing";

export const GET = api(async (req) => {
  const workstationId = parseId(req.nextUrl.searchParams.get("workstationId") ?? "");
  return jsonOk({ profile: await getPrinterProfile(workstationId) });
});

/**
 * Printer of THIS workstation (per browser profile, never global). Any signed-in
 * operator sets up their own PC; every change is audited and clears the confirmation.
 */
export const PUT = api(async (req, { actor }) => {
  const body = await readJson(req, printerProfileSchema);
  return jsonOk({ profile: await savePrinterProfile(actor, body) });
});
