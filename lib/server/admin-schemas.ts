import "server-only";
import { z } from "zod";
import { uuid } from "./schemas";
export const reasonSchema = z.string().trim().min(3).max(500);
export const voidItemSchema = z.strictObject({ itemId: uuid, confirmSerial: z.string().regex(/^\d{4,30}$/), reason: reasonSchema });
export const resetControlSchema = z.strictObject({ confirmSerial: z.string().regex(/^\d{4,30}$/), expectedGeneration: z.number().int().positive(), expectedAcceptedCount: z.number().int().min(0).max(999), reason: reasonSchema, newGalia: z.string().max(128).optional() });
export const notesSchema = z.strictObject({ notes: z.string().max(500).nullable(), reason: reasonSchema });
export const heartbeatSchema = z.strictObject({ tabId: uuid, workstationId: uuid.nullable(), boxId: uuid.nullable(), active: z.boolean() });
