import "server-only";
import { z } from "zod";
import { badRequest } from "./errors";

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
  })
  .refine((v) => (v.raw === undefined) !== (v.boxId === undefined), { message: "raw ou boxId (un seul)" });

export const scanSchema = z.object({
  idempotencyKey: uuid,
  raw: rawScan,
  leaseToken,
});

export const suspendSchema = z.object({ leaseToken, reason: z.string().max(40).optional() });

export const finalizeSchema = z.object({
  leaseToken,
  observedAcceptedCount: z.number().int().min(0).max(100_000),
  incompleteReason: z.string().max(500).nullable().optional(),
});

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
  widthMm: z.number().int().min(50).max(104),
  heightMm: z.number().int().min(50).max(200),
});

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
