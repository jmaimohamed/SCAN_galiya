/**
 * « At most one automatic print dialog per finalized attempt. »
 *
 * The automatic dialog is requested only from the end-of-control handler (never
 * from an effect), and only after claiming the report id here. The claim lives
 * in memory and in this tab's sessionStorage, so a retried end request, a
 * duplicate GALIA event, React Strict Mode, a page refresh or history navigation
 * can never open a second automatic dialog for the same report. Later prints go
 * through the explicit buttons (« Imprimer maintenant » once if the dialog was
 * blocked, then « Réimprimer… » with a reason).
 */
const KEY = "galia.autoPrintedReports.v1";
const MAX_REMEMBERED = 50;
const claimed = new Set<string>();

function readStored(): string[] {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeStored(list: string[]) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_REMEMBERED)));
  } catch {
    /* memory claim still applies for this page */
  }
}

/** True exactly once per report id (per tab): the caller may open the automatic dialog. */
export function claimAutoPrint(reportId: string): boolean {
  if (claimed.has(reportId)) return false;
  const stored = readStored();
  claimed.add(reportId);
  if (stored.includes(reportId)) return false;
  writeStored([...stored, reportId]);
  return true;
}

/** Test helper. */
export function resetAutoPrintClaims() {
  claimed.clear();
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
