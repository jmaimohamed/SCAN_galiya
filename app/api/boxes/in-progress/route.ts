import { api, jsonOk } from "@/lib/server/http";
import { listInProgressBoxes } from "@/lib/server/services/boxes";

export const GET = api(async (_req, { actor }) => jsonOk({ boxes: await listInProgressBoxes(15, actor) }));
