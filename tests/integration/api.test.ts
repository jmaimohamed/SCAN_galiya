import { beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as openRoute } from "@/app/api/boxes/open/route";
import { POST as scanRoute } from "@/app/api/boxes/[id]/scans/route";
import { POST as createUserRoute } from "@/app/api/admin/users/route";
import { PATCH as patchUserRoute } from "@/app/api/admin/users/[id]/route";
import { PUT as putProfileRoute } from "@/app/api/printer-profile/route";
import { prisma } from "@/lib/server/db";
import { createUser } from "@/lib/server/services/users";
import { boxLabel, ctx, itemLabel, key, makeActor, request, resetDb } from "../support/db";

beforeEach(async () => {
  await resetDb();
});

async function status(res: Response) {
  return { status: res.status, body: await res.json() };
}

describe("authentication & sessions", () => {
  it("refuses protected endpoints without a session", async () => {
    const res = await openRoute(request("/api/boxes/open", { body: { raw: boxLabel(20, "10428865") } }), {});
    expect(res.status).toBe(401);
    expect(await prisma.box.count()).toBe(0);
  });

  it("refuses mutations from an untrusted or missing Origin (CSRF)", async () => {
    const a = await makeActor();
    for (const origin of ["http://evil.example", null]) {
      const res = await openRoute(request("/api/boxes/open", { body: { raw: boxLabel(20, "10428865") }, token: a.token, origin }), {});
      expect(res.status).toBe(403);
    }
    const crossSite = await openRoute(
      request("/api/boxes/open", { body: { raw: boxLabel(20, "10428865") }, token: a.token, headers: { "sec-fetch-site": "cross-site" } }),
      {},
    );
    expect(crossSite.status).toBe(403);
    expect(await prisma.box.count()).toBe(0);
  });

  it("derives the operator from the session, ignoring any user id in the body", async () => {
    const a = await makeActor();
    const other = await makeActor();
    const res = await openRoute(request("/api/boxes/open", { body: { raw: boxLabel(20, "10428865"), userId: other.userId }, token: a.token }), {});
    const body = (await res.json()) as { kind: string; box: { id: string } };
    expect(body.kind).toBe("OPENED");
    const box = await prisma.box.findUniqueOrThrow({ where: { id: body.box.id } });
    expect(box.createdById).toBe(a.userId);
  });

  it("logs in with an HttpOnly SameSite=Strict cookie and rate-limits failures", async () => {
    await createUser(null, { username: "op100", displayName: null, role: "OPERATOR", password: "Correct-Horse-1" });
    const ok = await login(request("/api/auth/login", { body: { username: "OP100", password: "Correct-Horse-1" } }), {});
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/galia_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=strict/i);
    expect(cookie).not.toMatch(/Secure/i); // http://localhost origin

    for (let i = 0; i < 5; i++) {
      const bad = await login(request("/api/auth/login", { body: { username: "op100", password: "wrong" } }), {});
      expect(bad.status).toBe(401);
    }
    const limited = await status(await login(request("/api/auth/login", { body: { username: "op100", password: "Correct-Horse-1" } }), {}));
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });

  it("gives the same answer for unknown users and wrong passwords", async () => {
    await createUser(null, { username: "op101", displayName: null, role: "OPERATOR", password: "Correct-Horse-1" });
    const unknown = await status(await login(request("/api/auth/login", { body: { username: "nobody", password: "x" } }), {}));
    const wrong = await status(await login(request("/api/auth/login", { body: { username: "op101", password: "x" } }), {}));
    expect(unknown).toEqual(wrong);
  });

  it("ends active sessions as soon as a user is disabled", async () => {
    const admin = await makeActor("ADMIN");
    const op = await makeActor();
    const before = await openRoute(request("/api/boxes/open", { body: { raw: boxLabel(20, "10428865") }, token: op.token }), {});
    expect(before.status).toBe(200);
    const patch = await patchUserRoute(request(`/api/admin/users/${op.userId}`, { method: "PATCH", body: { active: false, reason: "Désactivation administrative test" }, token: admin.token }), ctx({ id: op.userId }));
    expect(patch.status).toBe(200);
    const after = await openRoute(request("/api/boxes/open", { body: { raw: boxLabel(20, "10428866") }, token: op.token }), {});
    expect(after.status).toBe(401);
  });

  it("logout revokes the session and releases its box leases", async () => {
    const op = await makeActor();
    const opened = (await (await openRoute(request("/api/boxes/open", { body: { raw: boxLabel(20, "10428865") }, token: op.token }), {})).json()) as { box: { id: string } };
    const res = await logout(request("/api/auth/logout", { method: "POST", token: op.token }), {});
    expect(res.status).toBe(200);
    const box = await prisma.box.findUniqueOrThrow({ where: { id: opened.box.id } });
    expect(box.ownerSessionId).toBeNull();
    const again = await openRoute(request("/api/boxes/open", { body: { raw: boxLabel(20, "10428866") }, token: op.token }), {});
    expect(again.status).toBe(401);
  });
});

describe("authorization", () => {
  it("operators cannot manage users; printer settings require a session (operators set up their own PC)", async () => {
    const op = await makeActor();
    const create = await createUserRoute(request("/api/admin/users", { body: { username: "X1", displayName: null, role: "ADMIN", password: "Password-123" }, token: op.token }), {});
    expect(create.status).toBe(403);
    expect(await prisma.user.count({ where: { username: "X1" } })).toBe(0);
    const anonymous = await putProfileRoute(
      request("/api/printer-profile", {
        method: "PUT",
        body: { workstationId: crypto.randomUUID(), name: "P", widthMm: 100, heightMm: 100 },
      }),
      {},
    );
    expect(anonymous.status).toBe(401);
  });

  it("validates scan input and box ids", async () => {
    const op = await makeActor();
    const badId = await scanRoute(request("/api/boxes/not-a-uuid/scans", { body: { idempotencyKey: key(), raw: itemLabel("123456"), leaseToken: "x".repeat(43) }, token: op.token }), ctx({ id: "not-a-uuid" }));
    expect(badId.status).toBe(400);
    const opened = (await (await openRoute(request("/api/boxes/open", { body: { raw: boxLabel(20, "10428865") }, token: op.token }), {})).json()) as { box: { id: string }; leaseToken: string };
    const badKey = await scanRoute(
      request(`/api/boxes/${opened.box.id}/scans`, { body: { idempotencyKey: "nope", raw: itemLabel("123456"), leaseToken: opened.leaseToken }, token: op.token }),
      ctx({ id: opened.box.id }),
    );
    expect(badKey.status).toBe(400);
    const tooLong = await scanRoute(
      request(`/api/boxes/${opened.box.id}/scans`, { body: { idempotencyKey: key(), raw: "A".repeat(5000), leaseToken: opened.leaseToken }, token: op.token }),
      ctx({ id: opened.box.id }),
    );
    expect(tooLong.status).toBe(400);
  });

  it("an admin cannot disable the last active administrator", async () => {
    const admin = await makeActor("ADMIN");
    const res = await patchUserRoute(request(`/api/admin/users/${admin.userId}`, { method: "PATCH", body: { active: false, reason: "Désactivation administrative test" }, token: admin.token }), ctx({ id: admin.userId }));
    expect(res.status).toBe(409);
    expect(await prisma.user.count({ where: { active: true, role: "ADMIN" } })).toBe(1);
  });
});
