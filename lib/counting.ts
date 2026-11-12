/**
 * Honest counting rules (version 2) — one pure module shared by the server
 * (scan, finalize, report) and the browser (counters, banners). The database
 * report guard (migration 20261114090000_strict_counting) recomputes the same
 * numbers from the recorded scans, so a report can never disagree with them.
 *
 * Identities: a seat cover is identified by its serial.
 *  - reserved      covers accepted in this box (right PN, serial free): they hold
 *                  the box's serial reservations — "acceptedQty" of the report.
 *  - excess        right PN, serial free, but scanned after the box already held
 *                  its GALIA quantity. Recorded, NEVER reserved (the serial stays
 *                  free for its real box).
 *  - wrongPart     wrong part number. Recorded, never reserved.
 *  - otherBox      serial already reserved by another box. Recorded, the other
 *                  box keeps its reservation.
 *  - duplicates    a cover already seen in this box/attempt scanned again: one
 *                  tentative each, the quantity does not change.
 *  - invalid       unreadable / wrong-format payloads: one tentative each.
 *
 *  conforming    = reserved + excess
 *  nonconforming = wrongPart + otherBox
 *  distinct      = conforming + nonconforming   ("Pièces distinctes scannées")
 *  extra         = max(0, distinct − expected)
 *  missing       = max(0, expected − conforming)
 *
 * Strict OK: distinct = expected = reserved and every other number is 0.
 * Not mistakes (never recorded as scans): the GALIA rescan that ends the control,
 * a retried request with the same idempotency key, a suppressed duplicate input event.
 */

export type CountedOutcome =
  | "ACCEPTED"
  | "EXCESS"
  | "QUANTITY_REACHED"
  | "WRONG_PART_NUMBER"
  | "DUPLICATE_OTHER_BOX"
  | "DUPLICATE_SAME_BOX"
  | "INVALID_FORMAT";

const COUNTED = new Set<string>(["ACCEPTED", "EXCESS", "QUANTITY_REACHED", "WRONG_PART_NUMBER", "DUPLICATE_OTHER_BOX", "DUPLICATE_SAME_BOX", "INVALID_FORMAT"]);

/** Scan outcomes that are part of a control's tally (BOX_NOT_IN_PROGRESS / NOT_BOX_OWNER are not). */
export function isCountedOutcome(outcome: string): outcome is CountedOutcome {
  return COUNTED.has(outcome);
}

export interface ControlCounts {
  expected: number;
  /** Conforming covers holding a reservation in this box (cumulative across attempts). */
  reserved: number;
  excess: number;
  wrongPartNumber: number;
  otherBox: number;
  conforming: number;
  nonconforming: number;
  distinct: number;
  extra: number;
  missing: number;
  duplicates: number;
  invalid: number;
  /** Counted scan answers recorded in the current attempt (finalization precondition). */
  events: number;
}

export interface Observation {
  outcome: string;
  serial: string | null;
}

function distinctSerials(obs: Observation[], outcomes: string[]): number {
  return new Set(obs.filter((o) => outcomes.includes(o.outcome)).map((o) => o.serial ?? "")).size;
}

/** Counts of the current attempt: `reserved` from the box, observations from this attempt's scans. */
export function computeCounts(expected: number, reserved: number, observations: Observation[]): ControlCounts {
  const counted = observations.filter((o) => isCountedOutcome(o.outcome));
  const excess = distinctSerials(counted, ["EXCESS", "QUANTITY_REACHED"]);
  const wrongPartNumber = distinctSerials(counted, ["WRONG_PART_NUMBER"]);
  const otherBox = distinctSerials(counted, ["DUPLICATE_OTHER_BOX"]);
  const duplicates = counted.filter((o) => o.outcome === "DUPLICATE_SAME_BOX").length;
  const invalid = counted.filter((o) => o.outcome === "INVALID_FORMAT").length;
  return deriveCounts({ expected, reserved, excess, wrongPartNumber, otherBox, duplicates, invalid, events: counted.length });
}

