import { api, jsonOk, readJson } from "@/lib/server/http";
import { adminSettingsSchema, updateAdminLabelSettings } from "@/lib/server/services/admin-settings";
export const PATCH = api(async (req, { actor }) => jsonOk(await updateAdminLabelSettings(actor, await readJson(req, adminSettingsSchema))), { role: "ADMIN" });
