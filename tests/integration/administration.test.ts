import { restartNok } from "../support/db";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/server/db";
import { finalizeBox, getBoxSummary, getBoxWorkState, openBox, scanItem } from "@/lib/server/services/boxes";
import { resetBoxControl, updateBoxNotes, voidAcceptedItem } from "@/lib/server/services/administration";
import { administrationDashboard, dashboardFilters } from "@/lib/server/services/dashboard";
import { connectedOperatorCount, heartbeat, listPresence, presencePage } from "@/lib/server/services/presence";
import { updateUser } from "@/lib/server/services/users";
import { confirmPrinterProfile, createPrintJob, getJobLabel, savePrinterProfile } from "@/lib/server/services/printing";
import { POST as voidRoute } from "@/app/api/admin/boxes/[id]/void-item/route";
import { POST as resetRoute } from "@/app/api/admin/boxes/[id]/reset/route";
import { PATCH as notesRoute } from "@/app/api/admin/boxes/[id]/route";
import { GET as dashboardRoute } from "@/app/api/admin/dashboard/route";
import { GET as detailRoute } from "@/app/api/boxes/[id]/route";
import { GET as stateRoute } from "@/app/api/boxes/[id]/state/route";
import { GET as auditLabelRoute } from "@/app/api/admin/print-jobs/[id]/route";
import { POST as heartbeatRoute } from "@/app/api/presence/route";
import { boxLabel, ctx, finishBox, itemLabel, key, makeActor, nextSerial, openLeased, request, resetDb } from "../support/db";

type Actor = Awaited<ReturnType<typeof makeActor>>;
const reason = "Correction administrative vérifiée";
let boxSeq = 80000000;
beforeEach(resetDb);
async function control(op: Actor, expected = 2, accepted = 1, finalize = true) {
  const raw = boxLabel(expected, String(++boxSeq));
  const { box, leaseToken } = await openLeased(op, raw);
  const serials: string[] = [];
  const scans = [];
  for (let i = 0; i < accepted; i++) {
    const serial = nextSerial(); serials.push(serial);
    const input = { boxId: box.id, leaseToken, raw: itemLabel(serial), idempotencyKey: key() };
    scans.push({ input, result: await scanItem(op, input) });
  }
  let reportId: string | null = null;
  if (finalize) {
    const fin = await finishBox(op, box.id, leaseToken);
    if (fin.kind !== "FINALIZED") throw new Error(fin.kind);
    reportId = fin.report.id;
  }
  return { box, raw, leaseToken, serials, scans, reportId };
}
async function print(op: Actor, reportId: string) {
  const workstationId = randomUUID();
  await savePrinterProfile(op, { workstationId, name: "POSTE TEST", widthMm: 100, heightMm: 100 });
  await confirmPrinterProfile(op, { workstationId, labelChecked: true });
  return createPrintJob(op, { reportId, workstationId, idempotencyKey: key(), kind: "ORIGINAL", reprintReason: null });
}
const reset = async (admin: Actor, boxId: string) => {
  const b = await getBoxSummary(boxId);
  return resetBoxControl(admin, { boxId, reason, confirmSerial: b.boxSerial, expectedGeneration: b.generation, expectedAcceptedCount: b.acceptedCount });
};

