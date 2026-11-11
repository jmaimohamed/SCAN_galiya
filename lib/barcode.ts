/**
 * GALIA barcode parsing — shared by the server (authoritative) and the browser
 * (routing a scan to the right endpoint + diagnostics).
 *
 * Supported payloads (the supplied text formats are the source of truth):
 *
 *   Box label   : P<PN>_Q<QTY>_S<BOX SERIAL>      e.g. PL002815593B96AG_Q20_S10428865
 *   Item label  : <PN>_S<ITEM SERIAL>              e.g. L002815593B96AG_S70166592310
 *
 * Rules
 *  - Only surrounding transport CR/LF is removed; all payload bytes are preserved.
 *  - The whole payload must match an anchored pattern; nothing is fuzzy-matched,
 *    case is never changed, internal characters are never removed.
 *  - On a box label only the leading "P" field marker is removed. On an item label
 *    the first character belongs to the PN and is kept.
 *  - PN: upper-case A–Z and digits 0–9, PN_MIN..PN_MAX characters.
 *  - Serials: digits 0–9 only, SERIAL_MIN..SERIAL_MAX characters, kept as strings
 *    (leading zeros preserved).
 *  - Quantity: digits only, 1..QTY_MAX (leading zeros accepted, value bounded).
 */

export const BARCODE_LIMITS = {
  RAW_MAX: 128,
  PN_MIN: 3,
  PN_MAX: 40,
  SERIAL_MIN: 4,
  SERIAL_MAX: 30,
  QTY_MIN: 1,
  QTY_MAX: 999,
  QTY_DIGITS_MAX: 4,
} as const;

export type ParseErrorCode =
  | "EMPTY"
  | "TOO_LONG"
  | "CONTROL_OR_SPACE"
  | "LOWERCASE"
  | "KEYBOARD_LAYOUT"
  | "INVALID_CHARACTERS"
  | "PN_ONLY"
  | "SERIAL_ONLY"
  | "BOX_LABEL_EXPECTED"
  | "ITEM_LABEL_EXPECTED"
  | "PN_LENGTH"
  | "SERIAL_LENGTH"
  | "QUANTITY_INVALID"
  | "MALFORMED";

export interface BoxLabel {
  kind: "BOX";
  /** Payload without surrounding transport CR/LF — the exact barcode content. */
  payload: string;
  partNumber: string;
  quantity: number;
  boxSerial: string;
}

export interface ItemLabel {
  kind: "ITEM";
  payload: string;
  partNumber: string;
  serial: string;
}

export interface ParseError {
  kind: "ERROR";
  code: ParseErrorCode;
  message: string;
  payload: string;
}

export type ParsedScan = BoxLabel | ItemLabel | ParseError;

const PN = `[A-Z0-9]+`;
const BOX_RE = new RegExp(`^P(${PN})_Q([0-9]+)_S([0-9]+)$`);
const ITEM_RE = new RegExp(`^(${PN})_S([0-9]+)$`);

