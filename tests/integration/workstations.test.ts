import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PUT as putProfileRoute } from "@/app/api/printer-profile/route";
import { POST as createJobRoute } from "@/app/api/print-jobs/route";
import { prisma } from "@/lib/server/db";
import { finalizeBox, scanItem } from "@/lib/server/services/boxes";
import { confirmPrinterProfile, createPrintJob, getPrinterProfile, savePrinterProfile } from "@/lib/server/services/printing";
import { boxLabel, itemLabel, key, makeActor, nextSerial, openLeased, request, resetDb } from "../support/db";

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
  const fin = await finalizeBox(actor, { boxId: box.id, leaseToken, observedAcceptedCount: 1 });
  if (fin.kind !== "FINALIZED") throw new Error(fin.kind);
  return fin.report;
}

describe("one server, several operator PCs (browser print dialog)", () => {
  it("each workstation keeps its own label settings; every job records the PC and size it was printed for", async () => {
    const opA = await makeActor("OPERATOR", "OP_A");
    const opB = await makeActor("OPERATOR", "OP_B");
    const wsA = await setup(opA, "POSTE-A", 100, 100);
    const wsB = await setup(opB, "POSTE-B", 102, 152);
    const jobA = (await createPrintJob(opA, { idempotencyKey: key(), kind: "ORIGINAL", reportId: (await okReport(opA)).id, workstationId: wsA, reprintReason: null })).job;
    const jobB = (await createPrintJob(opB, { idempotencyKey: key(), kind: "ORIGINAL", reportId: (await okReport(opB)).id, workstationId: wsB, reprintReason: null })).job;
    expect(jobA).toMatchObject({ workstationName: "POSTE-A", widthMm: 100, heightMm: 100 });
    expect(jobB).toMatchObject({ workstationName: "POSTE-B", widthMm: 102, heightMm: 152 });

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
