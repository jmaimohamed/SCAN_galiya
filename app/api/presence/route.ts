import { api, jsonOk, readJson } from "@/lib/server/http";
import { heartbeatSchema } from "@/lib/server/admin-schemas";
import { heartbeat } from "@/lib/server/services/presence";
export const POST = api(async (req, { actor }) => jsonOk(await heartbeat(actor, await readJson(req, heartbeatSchema))));
