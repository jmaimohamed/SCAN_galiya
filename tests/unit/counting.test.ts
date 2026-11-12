import { describe, expect, it } from "vitest";
import { computeCounts, countsFromReport, issueCodes, issueLines, isStrictOk, piecesToRemove } from "@/lib/counting";

const obs = (outcome: string, serial: string | null = null) => ({ outcome, serial });
const accepted = (n: number) => Array.from({ length: n }, (_, i) => obs("ACCEPTED", `A${i}`));

describe("honest counting rules", () => {
  it("five valid covers for five: target reached, strictly OK", () => {
    const c = computeCounts(5, 5, accepted(5));
    expect(c).toMatchObject({ distinct: 5, conforming: 5, nonconforming: 0, missing: 0, extra: 0, events: 5 });
    expect(isStrictOk(c)).toBe(true);
    expect(issueLines(c)).toEqual(["CONFORME — Quantité et références vérifiées"]);
    expect(issueCodes(c)).toEqual([]);
  });

  it("a sixth distinct cover is excess: 6 / 5, NOT OK", () => {
    const c = computeCounts(5, 5, [...accepted(5), obs("EXCESS", "S6")]);
    expect(c).toMatchObject({ distinct: 6, conforming: 6, excess: 1, extra: 1, missing: 0 });
    expect(isStrictOk(c)).toBe(false);
    expect(issueLines(c)).toEqual(["EXCÉDENT : 1 pièce"]);
    expect(issueCodes(c)).toEqual(["EXCESS"]);
  });

  it("four for five: missing one", () => {
    const c = computeCounts(5, 4, accepted(4));
    expect(c).toMatchObject({ distinct: 4, missing: 1 });
    expect(issueLines(c)).toEqual(["MANQUANT : 1 pièce"]);
  });

  it("wrong PN and other-box serials are nonconforming and never fill the quantity", () => {
    const c = computeCounts(5, 4, [...accepted(4), obs("WRONG_PART_NUMBER", "W1"), obs("DUPLICATE_OTHER_BOX", "O1")]);
    expect(c).toMatchObject({ distinct: 6, conforming: 4, nonconforming: 2, wrongPartNumber: 1, otherBox: 1, missing: 1, extra: 1 });
    expect(issueLines(c)).toEqual(["MANQUANT : 1 pièce", "EXCÉDENT : 1 pièce", "RÉFÉRENCE DIFFÉRENTE : 1 pièce", "SÉRIE DÉJÀ UTILISÉE : 1 pièce"]);
  });

  it("duplicates and invalid scans are tentatives: they never change a quantity but make the result NOT OK", () => {
    const c = computeCounts(2, 2, [...accepted(2), obs("DUPLICATE_SAME_BOX", "A0"), obs("DUPLICATE_SAME_BOX", "A0"), obs("INVALID_FORMAT")]);
    expect(c).toMatchObject({ distinct: 2, conforming: 2, duplicates: 2, invalid: 1, events: 5 });
    expect(isStrictOk(c)).toBe(false);
    expect(issueLines(c)).toEqual(["SCAN EN DOUBLE : 2 tentatives", "FORMAT INVALIDE : 1 tentative"]);
    expect(issueCodes(c)).toEqual(["DUPLICATE_SCAN", "INVALID_SCAN"]);
  });

  it("lease refusals and late scans are not part of the tally", () => {
    const c = computeCounts(1, 1, [obs("ACCEPTED", "A"), obs("NOT_BOX_OWNER", "X"), obs("BOX_NOT_IN_PROGRESS", "Y")]);
    expect(c.events).toBe(1);
    expect(isStrictOk(c)).toBe(true);
  });

  it("legacy QUANTITY_REACHED rows count as excess, once per serial", () => {
    const c = computeCounts(1, 1, [obs("ACCEPTED", "A"), obs("QUANTITY_REACHED", "B"), obs("QUANTITY_REACHED", "B")]);
    expect(c).toMatchObject({ excess: 1, distinct: 2, extra: 1 });
  });

  it("restores the same numbers from a saved report, including legacy reports", () => {
    const legacy = countsFromReport({ countingVersion: 1, expectedQty: 20, acceptedQty: 18, excessQty: 0, wrongPartNumberQty: 0, otherBoxQty: 0, duplicateAttempts: 0, invalidAttempts: 0 });
    expect(issueLines(legacy)).toEqual(["MANQUANT : 2 pièces"]);
    const v2 = countsFromReport({ countingVersion: 2, expectedQty: 5, acceptedQty: 5, excessQty: 1, wrongPartNumberQty: 1, otherBoxQty: 0, duplicateAttempts: 0, invalidAttempts: 0 });
    expect(v2).toMatchObject({ distinct: 7, conforming: 6, nonconforming: 1, extra: 2 });
    expect(piecesToRemove(v2)).toBe(2);
  });
});