describe("administrative authorization", () => {
  it("operators cannot call admin mutation, dashboard, unrestricted detail or audit endpoints", async () => {
    const op = await makeActor(); const c = await control(op);
    const context = ctx({ id: c.box.id });
    for (const route of [voidRoute, resetRoute, notesRoute]) expect((await route(request(`/api/admin/boxes/${c.box.id}`, { token: op.token, body: {} }), context)).status).toBe(403);
    expect((await dashboardRoute(request("/api/admin/dashboard", { token: op.token }), {})).status).toBe(403);
    expect((await detailRoute(request(`/api/boxes/${c.box.id}`, { token: op.token }), context)).status).toBe(403);
    expect((await auditLabelRoute(request(`/api/admin/print-jobs/${key()}`, { token: op.token }), ctx({ id: key() }))).status).toBe(403);
    await expect(reset(op, c.box.id)).rejects.toMatchObject({ status: 403 });
    const other = await makeActor();
    expect((await stateRoute(request(`/api/boxes/${c.box.id}/state`, { token: other.token }), context)).status).toBe(403);
    expect((await stateRoute(request(`/api/boxes/${c.box.id}/state`, { token: op.token }), context)).status).toBe(200);
  });

  it("validates admin reasons and exact box confirmation; user changes retain the last active administrator", async () => {
    const admin = await makeActor("ADMIN"); const op = await makeActor(); const c = await control(op);
    await expect(resetBoxControl(admin, { boxId: c.box.id, reason: "", confirmSerial: c.box.boxSerial, expectedGeneration: 1, expectedAcceptedCount: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(resetBoxControl(admin, { boxId: c.box.id, reason, confirmSerial: "00000000", expectedGeneration: 1, expectedAcceptedCount: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(updateUser(admin, admin.userId, { active: false, reason })).rejects.toMatchObject({ code: "LAST_ADMIN" });
    await expect(prisma.user.delete({ where: { id: admin.userId } })).rejects.toThrow(/GALIA_GUARD/);
    await expect(prisma.user.update({ where: { id: admin.userId }, data: { role: "OPERATOR" } })).rejects.toThrow(/GALIA_GUARD/);
    await updateUser(admin, op.userId, { active: false, reason });
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { type: "USER_UPDATED" } });
    expect(event.details).toMatchObject({ reason, target: op.userId, before: { active: true }, after: { active: false } });
    expect(JSON.stringify(event.details)).not.toMatch(/password|token|sessionId/i);
  });

  it("concurrent administrator deactivation cannot remove all administrators", async () => {
    const a = await makeActor("ADMIN"); const b = await makeActor("ADMIN");
    const results = await Promise.allSettled([updateUser(a, b.userId, { active: false, reason }), updateUser(b, a.userId, { active: false, reason })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.user.count({ where: { active: true, role: "ADMIN" } })).toBe(1);
  });
});

describe("voided scans and reset generations", () => {
  it.each(["OK", "NOK"])("voids a cover of a finalized %s box, invalidates output and releases its serial without rewriting snapshots", async (status) => {
    const admin = await makeActor("ADMIN"); const op = await makeActor();
    const c = await control(op, status === "OK" ? 1 : 2, 1);
    const original = await prisma.report.findUniqueOrThrow({ where: { id: c.reportId! } });
    const { job } = await print(op, original.id);
    const snapshot = await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } });
    const item = c.scans[0].result.item!;
    await voidAcceptedItem(admin, { boxId: c.box.id, itemId: item.id, reason, confirmSerial: item.serial });
    expect(await getBoxSummary(c.box.id)).toMatchObject({ needsRecontrol: true, status: "IN_PROGRESS", acceptedCount: 0, latestReport: null });
    expect(await prisma.acceptedItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ voidedById: admin.userId, voidReason: reason });
    await expect(getJobLabel(job.id)).rejects.toMatchObject({ code: "CONTROL_INVALIDATED" });
    const other = await control(op, 1, 0, false);
    expect((await scanItem(op, { boxId: other.box.id, leaseToken: other.leaseToken, raw: itemLabel(item.serial), idempotencyKey: key() })).outcome).toBe("ACCEPTED");
    await expect(scanItem(op, c.scans[0].input)).rejects.toMatchObject({ code: "CONTROL_INVALIDATED" });
    const reopened = await openBox(op, { raw: c.raw });
    expect(reopened.kind).toBe("OPENED");
    expect(reopened.kind === "OPENED" && reopened.box.acceptedCount).toBe(0);
    expect(await prisma.report.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(snapshot);
    expect((await auditLabelRoute(request(`/api/admin/print-jobs/${job.id}`, { token: admin.token }), ctx({ id: job.id }))).status).toBe(200);
  });

  it.each(["IN_PROGRESS", "OK", "NOK"])("resets %s, preserves stable identity and starts the same GALIA at zero", async (status) => {
    const admin = await makeActor("ADMIN"); const op = await makeActor();
    const c = await control(op, status === "OK" ? 1 : 2, 1, status !== "IN_PROGRESS");
    await reset(admin, c.box.id);
    expect(await prisma.activeSerialReservation.count()).toBe(0);
    expect(await prisma.box.count()).toBe(1);
    const reopened = await openBox(op, { raw: c.raw });
    if (reopened.kind !== "OPENED") throw new Error(reopened.kind);
    expect(reopened.box).toMatchObject({ id: c.box.id, generation: 2, acceptedCount: 0, needsRecontrol: true });
    expect((await scanItem(op, { boxId: c.box.id, leaseToken: c.leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() })).outcome).toBe("NOT_BOX_OWNER");
    await expect(scanItem(op, c.scans[0].input)).rejects.toMatchObject({ code: "CONTROL_INVALIDATED" });
    await expect(finishBox(op, c.box.id, c.leaseToken)).rejects.toMatchObject({ code: "NOT_BOX_OWNER" });
    expect((await scanItem(op, { boxId: c.box.id, leaseToken: reopened.leaseToken, raw: itemLabel(c.serials[0]), idempotencyKey: key() })).outcome).toBe("ACCEPTED");
    expect(await prisma.acceptedItem.count({ where: { serial: c.serials[0] } })).toBe(2);
  });

  it("reset never releases a serial reassigned to a different box", async () => {
    const admin = await makeActor("ADMIN"); const op = await makeActor();
    const a = await control(op, 2, 1, false); const item = a.scans[0].result.item!;
    await voidAcceptedItem(admin, { boxId: a.box.id, itemId: item.id, confirmSerial: item.serial, reason });
    const b = await control(op, 2, 0, false);
    await scanItem(op, { boxId: b.box.id, leaseToken: b.leaseToken, raw: itemLabel(item.serial), idempotencyKey: key() });
    await reset(admin, a.box.id);
    expect(await prisma.activeSerialReservation.findUniqueOrThrow({ where: { serial: item.serial } })).toMatchObject({ boxId: b.box.id });
    await expect(voidAcceptedItem(admin, { boxId: a.box.id, itemId: item.id, confirmSerial: item.serial, reason })).rejects.toMatchObject({ code: "ITEM_ALREADY_VOID" });
  });

  it("in-progress removal refreshes the active quantity and finalization uses the reduced contents", async () => {
    const admin = await makeActor("ADMIN"); const op = await makeActor(); const c = await control(op, 2, 2, false);
    const item = c.scans[0].result.item!;
    await voidAcceptedItem(admin, { boxId: c.box.id, itemId: item.id, confirmSerial: item.serial, reason });
    expect((await getBoxWorkState(c.box.id)).items).toHaveLength(1);
    const attemptId = (await getBoxSummary(c.box.id)).activeAttempt!.id;
    // The operator's screen still showed 2 pieces: the end request is refused with the fresh counts.
    expect(await finalizeBox(op, { boxId: c.box.id, leaseToken: c.leaseToken, attemptId, trigger: "MANUAL", observed: { events: 2, reserved: 2 } })).toMatchObject({ kind: "STATE_CHANGED", counts: { reserved: 1 } });
    // The released serial is reusable after the authorized removal.
    expect((await scanItem(op, { boxId: c.box.id, leaseToken: c.leaseToken, raw: itemLabel(item.serial), idempotencyKey: key() })).outcome).toBe("ACCEPTED");
    const fin = await finishBox(op, c.box.id, c.leaseToken, { trigger: "GALIA_RESCAN" });
    expect(fin.kind === "FINALIZED" && fin.report).toMatchObject({ result: "OK", acceptedQty: 2 });
  });

  it("racing reset/scanning/finalization cannot leave stale ownership, reservations or a valid old report", async () => {
    const admin = await makeActor("ADMIN"); const op = await makeActor(); const c = await control(op, 2, 1, false);
    const seen = await getBoxSummary(c.box.id);
    await Promise.allSettled([reset(admin, c.box.id), scanItem(op, { boxId: c.box.id, leaseToken: c.leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() }), finalizeBox(op, { boxId: c.box.id, leaseToken: c.leaseToken, attemptId: seen.activeAttempt!.id, trigger: "MANUAL", observed: { events: seen.counts.events, reserved: seen.counts.reserved } })]);
    // A concurrent scan may make the confirmation stale. Repeat only after reviewing the fresh state.
    if ((await getBoxSummary(c.box.id)).generation === 1) await reset(admin, c.box.id);
    const b = await prisma.box.findUniqueOrThrow({ where: { id: c.box.id } });
    expect(b).toMatchObject({ generation: 2, ownerSessionId: null, activeAttemptId: null, currentReportId: null, needsRecontrol: true });
    expect(await prisma.activeSerialReservation.count({ where: { boxId: b.id } })).toBe(0);
  });

  it("metadata identity edits require explicit reset, leave history intact and cannot fabricate OK", async () => {
    const admin = await makeActor("ADMIN"); const op = await makeActor(); const c = await control(op, 1, 1);
    const original = await prisma.report.findUniqueOrThrow({ where: { id: c.reportId! } });
    await updateBoxNotes(admin, c.box.id, "Vérifier le support", reason);
    expect((await getBoxSummary(c.box.id)).latestReport?.id).toBe(original.id);
    await resetBoxControl(admin, { boxId: c.box.id, reason, confirmSerial: c.box.boxSerial, expectedGeneration: 1, expectedAcceptedCount: 1, newGalia: boxLabel(3, c.box.boxSerial, "LNEWPN") });
    expect(await getBoxSummary(c.box.id)).toMatchObject({ partNumber: "LNEWPN", expectedQty: 3, generation: 2, acceptedCount: 0 });
    expect(await prisma.report.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    await expect(prisma.box.update({ where: { id: c.box.id }, data: { status: "OK" } })).rejects.toThrow(/GALIA_GUARD/);
    const reopened = await openBox(op, { raw: boxLabel(3, c.box.boxSerial, "LNEWPN") });
    if (reopened.kind !== "OPENED") throw new Error(reopened.kind);
    await expect(prisma.report.create({ data: { boxId: c.box.id, attemptId: reopened.box.activeAttempt!.id, attemptNumber: reopened.box.activeAttempt!.number, kind: "INITIAL", result: "OK", boxSerial: c.box.boxSerial, partNumber: "LNEWPN", galiaPayload: reopened.box.galiaPayload, expectedQty: 3, acceptedQty: 3, difference: 0, issues: [], finalizedById: admin.userId, finalizedByUsername: admin.username, finalizedAt: new Date() } })).rejects.toThrow(/GALIA_GUARD/);
  });

  it("void and finalization racing cannot preserve a finalized result with stale contents", async () => {
    const admin = await makeActor("ADMIN"); const op = await makeActor(); const c = await control(op, 1, 1, false); const item = c.scans[0].result.item!;
    const seen = await getBoxSummary(c.box.id);
    const results = await Promise.allSettled([voidAcceptedItem(admin, { boxId: c.box.id, itemId: item.id, reason, confirmSerial: item.serial }), finalizeBox(op, { boxId: c.box.id, leaseToken: c.leaseToken, attemptId: seen.activeAttempt!.id, trigger: "GALIA_RESCAN", galiaRaw: seen.galiaPayload, observed: { events: 1, reserved: 1 } })]);
    expect(results[0].status).toBe("fulfilled");
    const b = await getBoxSummary(c.box.id);
    expect(b).toMatchObject({ acceptedCount: 0, needsRecontrol: true, latestReport: null });
    expect(await prisma.activeSerialReservation.count({ where: { boxId: c.box.id } })).toBe(0);
  });

  it("blocks new prints, reprints and old print-request retries after reset, including for admins", async () => {
    const admin = await makeActor("ADMIN"); const op = await makeActor(); const c = await control(op, 1, 1);
    const { job } = await print(admin, c.reportId!);
    const stored = await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } });
    await reset(admin, c.box.id);
    const input = { reportId: c.reportId!, workstationId: stored.workstationId, reprintReason: null, kind: "ORIGINAL" as const };
    await expect(createPrintJob(admin, { ...input, idempotencyKey: stored.idempotencyKey })).rejects.toMatchObject({ code: "CONTROL_INVALIDATED" });
    await expect(createPrintJob(admin, { ...input, idempotencyKey: key() })).rejects.toMatchObject({ code: "CONTROL_INVALIDATED" });
    await expect(createPrintJob(admin, { ...input, idempotencyKey: key(), kind: "REPRINT", reprintReason: reason })).rejects.toMatchObject({ code: "CONTROL_INVALIDATED" });
    await expect(getJobLabel(job.id, admin)).rejects.toMatchObject({ code: "CONTROL_INVALIDATED" });
    expect(await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(stored);
  });
});

describe("distinct current dashboard counts", () => {
  it("counts current boxes once across corrections and reprints, with reset archives separate", async () => {
    const admin = await makeActor("ADMIN"); const op = await makeActor();
    const a = await control(op, 2, 1); const b = await control(op, 1, 1); await control(op, 2, 0, false);
    const correction = await restartNok(op, { raw: a.raw, startCorrection: true });
    if (correction.kind !== "OPENED") throw new Error(correction.kind);
    await scanItem(op, { boxId: a.box.id, leaseToken: correction.leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    await scanItem(op, { boxId: a.box.id, leaseToken: correction.leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    const fin = await finishBox(op, a.box.id, correction.leaseToken);
    if (fin.kind !== "FINALIZED") throw new Error(fin.kind);
    const first = await print(op, fin.report.id);
    const profile = await prisma.printJob.findUniqueOrThrow({ where: { id: first.job.id } });
    await createPrintJob(op, { reportId: fin.report.id, workstationId: profile.workstationId, idempotencyKey: key(), kind: "REPRINT", reprintReason: "Étiquette perdue" });
    expect((await administrationDashboard(admin, dashboardFilters({}))).metrics).toMatchObject({ completed: 2, ok: 2, nok: 0, inProgress: 1, recontrol: 0, archived: 1 });
    await reset(admin, b.box.id);
    const dashboard = await administrationDashboard(admin, dashboardFilters({}));
    expect(dashboard.metrics).toMatchObject({ completed: 1, ok: 1, nok: 0, inProgress: 1, recontrol: 1, archived: 2 });
    expect(dashboard.total).toBe(3);
    expect((await administrationDashboard(admin, dashboardFilters({ status: "OK", operator: op.username }))).total).toBe(1);
    expect((await administrationDashboard(admin, dashboardFilters({ from: "2099-01-01" }))).total).toBe(0);
  });
});

describe("honest multi-tab presence", () => {
  it("paginates grouped workstation presence in PostgreSQL and cannot overwrite another session's tab", async () => {
    const admin = await makeActor("ADMIN"); const op = await makeActor(); const other = await makeActor();
    const tabId = key();
    await heartbeat(op, { tabId, workstationId: key(), boxId: null, active: true });
    await expect(heartbeat(other, { tabId, workstationId: null, boxId: null, active: true })).rejects.toMatchObject({ code: "PRESENCE_TAB" });
    for (let i = 0; i < 26; i++) await heartbeat(op, { tabId: key(), workstationId: key(), boxId: null, active: true });
    const page = await presencePage(admin, { state: "ACTIVE", page: 2 });
    expect(page).toMatchObject({ total: 27, page: 2, pageCount: 2 });
    expect(page.rows).toHaveLength(2);
    expect(await connectedOperatorCount(admin)).toBe(1);
  });
  it("keeps another tab online, distinguishes idle/offline and excludes logout, expiry and disabled accounts", async () => {
    const admin = await makeActor("ADMIN"); const op = await makeActor(); const workstationId = randomUUID();
    const t1 = randomUUID(); const t2 = randomUUID();
    const pulse = (tabId: string) => heartbeat(op, { tabId, workstationId, boxId: null, active: true });
    await pulse(t1); await pulse(t2);
    expect((await listPresence(admin))[0]).toMatchObject({ username: op.username, state: "ONLINE" });
    await prisma.browserPresence.update({ where: { tabId: t1 }, data: { heartbeatAt: new Date(Date.now() - 100000) } });
    expect((await listPresence(admin))[0].state).toBe("ONLINE");
    await prisma.browserPresence.updateMany({ data: { activityAt: new Date(Date.now() - 180000) } });
    expect((await listPresence(admin))[0].state).toBe("IDLE");
    await prisma.browserPresence.updateMany({ data: { heartbeatAt: new Date(Date.now() - 100000) } });
    expect((await listPresence(admin))[0].state).toBe("OFFLINE");
    await pulse(t2);
    await prisma.session.update({ where: { id: op.sessionId }, data: { revokedAt: new Date() } });
    expect(await listPresence(admin)).toEqual([]);
    await prisma.session.update({ where: { id: op.sessionId }, data: { revokedAt: null, expiresAt: new Date(Date.now() - 1) } });
    expect(await listPresence(admin)).toEqual([]);
    await prisma.session.update({ where: { id: op.sessionId }, data: { expiresAt: new Date(Date.now() + 60000) } });
    await prisma.user.update({ where: { id: op.userId }, data: { active: false } });
    expect(await listPresence(admin)).toEqual([]);
    expect((await heartbeatRoute(request("/api/presence", { body: { tabId: key(), workstationId: null, boxId: null, active: true } }), {})).status).toBe(401);
  });
});
