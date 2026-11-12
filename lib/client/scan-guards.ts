import type { BoxLabel } from "@/lib/barcode";

/**
 * Input-event guards of the control page (pure, unit-tested).
 *
 * 1. Duplicate input event: the same payload received again within
 *    DUPLICATE_EVENT_WINDOW_MS, with nothing in between, is one physical
 *    trigger delivered twice (scanner/keyboard echo). It is suppressed and is
 *    NOT a mistake. A deliberate second scan of the same label takes longer
 *    than this and is recorded (and counted as « scan en double » for a cover).
 * 2. GALIA echo after opening: the GALIA that just opened the box, received
 *    again within GALIA_ECHO_GUARD_MS of that opening scan, is ignored, so a
 *    double-triggered opening can never immediately end the new control. A
 *    later, intentional rescan ends the control.
 * 3. GALIA echo after ending: the same GALIA within GALIA_ECHO_GUARD_MS of the
 *    end of its control is ignored (it would otherwise reopen / offer a correction).
 */
export const DUPLICATE_EVENT_WINDOW_MS = 800;
export const GALIA_ECHO_GUARD_MS = 2000;

export class DuplicateEventFilter {
  private last: { raw: string; at: number } | null = null;

  constructor(private readonly windowMs = DUPLICATE_EVENT_WINDOW_MS) {}

  /** True when the event must be processed; false for a suppressed echo (measured from the last processed event). */
  accept(raw: string, at: number): boolean {
    const echo = this.last !== null && this.last.raw === raw && at - this.last.at >= 0 && at - this.last.at < this.windowMs;
    if (!echo) this.last = { raw, at };
    return !echo;
  }
}

export interface ActiveControlRef {
  galiaPayload: string;
  boxSerial: string;
  /** Receive time of the GALIA scan that opened the control (0 when opened by a button). */
  openedAt: number;
  openedByScan: boolean;
  lost: boolean;
}

export type GaliaDecision =
  /** Exact same GALIA payload: end this control. */
  | "END"
  /** Echo of the opening scan: ignore. */
  | "ECHO_AFTER_OPEN"
  /** Echo of the GALIA that just ended its control: ignore. */
  | "ECHO_AFTER_END"
  /** Same box serial, different payload: never ends the control. */
  | "SAME_BOX_OTHER_PAYLOAD"
  /** Another box while a control is open: explicit choice required. */
  | "OTHER_BOX"
  /** No usable open control: open / resume through the server. */
  | "OPEN";

export function decideGaliaScan(
  active: ActiveControlRef | null,
  label: Pick<BoxLabel, "payload" | "boxSerial">,
  receivedAt: number,
  recentEnd: { payload: string; at: number } | null,
): GaliaDecision {
  if (active && !active.lost) {
    if (label.payload === active.galiaPayload) {
      return active.openedByScan && receivedAt - active.openedAt < GALIA_ECHO_GUARD_MS ? "ECHO_AFTER_OPEN" : "END";
    }
    return label.boxSerial === active.boxSerial ? "SAME_BOX_OTHER_PAYLOAD" : "OTHER_BOX";
  }
  if (recentEnd && recentEnd.payload === label.payload && receivedAt - recentEnd.at < GALIA_ECHO_GUARD_MS) return "ECHO_AFTER_END";
  return "OPEN";
}
