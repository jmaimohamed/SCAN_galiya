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
  | "NOT_BOX_OWNER";

export const OUTCOME_TITLES: Record<ScanOutcomeCode, string> = {
  ACCEPTED: "OK — Pièce acceptée",
  INVALID_FORMAT: "Format invalide",
  WRONG_PART_NUMBER: "NON OK — Référence différente",
  DUPLICATE_SAME_BOX: "Déjà scannée dans cette boîte",
  DUPLICATE_OTHER_BOX: "Déjà scannée dans une autre boîte",
  QUANTITY_REACHED: "Quantité prévue déjà atteinte",
  BOX_NOT_IN_PROGRESS: "Boîte déjà finalisée",
  NOT_BOX_OWNER: "Boîte contrôlée par une autre session",
};

export const STATUS_LABELS: Record<"IN_PROGRESS" | "OK" | "NOK", string> = {
  IN_PROGRESS: "En cours",
  OK: "OK",
  NOK: "NON OK",
};

export const ISSUE_LABELS: Record<string, string> = {
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
