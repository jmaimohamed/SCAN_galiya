import { api, jsonOk, readJson } from "@/lib/server/http";
import { parseId, passwordSchema } from "@/lib/server/schemas";
import { resetPassword } from "@/lib/server/services/users";

export const POST = api<{ params: Promise<{ id: string }> }>(
  async (req, { params, actor }) => {
    const id = parseId((await params).id);
    const body = await readJson(req, passwordSchema);
    await resetPassword(actor, id, body.password, body.reason);
    return jsonOk({ ok: true });
  },
  { role: "ADMIN" },
);