export function deriveCounts(base: Pick<ControlCounts, "expected" | "reserved" | "excess" | "wrongPartNumber" | "otherBox" | "duplicates" | "invalid" | "events">): ControlCounts {
  const conforming = base.reserved + base.excess;
  const nonconforming = base.wrongPartNumber + base.otherBox;
  const distinct = conforming + nonconforming;
  return {
    ...base,
    conforming,
    nonconforming,
    distinct,
    extra: Math.max(0, distinct - base.expected),
    missing: Math.max(0, base.expected - conforming),
  };
}

export type IssueCode = "MISSING" | "EXCESS" | "WRONG_PART_NUMBER" | "OTHER_BOX_SERIAL" | "DUPLICATE_SCAN" | "INVALID_SCAN";

/** Issue codes stored on the report, in display order. */
export function issueCodes(c: ControlCounts): IssueCode[] {
  const out: IssueCode[] = [];
  if (c.missing > 0) out.push("MISSING");
  if (c.extra > 0 || c.excess > 0) out.push("EXCESS");
  if (c.wrongPartNumber > 0) out.push("WRONG_PART_NUMBER");
  if (c.otherBox > 0) out.push("OTHER_BOX_SERIAL");
  if (c.duplicates > 0) out.push("DUPLICATE_SCAN");
  if (c.invalid > 0) out.push("INVALID_SCAN");
  return out;
}

export function isStrictOk(c: ControlCounts): boolean {
  return (
    c.reserved === c.expected &&
    c.distinct === c.expected &&
    c.excess === 0 &&
    c.nonconforming === 0 &&
    c.extra === 0 &&
    c.missing === 0 &&
    c.duplicates === 0 &&
    c.invalid === 0
  );
}

const piece = (n: number) => `${n} pièce${n > 1 ? "s" : ""}`;
const tentative = (n: number) => `${n} tentative${n > 1 ? "s" : ""}`;

/**
 * Concise French explanation (label + screens). One line per issue; the OK line
 * only when the control is strictly OK. Never lists individual serials.
 */
export function issueLines(c: ControlCounts): string[] {
  if (isStrictOk(c)) return ["CONFORME — Quantité et références vérifiées"];
  const lines: string[] = [];
  if (c.missing > 0) lines.push(`MANQUANT : ${piece(c.missing)}`);
  // Matching covers beyond the quantity are excess even when wrong pieces leave
  // `extra` at 0 (e.g. 5 expected, 5 right + 1 wrong = 1 extra; 1 excess = 1 extra).
  const over = Math.max(c.extra, c.excess);
  if (over > 0) lines.push(`EXCÉDENT : ${piece(over)}`);
  if (c.wrongPartNumber > 0) lines.push(`RÉFÉRENCE DIFFÉRENTE : ${piece(c.wrongPartNumber)}`);
  if (c.otherBox > 0) lines.push(`SÉRIE DÉJÀ UTILISÉE : ${piece(c.otherBox)}`);
  if (c.duplicates > 0) lines.push(`SCAN EN DOUBLE : ${tentative(c.duplicates)}`);
  if (c.invalid > 0) lines.push(`FORMAT INVALIDE : ${tentative(c.invalid)}`);
  return lines;
}

/** Counts saved on a report (version 2), or derived from a legacy report (version 1). */
export interface ReportCounts {
  countingVersion: number;
  expectedQty: number;
  acceptedQty: number;
  excessQty: number;
  wrongPartNumberQty: number;
  otherBoxQty: number;
  duplicateAttempts: number;
  invalidAttempts: number;
}

export function countsFromReport(r: ReportCounts): ControlCounts {
  return deriveCounts({
    expected: r.expectedQty,
    reserved: r.acceptedQty,
    excess: r.excessQty,
    wrongPartNumber: r.wrongPartNumberQty,
    otherBox: r.otherBoxQty,
    duplicates: r.duplicateAttempts,
    invalid: r.invalidAttempts,
    events: 0,
  });
}

/** Pieces that physically sit in the box but must be taken out before a correction can end OK. */
export function piecesToRemove(c: Pick<ControlCounts, "excess" | "wrongPartNumber" | "otherBox">): number {
  return c.excess + c.wrongPartNumber + c.otherBox;
}
