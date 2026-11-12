import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PUT as putProfileRoute } from "@/app/api/printer-profile/route";
import { POST as createJobRoute } from "@/app/api/print-jobs/route";
import { PATCH as adminSettingsRoute } from "@/app/api/admin/settings/route";
import { prisma } from "@/lib/server/db";
import { scanItem } from "@/lib/server/services/boxes";
import { confirmPrinterProfile, createPrintJob, getJobLabel, getPrinterProfile, savePrinterProfile } from "@/lib/server/services/printing";
import { svgQrPath } from "../support/label";
import { boxLabel, finishBox, itemLabel, key, makeActor, nextSerial, openLeased, request, resetDb } from "../support/db";

type ActorT = Awaited<ReturnType<typeof makeActor>>;
let boxSeq = 40_000_000;

beforeEach(async () => {
  await resetDb();
});

async function setup(actor: ActorT, name: string, widthMm = 100, heightMm = 100) {
  const workstationId = randomUUID();
  await savePrinterProfile(actor, { workstationId, name, widthMm, heightMm });
  await confirmPrinterProfile(actor, { workstationId, labelChecked: true });
  return workstationId;
}

async function okReport(actor: ActorT) {
  const { box, leaseToken } = await openLeased(actor, boxLabel(1, String(++boxSeq)));
  await scanItem(actor, { boxId: box.id, leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
  const fin = await finishBox(actor, box.id, leaseToken);
  if (fin.kind !== "FINALIZED") throw new Error(fin.kind);
  return fin.report;
}

describe("one server, several operator PCs (browser print dialog)", () => {
  it("stores independent placement per browser, clears confirmation on movement and preserves earlier job snapshots", async () => {
    const op = await makeActor();
    const ws = randomUUID(); const other = randomUUID();
    await savePrinterProfile(op, { workstationId: ws, name: "LONG", widthMm: 110, heightMm: 400, contentLengthMm: 210, contentPosition: "TOP" });
    await savePrinterProfile(op, { workstationId: other, name: "AUTRE", widthMm: 110, heightMm: 400 });
    await confirmPrinterProfile(op, { workstationId: ws, labelChecked: true });
    const report = await okReport(op);
    const input = { kind: "ORIGINAL" as const, reportId: report.id, workstationId: ws, reprintReason: null };
    const { job } = await createPrintJob(op, { ...input, idempotencyKey: key() });
    const old = await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } });
    const changed = await savePrinterProfile(op, { workstationId: ws, name: "LONG", widthMm: 110, heightMm: 400, contentLengthMm: 210, contentPosition: "BOTTOM" });
    expect(changed).toMatchObject({ contentPosition: "BOTTOM", contentLengthMm: 210, confirmedAt: null });
    expect(await getPrinterProfile(other)).toMatchObject({ contentPosition: "CENTER", contentLengthMm: null });
    await expect(createPrintJob(op, { ...input, idempotencyKey: key(), kind: "REPRINT", reprintReason: "Position changée" })).rejects.toMatchObject({ code: "LABEL_NOT_CONFIRMED" });
    await confirmPrinterProfile(op, { workstationId: ws, labelChecked: true });
    const fresh = await createPrintJob(op, { ...input, idempotencyKey: key(), kind: "REPRINT", reprintReason: "Position changée" });
    const moved = await getJobLabel(fresh.job.id);
    expect(fresh.job).toMatchObject({ widthMm: 110, heightMm: 400 });
    expect(svgQrPath(moved.svg!)).not.toBe(svgQrPath(old.payload));
    expect((await getJobLabel(job.id)).svg).toBe(old.payload);
    expect(await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(old);
    const invalid = await putProfileRoute(request("/api/printer-profile", { method: "PUT", token: op.token, body: { workstationId: ws, name: "INVALIDE", widthMm: 110, heightMm: 400, contentLengthMm: 401, contentPosition: "TOP" } }), {});
    expect(invalid.status).toBe(400);
  });

  it("accepts longer real stock through the API and stores a roll-size page without a driver rotation", async () => {
    const op = await makeActor();
    const workstationId = randomUUID();
    const save = await putProfileRoute(request("/api/printer-profile", { method: "PUT", token: op.token, body: { workstationId, name: "ROULEAU-LONG", widthMm: 112, heightMm: 991 } }), {});
    expect(save.status).toBe(200);
    expect(await getPrinterProfile(workstationId)).toMatchObject({ widthMm: 112, heightMm: 991, orientation: "ROTATE_90", confirmedAt: null });
    await confirmPrinterProfile(op, { workstationId, labelChecked: true });
    const { job } = await createPrintJob(op, { idempotencyKey: key(), kind: "TEST", reportId: null, workstationId, reprintReason: null });
    expect(job).toMatchObject({ widthMm: 112, heightMm: 991, orientation: "ROTATE_90", status: "DIALOG_REQUESTED" });
    const stored = await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.payload).toMatch(/width="112mm" height="991mm"/);
    expect(stored.payload.match(/rotate\(90\)/g)).toHaveLength(1);
    for (const dimensions of [{ widthMm: 992, heightMm: 210 }, { widthMm: 110, heightMm: 992 }]) {
      expect((await putProfileRoute(request("/api/printer-profile", { method: "PUT", token: op.token, body: { workstationId, name: "INVALIDE", ...dimensions } }), {})).status).toBe(400);
    }
  });

  it("calibrates widths above 112 mm per workstation, reconfirms changed bands and preserves old snapshots", async () => {
    const op = await makeActor();
    const admin = await makeActor("ADMIN");
    const ws = randomUUID();
    const other = await setup(op, "AUTRE POSTE");
    const paper = { workstationId: ws, name: "LARGEUR PERSONNALISÉE", widthMm: 160, heightMm: 400 };
    expect((await putProfileRoute(request("/api/printer-profile", { method: "PUT", token: op.token, body: paper }), {})).status).toBe(200);
    expect(await getPrinterProfile(ws)).toMatchObject({ widthMm: 160, printableWidthMm: 104 });
    await confirmPrinterProfile(op, { workstationId: ws, labelChecked: true });
    const input = { idempotencyKey: key(), kind: "ORIGINAL" as const, reportId: (await okReport(op)).id, workstationId: ws, reprintReason: null };
    const first = await createPrintJob(op, input);
    const old = await prisma.printJob.findUniqueOrThrow({ where: { id: first.job.id } });

    expect((await putProfileRoute(request("/api/printer-profile", { method: "PUT", token: op.token, body: { ...paper, printableWidthMm: null } }), {})).status).toBe(200);
    expect(await getPrinterProfile(ws)).toMatchObject({ widthMm: 160, printableWidthMm: null, confirmedAt: null });
    // Omitted optional fields preserve an explicitly selected full-width setting.
    await savePrinterProfile(op, paper);
    expect((await getPrinterProfile(ws))?.printableWidthMm).toBeNull();
    const reprint = { ...input, idempotencyKey: key(), kind: "REPRINT" as const, reprintReason: "Calibrage largeur" };
    await expect(createPrintJob(op, reprint)).rejects.toMatchObject({ code: "LABEL_NOT_CONFIRMED" });
    await confirmPrinterProfile(op, { workstationId: ws, labelChecked: true });
    const fresh = await createPrintJob(op, reprint);
    const svg = (await getJobLabel(fresh.job.id)).svg!;
    expect(svg).toContain('width="160mm" height="400mm"');
    expect(svgQrPath(svg)).not.toBe(svgQrPath(old.payload));
    expect(await prisma.printJob.findUniqueOrThrow({ where: { id: first.job.id } })).toEqual(old);
    expect((await createPrintJob(op, input)).job.id).toBe(first.job.id);
    expect(await getPrinterProfile(other)).toMatchObject({ widthMm: 100, printableWidthMm: 104 });

    const edit = { ...paper, printableWidthMm: 140, reason: "Ajustement de la largeur mesurée" };
    expect((await adminSettingsRoute(request("/api/admin/settings", { method: "PATCH", token: op.token, body: edit }), {})).status).toBe(403);
    expect((await adminSettingsRoute(request("/api/admin/settings", { method: "PATCH", token: admin.token, body: edit }), {})).status).toBe(200);
    expect(await getPrinterProfile(ws)).toMatchObject({ printableWidthMm: 140, confirmedAt: null });
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { type: "ADMIN_LABEL_SETTINGS", username: admin.username } });
    expect(event.details).toMatchObject({ before: { printableWidthMm: null }, after: { printableWidthMm: 140 } });
    for (const printableWidthMm of [0, -1, 992, 110.5]) {
      expect((await putProfileRoute(request("/api/printer-profile", { method: "PUT", token: op.token, body: { ...paper, printableWidthMm } }), {})).status).toBe(400);
    }
    await expect(prisma.printerProfile.update({ where: { workstationId: ws }, data: { widthMm: 992 } })).rejects.toThrow();
    await expect(prisma.printerProfile.update({ where: { workstationId: ws }, data: { printableWidthMm: 0 } })).rejects.toThrow();
  });

  it("each workstation keeps its own label settings; every job records the PC and size it was printed for", async () => {
    const opA = await makeActor("OPERATOR", "OP_A");
    const opB = await makeActor("OPERATOR", "OP_B");
    const wsA = await setup(opA, "POSTE-A", 100, 100);
    const wsB = await setup(opB, "POSTE-B", 102, 152);
    const jobA = (await createPrintJob(opA, { idempotencyKey: key(), kind: "ORIGINAL", reportId: (await okReport(opA)).id, workstationId: wsA, reprintReason: null })).job;
    const jobB = (await createPrintJob(opB, { idempotencyKey: key(), kind: "ORIGINAL", reportId: (await okReport(opB)).id, workstationId: wsB, reprintReason: null })).job;
    expect(jobA).toMatchObject({ workstationName: "POSTE-A", widthMm: 100, heightMm: 100 });
    expect(jobB).toMatchObject({ workstationName: "POSTE-B", widthMm: 102, heightMm: 152, orientation: "ROTATE_90" }); // physical page matches the roll

    await savePrinterProfile(opB, { workstationId: wsB, name: "POSTE-B", widthMm: 100, heightMm: 150 });
    expect(await getPrinterProfile(wsA)).toMatchObject({ widthMm: 100, heightMm: 100 });
    expect((await getPrinterProfile(wsA))?.confirmedAt).not.toBeNull();
    expect((await getPrinterProfile(wsB))?.confirmedAt).toBeNull();
  });

  it("operators set up their own PC's label size (audited); the print API requires a session and a trusted origin", async () => {
    const op = await makeActor();
    const ws = randomUUID();
    const res = await putProfileRoute(request("/api/printer-profile", { method: "PUT", token: op.token, body: { workstationId: ws, name: "POSTE-C", widthMm: 100, heightMm: 100 } }), {});
    expect(res.status).toBe(200);
    expect(await prisma.auditEvent.count({ where: { type: "LABEL_SETTINGS_SAVED", username: op.username } })).toBe(1);

    const body = { idempotencyKey: key(), kind: "TEST", reportId: null, workstationId: ws, reprintReason: null };
    expect((await createJobRoute(request("/api/print-jobs", { body }), {})).status).toBe(401);
    expect((await createJobRoute(request("/api/print-jobs", { body, token: op.token, origin: "http://evil.example" }), {})).status).toBe(403);
    expect((await createJobRoute(request("/api/print-jobs", { body, token: op.token }), {})).status).toBe(200);
  });

  it("the server never prints: no printer connection or print-language code in server code", () => {
    const root = path.resolve(__dirname, "../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk(path.join(root, "lib"));
    walk(path.join(root, "app"));
    const forbidden = /node:net|node:dgram|child_process|from "net"|BrowserPrint|:9100|:9101|\^XA|createConnection/;
    const offenders = files.filter((f) => forbidden.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
    expect(offenders).toEqual([]);
  });
});
