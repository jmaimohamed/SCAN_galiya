import { plantYear } from "./time";

/** Display reference of a final report, e.g. VR-2026-000042. Unique because `number` is. */
export function reportReference(number: number, finalizedAt: Date | string): string {
  const year = plantYear(new Date(finalizedAt));
  return `VR-${year}-${String(number).padStart(6, "0")}`;
}

export type ScanOutcomeCode =
  | "ACCEPTED"
  | "INVALID_FORMAT"
  | "WRONG_PART_NUMBER"
  | "DUPLICATE_SAME_BOX"
  | "DUPLICATE_OTHER_BOX"
  | "QUANTITY_REACHED"
  | "BOX_NOT_IN_PROGRESS"
  | "NOT_BOX_OWNER"
  | "EXCESS";

export const OUTCOME_TITLES: Record<ScanOutcomeCode, string> = {
  ACCEPTED: "OK — Pièce conforme comptée",
  INVALID_FORMAT: "FORMAT INVALIDE — non compté",
  WRONG_PART_NUMBER: "RÉFÉRENCE DIFFÉRENTE — pièce non conforme",
  DUPLICATE_SAME_BOX: "SCAN EN DOUBLE — déjà compté",
  DUPLICATE_OTHER_BOX: "SÉRIE DÉJÀ UTILISÉE dans une autre boîte",
  QUANTITY_REACHED: "Excédent (ancien contrôle)",
  BOX_NOT_IN_PROGRESS: "Contrôle déjà terminé — scan non compté",
  NOT_BOX_OWNER: "Boîte contrôlée par une autre session",
  EXCESS: "DÉPASSEMENT — pièce en excédent",
};

export const STATUS_LABELS: Record<"IN_PROGRESS" | "OK" | "NOK", string> = {
  IN_PROGRESS: "En cours",
  OK: "OK",
  NOK: "NON OK",
};

export const ISSUE_LABELS: Record<string, string> = {
  // Counting rules v2
  MISSING: "Manquant",
  EXCESS: "Excédent",
  WRONG_PART_NUMBER: "Référence différente",
  OTHER_BOX_SERIAL: "Série déjà utilisée",
  DUPLICATE_SCAN: "Scan en double",
  INVALID_SCAN: "Format invalide",
  // Legacy reports (rules v1)
  INCOMPLETE: "Quantité incomplète",
  OVER_QUANTITY: "Quantité dépassée",
  PART_NUMBER_MISMATCH: "Référence non conforme",
  DUPLICATE_SERIAL: "Numéro de série en double",
};

export const PRINT_STATUS_LABELS: Record<string, string> = {
  DIALOG_REQUESTED: "Fenêtre d'impression demandée — sortie non confirmée",
  // Legacy direct-printing (Browser Print) states, kept for history.
  CREATED: "Créé (non envoyé)",
  DISPATCHING: "Envoi en cours",
  SENT_TO_PRINTER: "Données envoyées à l'imprimante",
  FAILED: "Échec (non envoyé)",
  UNKNOWN: "Envoi incertain — vérifier l'imprimante",
};

export const PRINT_TYPE_LABELS: Record<string, string> = {
  ORIGINAL: "Original",
  REPRINT: "Réimpression",
  TEST: "Test",
};
