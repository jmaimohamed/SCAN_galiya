import { api, jsonOk } from "@/lib/server/http";
import { administrationDashboard, dashboardFilters } from "@/lib/server/services/dashboard";
export const GET = api(async (req, { actor }) => jsonOk(await administrationDashboard(actor, dashboardFilters(Object.fromEntries(req.nextUrl.searchParams)))) , { role: "ADMIN" });
