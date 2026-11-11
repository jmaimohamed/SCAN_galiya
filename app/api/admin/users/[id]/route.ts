import { api, jsonOk, readJson } from "@/lib/server/http";
import { parseId, updateUserSchema } from "@/lib/server/schemas";
import { updateUser } from "@/lib/server/services/users";

export const PATCH = api<{ params: Promise<{ id: string }> }>(
  async (req, { params, actor }) => {
    const id = parseId((await params).id);
    const body = await readJson(req, updateUserSchema);
    return jsonOk({ user: await updateUser(actor, id, body) });
  },
  { role: "ADMIN" },
);