/** Characters produced when a US-QWERTY scanner types into a French AZERTY PC (or the reverse). */
const LAYOUT_ARTIFACTS = /[&éè"'(çà§°µ²¨£¤]/;

const MESSAGES: Record<ParseErrorCode, string> = {
  EMPTY: "Scan vide.",
  TOO_LONG: `Scan trop long (maximum ${BARCODE_LIMITS.RAW_MAX} caractères).`,
  CONTROL_OR_SPACE: "Espace ou caractère de contrôle à l'intérieur du code.",
  LOWERCASE:
    "Lettres minuscules reçues : vérifier Verr. Maj et la configuration clavier du scanner.",
  KEYBOARD_LAYOUT:
    "Caractères typiques d'une disposition clavier différente (AZERTY/QWERTY) : configurer le scanner comme le clavier Windows.",
  INVALID_CHARACTERS: "Caractère non autorisé (seuls A–Z, 0–9 et « _ » sont acceptés).",
  PN_ONLY: "Code incomplet : référence seule, sans numéro de série.",
  SERIAL_ONLY: "Code incomplet : numéro de série seul, sans référence.",
  BOX_LABEL_EXPECTED: "Étiquette GALIA de boîte attendue (format P<PN>_Q<QTÉ>_S<SÉRIE>).",
  ITEM_LABEL_EXPECTED: "Étiquette de coiffe attendue (format <PN>_S<SÉRIE>).",
  PN_LENGTH: `Longueur de référence invalide (${BARCODE_LIMITS.PN_MIN} à ${BARCODE_LIMITS.PN_MAX} caractères).`,
  SERIAL_LENGTH: `Longueur de numéro de série invalide (${BARCODE_LIMITS.SERIAL_MIN} à ${BARCODE_LIMITS.SERIAL_MAX} chiffres).`,
  QUANTITY_INVALID: `Quantité invalide (entier de ${BARCODE_LIMITS.QTY_MIN} à ${BARCODE_LIMITS.QTY_MAX}).`,
  MALFORMED: "Format invalide.",
};

function fail(code: ParseErrorCode, payload: string): ParseError {
  return { kind: "ERROR", code, message: MESSAGES[code], payload };
}

/** Remove surrounding transport CR/LF only; spaces and tabs are malformed data. */
export function stripTransport(raw: string): string {
  return raw.replace(/^[\r\n]+|[\r\n]+$/g, "");
}

function lengthOk(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max;
}

/** Character-level checks shared by both label types. Returns an error or null. */
function checkCharacters(payload: string): ParseError | null {
  if (payload.length === 0) return fail("EMPTY", payload);
  if (payload.length > BARCODE_LIMITS.RAW_MAX) return fail("TOO_LONG", payload);
  if (/[\u0000- \u007f-\u009f]/.test(payload)) return fail("CONTROL_OR_SPACE", payload);
  if (LAYOUT_ARTIFACTS.test(payload)) return fail("KEYBOARD_LAYOUT", payload);
  if (/[a-z]/.test(payload)) return fail("LOWERCASE", payload);
  if (/[^A-Z0-9_]/.test(payload)) return fail("INVALID_CHARACTERS", payload);
  return null;
}

/** Explain a payload that is neither format (better messages for partial codes). */
function explainMalformed(payload: string): ParseError {
  if (/^[0-9]+$/.test(payload)) return fail("SERIAL_ONLY", payload);
  if (/^S[0-9]+$/.test(payload)) return fail("SERIAL_ONLY", payload);
  if (/^[A-Z0-9]+$/.test(payload)) return fail("PN_ONLY", payload);
  return fail("MALFORMED", payload);
}

function parseBoxPayload(payload: string): BoxLabel | ParseError | null {
  const m = BOX_RE.exec(payload);
  if (!m) return null;
  const [, partNumber, qtyDigits, boxSerial] = m;
  if (!lengthOk(partNumber, BARCODE_LIMITS.PN_MIN, BARCODE_LIMITS.PN_MAX)) return fail("PN_LENGTH", payload);
  if (!lengthOk(boxSerial, BARCODE_LIMITS.SERIAL_MIN, BARCODE_LIMITS.SERIAL_MAX)) return fail("SERIAL_LENGTH", payload);
  if (qtyDigits.length > BARCODE_LIMITS.QTY_DIGITS_MAX) return fail("QUANTITY_INVALID", payload);
  const quantity = Number.parseInt(qtyDigits, 10);
  if (!Number.isSafeInteger(quantity) || quantity < BARCODE_LIMITS.QTY_MIN || quantity > BARCODE_LIMITS.QTY_MAX) {
    return fail("QUANTITY_INVALID", payload);
  }
  return { kind: "BOX", payload, partNumber, quantity, boxSerial };
}

function parseItemPayload(payload: string): ItemLabel | ParseError | null {
  const m = ITEM_RE.exec(payload);
  if (!m) return null;
  const [, partNumber, serial] = m;
  if (!lengthOk(partNumber, BARCODE_LIMITS.PN_MIN, BARCODE_LIMITS.PN_MAX)) return fail("PN_LENGTH", payload);
  if (!lengthOk(serial, BARCODE_LIMITS.SERIAL_MIN, BARCODE_LIMITS.SERIAL_MAX)) return fail("SERIAL_LENGTH", payload);
  return { kind: "ITEM", payload, partNumber, serial };
}

/** Classify any scan as a box label, an item label, or a precise error. */
export function parseScan(raw: string): ParsedScan {
  const payload = stripTransport(raw);
  const charError = checkCharacters(payload);
  if (charError) return charError;
  // A box label has exactly three fields (P…_Q…_S…); an item label has two.
  // The patterns are mutually exclusive, so the order below is not ambiguous.
  const box = parseBoxPayload(payload);
  if (box) return box;
  const item = parseItemPayload(payload);
  if (item) return item;
  return explainMalformed(payload);
}

export function parseBoxLabel(raw: string): BoxLabel | ParseError {
  const parsed = parseScan(raw);
  if (parsed.kind === "ITEM") return fail("BOX_LABEL_EXPECTED", parsed.payload);
  return parsed;
}

export function parseItemLabel(raw: string): ItemLabel | ParseError {
  const parsed = parseScan(raw);
  if (parsed.kind === "BOX") return fail("ITEM_LABEL_EXPECTED", parsed.payload);
  return parsed;
}

/** Bounded copy of a raw scan for audit storage (never used for logic). */
export function boundRaw(raw: string, max = 160): string {
  return raw.length > max ? raw.slice(0, max) : raw;
}
