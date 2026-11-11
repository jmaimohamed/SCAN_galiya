import type { NextRequest } from "next/server";
import { audit } from "@/lib/server/audit";
import { revokeSession } from "@/lib/server/auth/session";
import { SESSION_COOKIE } from "@/lib/server/config";
import { prisma } from "@/lib/server/db";
import { actorFromRequest, jsonOk, publicApi } from "@/lib/server/http";
import { releaseSessionLeases } from "@/lib/server/services/boxes";

/** Logout: release this session's box leases, revoke the session, clear the cookie. */
export const POST = publicApi(async (req: NextRequest) => {
  const actor = await actorFromRequest(req);
  if (actor) {
    await releaseSessionLeases(actor);
    await revokeSession(actor.sessionId);
    await audit(prisma, { type: "LOGOUT", actor });
  }
  const res = jsonOk({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", expires: new Date(0) });
  return res;
});
