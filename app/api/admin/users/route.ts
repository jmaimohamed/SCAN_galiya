import { api, jsonOk, readJson } from "@/lib/server/http";
import { createUserSchema } from "@/lib/server/schemas";
import { createUser, listUsers } from "@/lib/server/services/users";

export const GET = api(async () => jsonOk({ users: await listUsers() }), { role: "ADMIN" });

export const POST = api(
  async (req, { actor }) => {
    const body = await readJson(req, createUserSchema);
    return jsonOk({ user: await createUser(actor, body) }, 201);
  },
  { role: "ADMIN" },
);
