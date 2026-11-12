import "server-only";
import { z } from "zod";
import { badRequest } from "./errors";
import { LABEL_LIMITS } from "@/lib/zpl/layout";

/** Raw scans are bounded here; the barcode parser enforces the real format. */
const rawScan = z.string().max(512);
const leaseToken = z.string().min(20).max(100);
export const uuid = z.uuid();

export function parseId(value: string): string {
  const r = uuid.safeParse(value);
  if (!r.success) throw badRequest("Identifiant invalide.");
  return r.data;
}

export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export const openBoxSchema = z
  .object({
    raw: rawScan.optional(),
    boxId: uuid.optional(),
    takeover: z.boolean().optional(),
    /** Explicit "OUI — Corriger" on a closed NOT OK box. */
    startCorrection: z.boolean().optional(),
    /** Exact report offered to the operator; stale confirmations cannot restart later results. */
    correctionReportId: uuid.optional(),
    /** Operator confirms the excess / non-conforming pieces of the NOT OK control were removed. */
    removalConfirmed: z.boolean().optional(),
  })
  .refine((v) => (v.raw === undefined) !== (v.boxId === undefined), { message: "raw ou boxId (un seul)" })
  .refine((v) => !v.startCorrection || !!v.correctionReportId, { message: "Confirmer le rapport NOT OK à recontrôler." });

export const scanSchema = z.object({
  idempotencyKey: uuid,
  raw: rawScan,
  leaseToken,
});

export const suspendSchema = z.object({ leaseToken, reason: z.string().max(40).optional() });

export const finalizeSchema = z
  .object({
    leaseToken,
    attemptId: uuid,
    /** GALIA_RESCAN = the same GALIA was scanned again; MANUAL = « Terminer le contrôle ». */
    trigger: z.enum(["GALIA_RESCAN", "MANUAL"]),
    galiaRaw: rawScan.nullable().optional(),
    observed: z.object({ events: z.number().int().min(0).max(100_000), reserved: z.number().int().min(0).max(100_000) }),
    note: z.string().max(500).nullable().optional(),
    /** Workstation of this browser: the automatic print request uses its label settings. */
    workstationId: uuid.nullable().optional(),
  })
  .refine((v) => v.trigger !== "GALIA_RESCAN" || !!v.galiaRaw, { message: "galiaRaw requis pour GALIA_RESCAN" });

export const createPrintJobSchema = z.object({
  idempotencyKey: uuid,
  kind: z.enum(["ORIGINAL", "REPRINT", "TEST"]),
  reportId: uuid.nullable(),
  workstationId: uuid,
  reprintReason: z.string().max(200).nullable(),
});

/** Label size of THIS workstation (the printer itself is chosen in the print dialog). */
export const printerProfileSchema = z.object({
  workstationId: uuid,
  name: z.string().trim().min(1).max(64),
  /** Actual stock dimensions; the layout separately respects the printhead width. */
  widthMm: z.number().int().min(LABEL_LIMITS.widthMinMm).max(LABEL_LIMITS.widthMaxMm),
  /** Along the feed (label length). */
  heightMm: z.number().int().min(LABEL_LIMITS.heightMinMm).max(LABEL_LIMITS.heightMaxMm),
  orientation: z.enum(["LANDSCAPE", "ROTATE_90", "NONE"]).optional(),
  contentPosition: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
  contentLengthMm: z.number().int().min(LABEL_LIMITS.heightMinMm).max(LABEL_LIMITS.heightMaxMm).nullable().optional(),
}).refine((v) => v.contentLengthMm == null || v.contentLengthMm <= v.heightMm, { message: "La zone imprimée dépasse la longueur du papier." });

export const confirmProfileSchema = z.object({
  workstationId: uuid,
  labelChecked: z.boolean(),
});

export const createUserSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  username: z.string().min(2).max(32),
  displayName: z.string().max(80).nullable(),
  role: z.enum(["OPERATOR", "ADMIN"]),
  password: z.string().min(1).max(256),
});

export const updateUserSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  active: z.boolean().optional(),
  role: z.enum(["OPERATOR", "ADMIN"]).optional(),
  displayName: z.string().max(80).nullable().optional(),
});

export const passwordSchema = z.object({ reason: z.string().trim().min(3).max(500), password: z.string().min(1).max(256) });
