"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, CircleAlert, Clock, Info, PauseCircle, Printer, RefreshCw, ScanLine, Volume2, VolumeX, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScanInput, useDialogScanCapture, type ScanInputHandle } from "@/components/scan/scan-input";
import { PrintPanel } from "@/components/print/print-panel";
import { ApiError, apiFetch, isRetryable, NetworkError } from "@/lib/client/api";
import { ScanQueue, type ScanJob } from "@/lib/client/scan-queue";
import { decideGaliaScan, DuplicateEventFilter } from "@/lib/client/scan-guards";
import { claimAutoPrint } from "@/lib/client/auto-print";
import { openLabelPrintDialog } from "@/lib/client/label-print";
import { getWorkstationId } from "@/lib/client/workstation";
import { playAccepted, playRejected, setSoundPreference, soundPreference, unlockAudio } from "@/lib/client/sound";
import { parseScan, type BoxLabel } from "@/lib/barcode";
import { issueLines, isStrictOk, type ControlCounts } from "@/lib/counting";
import { STATUS_LABELS } from "@/lib/labels";
import { formatDateTime, formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { BoxSummary, BoxWorkState, EndTrigger, FinalizeResult, OpenBoxResult, PieceToRemove, ReportSummary, ScanResult } from "@/lib/server/services/boxes";
import type { AutoPrint, PrintJobDto } from "@/lib/server/services/printing";

interface ActiveBox {
  box: BoxSummary;
  leaseToken: string;
  items: BoxWorkState["items"];
  rejections: BoxWorkState["rejections"];
  /** Set when another session took the box over: writes from this page are refused. */
  lost: string | null;
  /** Receive time of the GALIA scan that opened this control (echo guard). */
  openedAt: number;
  openedByScan: boolean;
}

type Tone = "ok" | "nok" | "info" | "warn";
interface Feedback {
  tone: Tone;
  title: string;
  lines: string[];
  at: number;
}

type DecisionInput =
  | { type: "switch"; from: BoxSummary; to: BoxLabel }
  | { type: "takeover"; box: BoxSummary; owner: { username: string; since: string | null; sameUser: boolean } }
  | { type: "correction"; box: BoxSummary; report: ReportSummary; toRemove: PieceToRemove[] };
type Decision = DecisionInput & { resolve: (yes: boolean) => void };

type FinalizeResponse = FinalizeResult & { print: AutoPrint | null };

/** State of the automatic print request of the report just finalized. */
export type AutoPrintView =
  | { phase: "opening"; job: PrintJobDto }
  | { phase: "shown"; job: PrintJobDto }
  | { phase: "unconfirmed"; job: PrintJobDto; reason: string }
  | { phase: "already"; job: PrintJobDto }
  | { phase: "blocked"; code: string; message: string };

const REMOVAL_REASON: Record<PieceToRemove["reason"], string> = {
  EXCESS: "excédent",
  WRONG_PART_NUMBER: "référence différente",
  OTHER_BOX_SERIAL: "série déjà utilisée",
};

const piece = (n: number) => `${n} pièce${n > 1 ? "s" : ""}`;

function withCounts(box: BoxSummary, counts: ControlCounts): BoxSummary {
  return { ...box, counts, acceptedCount: counts.reserved, remaining: Math.max(0, box.expectedQty - counts.reserved) };
}

export function ControlClient({ username, initialInProgress }: { username: string; initialInProgress: BoxSummary[] }) {
  const scanRef = React.useRef<ScanInputHandle>(null);
  const activeRef = React.useRef<ActiveBox | null>(null);
  const [active, setActiveState] = React.useState<ActiveBox | null>(null);
  const [finalized, setFinalized] = React.useState<{ report: ReportSummary; replaces: string | null } | null>(null);
  const [autoPrint, setAutoPrint] = React.useState<AutoPrintView | null>(null);
  const [readOnlyBox, setReadOnlyBox] = React.useState<BoxSummary | null>(null);
  const [feedback, setFeedback] = React.useState<Feedback | null>(null);
  const [decision, setDecision] = React.useState<Decision | null>(null);
  const [removalChecked, setRemovalChecked] = React.useState(false);
  const [finalizeOpen, setFinalizeOpen] = React.useState(false);
  const [finalizing, setFinalizing] = React.useState(false);
  const finishingRef = React.useRef(false);
  const [inProgress, setInProgress] = React.useState(initialInProgress);
  const [sessionExpired, setSessionExpired] = React.useState(false);
  const [sound, setSound] = React.useState(false);
  const soundRef = React.useRef(false);
  const [jobs, setJobs] = React.useState<readonly ScanJob<void>[]>([]);
  const [duplicateFilter] = React.useState(() => new DuplicateEventFilter());
  const recentEndRef = React.useRef<{ payload: string; at: number } | null>(null);

  const setActive = React.useCallback((next: ActiveBox | null | ((prev: ActiveBox | null) => ActiveBox | null)) => {
    const value = typeof next === "function" ? next(activeRef.current) : next;
    activeRef.current = value;
    setActiveState(value);
  }, []);

  const focusScan = React.useCallback(() => {
    window.setTimeout(() => scanRef.current?.focus(), 0);
  }, []);

  const say = React.useCallback((f: Omit<Feedback, "at">) => {
    setFeedback({ ...f, at: Date.now() });
    if (soundRef.current) {
      if (f.tone === "ok") playAccepted();
      else if (f.tone === "nok") playRejected();
    }
  }, []);

  React.useEffect(() => {
    const on = soundPreference();
    soundRef.current = on;
    setSound(on);
  }, []);

  const refreshInProgress = React.useCallback(async () => {
    try {
      const r = await apiFetch<{ boxes: BoxSummary[] }>("/api/boxes/in-progress");
      setInProgress(r.boxes);
    } catch {
      /* keep the previous list */
    }
  }, []);

  /* ---------------------------------------------------------------- scans */

  const ask = React.useCallback((d: DecisionInput) => {
    setRemovalChecked(false);
    return new Promise<boolean>((resolve) => setDecision({ ...d, resolve }));
  }, []);

  const applyScan = React.useCallback(
    (res: ScanResult) => {
      setActive((prev) => {
        if (!prev || prev.box.id !== res.box.id) return prev;
        const box = { ...withCounts(prev.box, res.box.counts), status: res.box.status };
        const items = res.item && !prev.items.some((i) => i.id === res.item!.id) ? [res.item, ...prev.items] : prev.items;
        const rejections = res.accepted
          ? prev.rejections
          : [{ id: res.attemptId, outcome: res.outcome, title: res.title, raw: res.raw, createdAt: res.createdAt, username, message: res.message }, ...prev.rejections.filter((r) => r.id !== res.attemptId)].slice(0, 20);
        const lost = res.outcome === "NOT_BOX_OWNER" || res.outcome === "BOX_NOT_IN_PROGRESS" ? res.message ?? "Contrôle fermé ou réinitialisé. Rescanner la GALIA." : prev.lost;
        return { ...prev, box, items, rejections, lost };
      });
      const c = res.box.counts;
      const tally = `${c.distinct} / ${c.expected} pièces distinctes · ${c.conforming} conforme${c.conforming > 1 ? "s" : ""}`;
      const lines: string[] = [];
      let title = res.title;
      switch (res.outcome) {
        case "ACCEPTED":
          lines.push(`PN ${res.partNumber}`, `Série ${res.serial}`, tally);
          if (c.distinct === c.expected) {
            title = `Quantité cible atteinte : ${c.distinct}/${c.expected}`;
            lines.push("Rescanner la GALIA de cette boîte pour terminer.");
          }
          break;
        case "EXCESS":
          title = `DÉPASSEMENT — ${c.distinct} pièces scannées pour ${c.expected} attendues`;
          lines.push(`Série ${res.serial}`, "Pièce en excédent : la retirer de la boîte. Contrôle NOT OK.");
          break;
        case "WRONG_PART_NUMBER":
          lines.push(`Attendu : ${res.expectedPartNumber}`, `Scanné : ${res.partNumber}`, "Pièce non conforme : la retirer de la boîte.", tally);
          break;
        case "DUPLICATE_SAME_BOX":
          lines.push(`Série ${res.serial}`, "Quantité inchangée — tentative en double enregistrée (contrôle NOT OK).");
          break;
        case "DUPLICATE_OTHER_BOX":
          lines.push(`Série ${res.serial}`);
          if (res.duplicate) lines.push(`Déjà dans la boîte ${res.duplicate.boxSerial} — ${formatDateTime(res.duplicate.acceptedAt)} — ${res.duplicate.acceptedBy}`);
          lines.push("Pièce non conforme pour cette boîte (l'autre boîte la garde).");
          break;
        case "INVALID_FORMAT":
          if (res.message) lines.push(res.message);
          lines.push(`Reçu : ${res.raw}`, "Quantité inchangée — format invalide enregistré (contrôle NOT OK).");
          break;
        default:
          if (res.message) lines.push(res.message);
      }
      if (res.replayed) lines.push("Réponse d'un envoi précédent (même requête) — pas de double comptage.");
      say({ tone: res.accepted ? "ok" : "nok", title, lines });
    },
    [setActive, say, username],
  );

  const openWith = React.useCallback(
    async (body: { raw?: string; boxId?: string; takeover?: boolean; startCorrection?: boolean; removalConfirmed?: boolean; correctionReportId?: string }, openedAt = 0): Promise<void> => {
      const r = await apiFetch<OpenBoxResult>("/api/boxes/open", { body });
      switch (r.kind) {
        case "OPENED": {
          const state = await apiFetch<BoxWorkState>(`/api/boxes/${r.box.id}/state`);
          setActive({ box: state.box, leaseToken: r.leaseToken, items: state.items, rejections: state.rejections, lost: null, openedAt, openedByScan: openedAt > 0 });
          setFinalized(null);
          setAutoPrint(null);
          setReadOnlyBox(null);
          const attempt = state.box.activeAttempt;
          say({
            tone: "info",
            title: r.correctionStarted
              ? `Recontrôle n°${attempt?.number ?? "?"} ouvert depuis zéro`
              : r.created
                ? "Contrôle commencé"
                : r.tookOverFrom
                  ? `Boîte reprise (contrôlée par ${r.tookOverFrom})`
                  : attempt?.kind === "CORRECTION"
                    ? "Correction reprise"
                    : "Contrôle repris",
            lines: [`PN ${state.box.partNumber}`, `Boîte ${state.box.boxSerial} — attendu ${state.box.expectedQty}`, "Scanner les coiffes, puis rescanner cette GALIA pour terminer."],
          });
          void refreshInProgress();
          return;
        }
        case "FINALIZED":
          setReadOnlyBox(r.box);
          say({ tone: "info", title: "Boîte déjà contrôlée OK — consultation seule", lines: [`Boîte ${r.box.boxSerial} : ${STATUS_LABELS[r.box.status]}`] });
          return;
        case "CORRECTION_OFFER":
          // Nothing is released before explicit confirmation of this exact NOT OK report.
          if (await ask({ type: "correction", box: r.box, report: r.report, toRemove: r.toRemove })) {
            return openWith({ boxId: r.box.id, startCorrection: true, correctionReportId: r.report.id, removalConfirmed: r.toRemove.length > 0 });
          }
          say({
            tone: "info",
            title: "Correction annulée",
            lines: [`La boîte ${r.box.boxSerial} reste NOT OK. Aucune coiffe ne peut y être ajoutée.`],
          });
          setReadOnlyBox(r.box);
          return;
        case "OWNED":
          if (r.owner.sameSession) {
            // Same browser session (reload / other tab): resume explicitly, audited as a handover.
            return openWith({ boxId: r.box.id, takeover: true });
          }
          if (await ask({ type: "takeover", box: r.box, owner: r.owner })) return openWith({ boxId: r.box.id, takeover: true });
          say({ tone: "info", title: "Reprise annulée", lines: [`La boîte ${r.box.boxSerial} reste chez ${r.owner.username}.`] });
          return;
        case "CONFLICT":
          say({
            tone: "nok",
            title: "Conflit : boîte déjà connue avec d'autres données",
            lines: [
              `Boîte ${r.existing.boxSerial}`,
              `Enregistrée : ${r.existing.partNumber} — Qté ${r.existing.expectedQty}`,
              `Scannée : ${r.scanned.partNumber} — Qté ${r.scanned.quantity}`,
            ],
          });
          return;
        case "INVALID":
          say({ tone: "nok", title: "Format invalide", lines: [r.error.message, `Reçu : ${r.error.payload}`] });
          return;
      }
    },
    [ask, refreshInProgress, say, setActive],
  );

  /* -------------------------------------------------------------- ending */

  const startAutoPrint = React.useCallback((report: ReportSummary, print: AutoPrint | null) => {
    if (!print) {
      setAutoPrint(null);
      return;
    }
    if (print.status === "BLOCKED") {
      setAutoPrint({ phase: "blocked", code: print.code, message: print.message });
      return;
    }
    const job = print.job;
    // One automatic dialog per finalized attempt, whatever happens next.
    if (!claimAutoPrint(report.id)) {
      setAutoPrint({ phase: "already", job });
      return;
    }
    setAutoPrint({ phase: "opening", job });
    openLabelPrintDialog(job.id, job.widthMm, job.heightMm)
      .then((o) =>
        setAutoPrint(o.likelyShown ? { phase: "shown", job } : { phase: "unconfirmed", job, reason: "La fenêtre d'impression ne semble pas s'être ouverte (bloquée ou impression désactivée)." }),
      )
      .catch((e: unknown) => setAutoPrint({ phase: "unconfirmed", job, reason: e instanceof Error ? e.message : "Fenêtre d'impression non ouverte." }));
  }, []);

  const printNow = React.useCallback(async () => {
    if (autoPrint?.phase !== "unconfirmed") return;
    const job = autoPrint.job;
    setAutoPrint({ phase: "opening", job });
    try {
      const o = await openLabelPrintDialog(job.id, job.widthMm, job.heightMm, { allowRepeat: true });
      setAutoPrint(o.likelyShown ? { phase: "shown", job } : { phase: "unconfirmed", job, reason: "La fenêtre ne semble toujours pas s'ouvrir : vérifier les autorisations d'impression du navigateur." });
    } catch (e) {
      setAutoPrint({ phase: "unconfirmed", job, reason: e instanceof Error ? e.message : "Fenêtre d'impression non ouverte." });
    } finally {
      focusScan();
    }
  }, [autoPrint, focusScan]);

  /**
   * End the open control (GALIA rescan or « Terminer le contrôle »: same server
   * path). Network errors are re-thrown so the scan queue retries the SAME
   * request (same attempt id: a retry after success returns the same report).
   */
  const endControl = React.useCallback(
    async (trigger: EndTrigger, galiaRaw: string | null, receivedAt: number): Promise<void> => {
      const current = activeRef.current;
      const attemptId = current?.box.activeAttempt?.id;
      if (!current || current.lost || !attemptId || finishingRef.current) return;
      finishingRef.current = true;
      setFinalizing(true);
      try {
        const counts = current.box.counts;
        const r = await apiFetch<FinalizeResponse>(`/api/boxes/${current.box.id}/finalize`, {
          body: { leaseToken: current.leaseToken, attemptId, trigger, galiaRaw, observed: { events: counts.events, reserved: counts.reserved }, workstationId: getWorkstationId() },
        });
        if (r.kind === "FINALIZED" || r.kind === "ALREADY_FINALIZED") {
          const report = r.report;
          recentEndRef.current = { payload: current.box.galiaPayload, at: trigger === "GALIA_RESCAN" ? receivedAt : Date.now() };
          setActive(null);
          setFinalizeOpen(false);
          setFinalized({ report, replaces: report.kind === "CORRECTION" ? current.box.previousReport?.reference ?? null : null });
          const what = report.kind === "CORRECTION" ? `Correction n°${report.attemptNumber} terminée` : "Contrôle terminé";
          say({
            tone: report.result === "OK" ? "ok" : "nok",
            title: `${what} : ${report.result === "OK" ? "OK" : "NOT OK"}`,
            lines: [...report.lines, `Boîte ${report.boxSerial} — ${report.counts.distinct} / ${report.expectedQty} — rapport ${report.reference}`],
          });
          void refreshInProgress();
          startAutoPrint(report, r.print);
        } else if (r.kind === "STATE_CHANGED") {
          setActive((prev) => (prev && prev.box.id === current.box.id ? { ...prev, box: withCounts(prev.box, r.counts) } : prev));
          say({ tone: "warn", title: "Contrôle NON terminé : le décompte a changé", lines: ["Le serveur a enregistré un scan que cet écran n'affichait pas encore.", "Vérifier les quantités, puis rescanner la GALIA pour terminer."] });
        } else {
          say({
            tone: "nok",
            title: "GALIA différente — contrôle NON terminé",
            lines: ["Seule la GALIA exacte de cette boîte termine le contrôle.", ...(r.scanned ? [`Scannée : boîte ${r.scanned.boxSerial} — ${r.scanned.partNumber} — Qté ${r.scanned.quantity}`] : [])],
          });
        }
      } catch (e) {
        if (e instanceof NetworkError) throw e;
        if (e instanceof ApiError && e.status === 401) throw e;
        if (e instanceof ApiError && ["NOT_BOX_OWNER", "ATTEMPT_CHANGED", "CONTROL_INVALIDATED"].includes(e.code)) {
          setActive((prev) => (prev ? { ...prev, lost: e.message } : prev));
        }
        say({ tone: "nok", title: "Fin du contrôle refusée", lines: [e instanceof Error ? e.message : "Erreur"] });
      } finally {
        finishingRef.current = false;
        setFinalizing(false);
      }
    },
    [refreshInProgress, say, setActive, startAutoPrint],
  );

  const handleBoxLabel = React.useCallback(
    async (job: ScanJob<void>, label: BoxLabel) => {
      const current = activeRef.current;
      const decisionKind = decideGaliaScan(
        current ? { galiaPayload: current.box.galiaPayload, boxSerial: current.box.boxSerial, openedAt: current.openedAt, openedByScan: current.openedByScan, lost: !!current.lost } : null,
        label,
        job.receivedAt,
        recentEndRef.current,
      );
      switch (decisionKind) {
        case "END":
          return endControl("GALIA_RESCAN", job.raw, job.receivedAt);
        case "ECHO_AFTER_OPEN":
          say({ tone: "info", title: "Lecture répétée de la GALIA ignorée", lines: ["La boîte vient d'être ouverte (moins de 2 s). Rescanner la GALIA pour terminer le contrôle."] });
          return;
        case "ECHO_AFTER_END":
          say({ tone: "info", title: "Lecture répétée de la GALIA ignorée", lines: ["Le contrôle de cette boîte vient de se terminer."] });
          return;
        case "SAME_BOX_OTHER_PAYLOAD":
          say({ tone: "nok", title: "GALIA différente — contrôle NON terminé", lines: ["Même numéro de boîte mais contenu d'étiquette différent.", "Seule la GALIA exacte de la boîte termine le contrôle."] });
          return;
        case "OTHER_BOX": {
          const from = current!;
          const yes = await ask({ type: "switch", from: from.box, to: label });
          if (!yes) {
            say({ tone: "info", title: "Changement de boîte annulé", lines: [`La boîte ${from.box.boxSerial} reste active (contrôle non terminé).`] });
            return;
          }
          try {
            await apiFetch(`/api/boxes/${from.box.id}/suspend`, { body: { leaseToken: from.leaseToken, reason: "switch" } });
          } catch (e) {
            if (!(e instanceof ApiError)) throw e;
          }
          setActive(null);
          return openWith({ raw: job.raw }, job.receivedAt);
        }
        case "OPEN":
          return openWith({ raw: job.raw }, job.receivedAt);
      }
    },
    [ask, endControl, openWith, say, setActive],
  );

  const processRef = React.useRef<(job: ScanJob<void>) => Promise<void>>(async () => undefined);
  processRef.current = async (job) => {
    try {
      const parsed = parseScan(job.raw);
      if (parsed.kind === "BOX") return await handleBoxLabel(job, parsed);
      const current = activeRef.current;
      if (!current) {
        say({
          tone: "nok",
          title: parsed.kind === "ERROR" ? "Format invalide" : "Aucun contrôle ouvert — scan non compté",
          lines: [parsed.kind === "ERROR" ? parsed.message : "Scanner d'abord l'étiquette GALIA de la boîte.", `Reçu : ${job.raw}`],
        });
        return;
      }
      if (current.lost) {
        say({ tone: "nok", title: "Scan non envoyé : boîte contrôlée ailleurs", lines: [current.lost, `Reçu : ${job.raw}`] });
        return;
      }
      const res = await apiFetch<ScanResult>(`/api/boxes/${current.box.id}/scans`, {
        body: { idempotencyKey: job.key, raw: job.raw, leaseToken: current.leaseToken },
      });
      applyScan(res);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setSessionExpired(true);
        queue.pause();
        throw new NetworkError("Session expirée");
      }
      throw e;
    }
  };

  const [queue] = React.useState(
    () =>
      new ScanQueue<void>({
        process: (job) => processRef.current(job),
        isRetryable,
        onChange: () => setJobs(queue.pending),
        onFatal: (job, e) => say({ tone: "nok", title: "Scan refusé", lines: [e instanceof Error ? e.message : "Erreur", `Reçu : ${job.raw}`] }),
      }),
  );

  React.useEffect(() => {
    queue.resume();
    return () => queue.pause();
  }, [queue]);

  React.useEffect(() => {
    let canceled = false;
    let polling = false;
    const poll = async () => {
      const current = activeRef.current;
      if (!current || polling) return;
      polling = true;
      try {
        const state = await apiFetch<BoxWorkState & { leaseValid: boolean }>(`/api/boxes/${current.box.id}/state`, { headers: { "x-box-lease": current.leaseToken } });
        const latest = activeRef.current;
        if (canceled || latest?.leaseToken !== current.leaseToken) return;
        const changed = state.box.generation !== latest.box.generation || !state.leaseValid || state.box.activeAttempt?.id !== latest.box.activeAttempt?.id;
        // Counts only move forward within an attempt: never replace newer scan answers by an older poll.
        const stale = !changed && state.box.counts.events < latest.box.counts.events;
        if (!stale) {
          setActive({
            ...latest,
            box: state.box,
            items: state.items,
            rejections: state.rejections,
            lost: changed ? "Contrôle réinitialisé, fermé ou repris. Rescanner la GALIA. Retirer les anciennes étiquettes." : latest.lost,
          });
        }
        if (changed || state.box.counts.reserved < latest.box.counts.reserved) {
          setFinalizeOpen(false);
          say({ tone: "warn", title: "Contrôle actualisé par le serveur", lines: ["Une modification administrative ou un changement de contrôle a eu lieu. Vérifier les quantités et retirer les anciennes étiquettes."] });
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setSessionExpired(true);
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 3000);
    window.addEventListener("focus", poll);
    return () => {
      canceled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", poll);
    };
  }, [setActive, say]);

  React.useEffect(() => {
    window.dispatchEvent(new CustomEvent("galia:active-box", { detail: active?.box.id ?? null }));
  }, [active?.box.id]);

  React.useEffect(() => {
    const boxId = readOnlyBox?.id ?? finalized?.report.boxId;
    const reportId = readOnlyBox?.latestReport?.id ?? finalized?.report.id;
    if (!boxId || !reportId) return;
    let canceled = false;
    const poll = async () => {
      try {
        const state = await apiFetch<BoxWorkState>(`/api/boxes/${boxId}/state`);
        if (!canceled && (state.box.needsRecontrol || state.box.activeAttempt || state.box.latestReport?.id !== reportId)) {
          setFinalized(null);
          setAutoPrint(null);
          setReadOnlyBox(null);
          say({ tone: "warn", title: "Ancien résultat retiré de la production", lines: ["Contrôle modifié, invalidé ou réinitialisé. Retirer les anciennes étiquettes et rescanner la GALIA."] });
        }
      } catch {
        /* Server checks still refuse stale print requests while offline. */
      }
    };
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [readOnlyBox?.id, readOnlyBox?.latestReport?.id, finalized?.report.boxId, finalized?.report.id, say]);

  React.useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (queue.size > 0 || finishingRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queue]);

  const onScan = React.useCallback(
    (raw: string) => {
      if (soundRef.current) unlockAudio();
      // One physical trigger delivered twice is not a scan (and not a mistake).
      if (!duplicateFilter.accept(raw, Date.now())) {
        setFeedback((f) => (f ? { ...f, lines: [...f.lines.filter((l) => !l.startsWith("Lecture double")), "Lecture double du lecteur ignorée (même code en moins de 0,8 s)."] } : f));
        return;
      }
      queue.enqueue(raw);
    },
    [queue, duplicateFilter],
  );

  const capture = useDialogScanCapture(onScan);

  /* -------------------------------------------------------------- actions */

  async function finishManually() {
    if (!activeRef.current || finishingRef.current) return;
    setFinalizeOpen(false);
    let paused = false;
    try {
      // Ending waits for every scan already received, then holds new ones until the answer.
      await queue.idle();
      if (!queue.isPaused) {
        queue.pause();
        paused = true;
      }
      await endControl("MANUAL", null, Date.now());
    } catch (e) {
      say({
        tone: e instanceof NetworkError ? "warn" : "nok",
        title: e instanceof NetworkError ? "Non confirmé — connexion interrompue" : "Fin du contrôle refusée",
        lines: [e instanceof NetworkError ? "Rien n'est validé tant que le serveur n'a pas répondu. Réessayer « Terminer le contrôle » ou rescanner la GALIA (même demande, pas de doublon)." : e instanceof Error ? e.message : "Erreur"],
      });
    } finally {
      if (paused) queue.resume();
      focusScan();
    }
  }

  async function suspend() {
    const current = activeRef.current;
    if (!current) return;
    try {
      await queue.idle();
      await apiFetch(`/api/boxes/${current.box.id}/suspend`, { body: { leaseToken: current.leaseToken, reason: "manual" } });
      setActive(null);
      say({ tone: "info", title: "Boîte suspendue", lines: [`Boîte ${current.box.boxSerial} : rescanner son étiquette GALIA pour reprendre.`] });
      void refreshInProgress();
    } catch (e) {
      say({ tone: "nok", title: "Suspension impossible", lines: [e instanceof Error ? e.message : "Erreur"] });
    } finally {
      focusScan();
    }
  }

  async function resume(box: BoxSummary) {
    try {
      await openWith({ boxId: box.id });
    } catch (e) {
      say({ tone: e instanceof NetworkError ? "warn" : "nok", title: "Reprise impossible", lines: [e instanceof Error ? e.message : "Erreur"] });
    } finally {
      focusScan();
    }
  }

  function toggleSound() {
    const next = !sound;
    if (next) unlockAudio();
    soundRef.current = next;
    setSound(next);
    setSoundPreference(next);
    focusScan();
  }

  /* ---------------------------------------------------------------- view */

  const unconfirmed = jobs.some((j) => j.status === "unconfirmed");
  const box = active?.box;
  const canFinalize = !!active && !active.lost && jobs.length === 0 && !finalizing && !sessionExpired;
  const predictedOk = !!box && isStrictOk(box.counts);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border-2 border-border bg-card p-4 lg:flex-row lg:items-end">
        <div className="flex-1">
          <ScanInput ref={scanRef} onScan={onScan} disabled={sessionExpired} busyLabel="Session expirée" />
        </div>
        <Button variant="outline" onClick={toggleSound} aria-pressed={sound} className="lg:mb-0">
          {sound ? <Volume2 /> : <VolumeX />} Sons {sound ? "activés" : "désactivés"}
        </Button>
      </div>

      {sessionExpired && (
        <div className="rounded-lg border-4 border-nok bg-nok-soft p-4 text-lg font-bold text-nok" role="alert">
          Session expirée : se reconnecter dans un nouvel onglet, puis cliquer « Réessayer ». {jobs.length} scan(s) en attente NON enregistré(s).
          <div className="mt-2 flex gap-2">
            <Button asChild variant="outline">
              <Link href="/login" target="_blank">
                Se reconnecter
              </Link>
            </Button>
            <Button
              onClick={() => {
                setSessionExpired(false);
                queue.resume();
                queue.retryNow();
              }}
            >
              <RefreshCw /> Réessayer
            </Button>
          </div>
        </div>
      )}

      {unconfirmed && !sessionExpired && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border-4 border-warn bg-warn-soft p-4 text-lg font-bold text-black" role="alert">
          <CircleAlert className="size-7" /> Non confirmé — connexion interrompue. Nouvel essai automatique avec la même requête.
          <Button variant="outline" onClick={() => queue.retryNow()}>
            <RefreshCw /> Réessayer maintenant
          </Button>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="flex flex-col gap-4 xl:col-span-2">
          {active && box ? (
            <Card className={cn(active.lost && "border-nok", box.activeAttempt?.kind === "CORRECTION" && "border-warn")}>
              <CardContent className="flex flex-col gap-4 pt-4">
                {box.needsRecontrol && (
                  <p className="rounded-md border-2 border-warn bg-warn-soft p-3 font-bold">
                    À recontrôler — génération {box.generation}. Retirer les anciennes étiquettes de la boîte. Aucune étiquette de résultat avant une nouvelle fin de contrôle.
                  </p>
                )}
                {box.activeAttempt?.kind === "CORRECTION" && (
                  <div className="flex flex-col gap-1 rounded-md border-2 border-warn bg-warn-soft p-3 text-black" data-testid="correction-banner">
                    <span className="text-xl font-black">Recontrôle complet depuis zéro (n°{box.activeAttempt.number})</span>
                    {box.previousReport && (
                      <span className="self-start rounded bg-nok px-2 py-1 font-bold text-white" data-testid="previous-result">
                        Contrôle précédent : NOT OK — {box.previousReport.lines.join(" · ")} — {box.previousReport.reference}
                      </span>
                    )}
                    <span className="text-sm">
                      Toutes les anciennes affectations ont été libérées. Rescanner chaque coiffe pour ce nouveau contrôle.
                      Une coiffe ne compte qu&apos;une fois ; une série déjà affectée à une autre boîte est refusée.
                    </span>
                  </div>
                )}
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold uppercase text-muted-foreground">Référence (PN)</div>
                    <div className="break-all font-mono text-3xl font-bold" data-testid="box-pn">
                      {box.partNumber}
                    </div>
                    <div className="mt-1 text-lg">
                      Boîte{" "}
                      <span className="font-mono font-bold" data-testid="box-serial">
                        {box.boxSerial}
                      </span>{" "}
                      · Attendu <b className="tabular">{box.expectedQty}</b>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Ouverte par <span className="font-mono">{box.createdBy}</span> le {formatDateTime(box.createdAt)} · Opérateur actif{" "}
                      <span className="font-mono font-bold">{username}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold uppercase text-muted-foreground">Pièces distinctes scannées</div>
                    <div className={cn("tabular font-mono text-7xl font-black leading-none", box.counts.distinct > box.expectedQty && "text-nok")} data-testid="box-counter">
                      {box.counts.distinct} / {box.expectedQty}
                    </div>
                  </div>
                </div>
                <Counters counts={box.counts} />
                <div className="h-5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={box.expectedQty} aria-valuenow={box.counts.distinct}>
                  <div
                    className={cn("h-full transition-all", box.counts.distinct > box.expectedQty ? "bg-nok" : box.counts.distinct === box.expectedQty ? "bg-ok" : "bg-primary")}
                    style={{ width: `${Math.min(100, (box.counts.distinct / box.expectedQty) * 100)}%` }}
                  />
                </div>
                {!active.lost && <StatusBanner counts={box.counts} />}
                {active.lost && (
                  <div className="flex flex-wrap items-center gap-3 rounded-md bg-nok-soft p-3 text-lg font-bold text-nok" role="alert">
                    {active.lost}
                    <Button variant="outline" onClick={() => void resume(box)}>
                      Reprendre le contrôle
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <Button size="lg" variant="outline" className="min-w-64" disabled={!canFinalize} onClick={() => setFinalizeOpen(true)} data-testid="finalize">
                    <CheckCircle2 /> Terminer le contrôle
                  </Button>
                  <Button size="lg" variant="ghost" onClick={() => void suspend()} disabled={jobs.length > 0 || !!active.lost || finalizing}>
                    <PauseCircle /> Suspendre
                  </Button>
                  {(jobs.length > 0 || finalizing) && <span className="font-semibold text-muted-foreground">{finalizing ? "Fin du contrôle en cours…" : "Attente des scans en cours…"}</span>}
                </div>
              </CardContent>
            </Card>
          ) : finalized ? (
            <ResultCard
              report={finalized.report}
              replaces={finalized.replaces}
              autoPrint={autoPrint}
              onPrintNow={() => void printNow()}
              onNext={() => {
                setFinalized(null);
                setAutoPrint(null);
                focusScan();
              }}
              onSettled={focusScan}
            />
          ) : (
            <Card>
              <CardContent className="flex flex-col gap-4 pt-4">
                <p className="flex items-center gap-3 text-2xl font-bold">
                  <ScanLine className="size-8" /> Scanner l&apos;étiquette GALIA de la boîte pour commencer.
                </p>
                <p className="text-muted-foreground">Scanner ensuite chaque coiffe, puis rescanner la même GALIA pour terminer le contrôle et imprimer l&apos;étiquette.</p>
                {inProgress.length > 0 && (
                  <div>
                    <h2 className="mb-2 text-lg font-bold">Boîtes en cours</h2>
                    <ul className="divide-y divide-border rounded-md border-2 border-border">
                      {inProgress.map((b) => (
                        <li key={b.id} className="flex flex-wrap items-center gap-3 p-2">
                          <span className="font-mono font-bold">{b.boxSerial}</span>
                          <span className="font-mono">{b.partNumber}</span>
                          <span className="tabular font-bold">
                            {b.counts.distinct} / {b.expectedQty}
                          </span>
                          {b.activeAttempt?.kind === "CORRECTION" && <Badge tone="warn">Correction n°{b.activeAttempt.number}</Badge>}
                          <span className="text-sm text-muted-foreground">{b.owner ? `Contrôlée par ${b.owner.username}` : "Suspendue"}</span>
                          <Button size="sm" variant="outline" className="ml-auto" onClick={() => void resume(b)}>
                            Reprendre
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <LastResult feedback={feedback} />
        </div>

        <div className="flex flex-col gap-4">
          {jobs.length > 0 && (
            <Card className="border-primary">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="size-5" /> En attente de confirmation ({jobs.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="flex flex-col gap-1">
                  {jobs.map((j) => (
                    <li key={j.key} className="flex items-center gap-2 font-mono text-sm">
                      <Badge tone={j.status === "unconfirmed" ? "warn" : "neutral"}>{j.status === "unconfirmed" ? "Non confirmé" : j.status === "sending" ? "Envoi…" : "En file"}</Badge>
                      <span className="break-all">{j.raw}</span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}

          {active && (
            <Card>
              <CardHeader>
                <CardTitle>Pièces conformes comptées ({active.items.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="max-h-96 overflow-y-auto font-mono text-sm" data-testid="accepted-list">
                  {active.items.map((i, idx) => (
                    <li key={i.id} className="flex justify-between gap-2 border-b border-border py-1">
                      <span>
                        <span className="text-muted-foreground">{active.items.length - idx}.</span> {i.serial}
                        {i.attemptNumber > 1 && (
                          <span className="ml-2 rounded bg-warn px-1 text-xs font-bold text-black" title={`Ajoutée en correction n°${i.attemptNumber}`}>
                            C{i.attemptNumber}
                          </span>
                        )}
                      </span>
                      <span className="text-muted-foreground">{formatTime(i.acceptedAt)}</span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}

          {active && active.rejections.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Écarts enregistrés dans ce contrôle</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-1 text-sm" data-testid="observations-list">
                  {active.rejections.map((r) => (
                    <li key={r.id} className="border-b border-border py-1">
                      <span className="font-semibold text-nok">{r.title}</span> <span className="text-muted-foreground">{formatTime(r.createdAt)}</span>
                      <div className="break-all font-mono text-xs">{r.raw}</div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Box switch / takeover / correction decision: scanner keystrokes are queued, never treated as a button press. */}
      <Dialog
        open={decision !== null}
        onOpenChange={(open) => {
          if (!open && decision) {
            decision.resolve(false);
            setDecision(null);
          }
        }}
      >
        {decision && (
          <DialogContent
            hideClose
            tabIndex={-1}
            onKeyDown={capture.onKeyDown}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              capture.reset();
              (e.currentTarget as HTMLElement | null)?.focus();
            }}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              focusScan();
            }}
          >
            {decision.type === "correction" ? (
              <DialogHeader>
                <DialogTitle>Boîte {decision.box.boxSerial} déjà contrôlée NOT OK</DialogTitle>
                <DialogDescription asChild>
                  <div className="text-lg text-foreground" data-testid="correction-question">
                    <p>Cette boîte a déjà été contrôlée NOT OK.</p>
                    <p>
                      Quantité attendue : <b className="tabular">{decision.report.expectedQty}</b>.
                    </p>
                    <p>
                      Quantité conforme comptée : <b className="tabular">{decision.report.counts.reserved}</b>.
                    </p>
                    <ul className="mt-1 list-disc pl-6 font-semibold text-nok" data-testid="previous-issues">
                      {decision.report.lines.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                    {decision.toRemove.length > 0 && (
                      <div className="mt-2 rounded-md border-2 border-nok bg-nok-soft p-2 text-base" data-testid="pieces-to-remove">
                        <p className="font-bold">Retirer d&apos;abord ces pièces de la boîte :</p>
                        <ul className="font-mono">
                          {decision.toRemove.map((p) => (
                            <li key={p.serial}>
                              {p.serial} — {REMOVAL_REASON[p.reason]}
                              {p.partNumber && p.reason === "WRONG_PART_NUMBER" ? ` (${p.partNumber})` : ""}
                            </li>
                          ))}
                        </ul>
                        <label className="mt-2 flex items-start gap-2 font-semibold">
                          <input type="checkbox" className="mt-1 size-5" checked={removalChecked} onChange={(e) => setRemovalChecked(e.target.checked)} data-testid="removal-confirm" />
                          J&apos;ai retiré ces {piece(decision.toRemove.length)} de la boîte.
                        </label>
                      </div>
                    )}
                    <p className="mt-2 font-bold">Voulez-vous recommencer le contrôle depuis ZÉRO ?</p>
                    <p className="mt-2 rounded border-2 border-warn bg-warn-soft p-2 font-semibold">
                      OUI libère les {decision.box.acceptedCount} coiffes de ce contrôle et remet le compteur à 0 / {decision.box.expectedQty}.
                      Il faut rescanner chaque coiffe. Ces séries pourront aussi être utilisées dans une autre boîte ; une série déjà réaffectée sera refusée.
                      Les scans et rapports précédents restent dans l&apos;historique. Retirer les anciennes étiquettes de résultat de la boîte.
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Rapport {decision.report.reference} — {decision.report.finalizedBy}, {formatDateTime(decision.report.finalizedAt)}
                      {decision.report.reason ? ` — ${decision.report.reason}` : ""}
                    </p>
                  </div>
                </DialogDescription>
              </DialogHeader>
            ) : decision.type === "switch" ? (
              <DialogHeader>
                <DialogTitle>Autre boîte scannée</DialogTitle>
                <DialogDescription>
                  Boîte active : <b className="font-mono">{decision.from.boxSerial}</b> ({decision.from.counts.distinct} / {decision.from.expectedQty}) — son contrôle n&apos;est{" "}
                  <b>pas terminé</b>.
                  <br />
                  Nouvelle étiquette : <b className="font-mono">{decision.to.boxSerial}</b> — {decision.to.partNumber} — Qté {decision.to.quantity}.
                  <br />
                  Suspendre la boîte active (sans la terminer) et ouvrir la nouvelle ?
                </DialogDescription>
              </DialogHeader>
            ) : (
              <DialogHeader>
                <DialogTitle>Boîte contrôlée par {decision.owner.username}</DialogTitle>
                <DialogDescription>
                  Boîte <b className="font-mono">{decision.box.boxSerial}</b> ({decision.box.counts.distinct} / {decision.box.expectedQty}) en cours
                  {decision.owner.since ? ` depuis ${formatTime(decision.owner.since)}` : ""}. Reprendre le contrôle ? L&apos;autre poste ne pourra plus scanner dans cette
                  boîte (reprise enregistrée).
                </DialogDescription>
              </DialogHeader>
            )}
            {capture.captured > 0 && (
              <p className="rounded-md bg-warn-soft p-2 font-semibold text-black">{capture.captured} scan(s) reçus pendant la question : mis en attente, traités ensuite.</p>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                size="lg"
                onClick={() => {
                  decision.resolve(false);
                  setDecision(null);
                }}
              >
                {decision.type === "correction" ? "NON — Annuler" : "Annuler"}
              </Button>
              <Button
                size="lg"
                disabled={decision.type === "correction" && decision.toRemove.length > 0 && !removalChecked}
                onClick={() => {
                  decision.resolve(true);
                  setDecision(null);
                }}
              >
                {decision.type === "correction" ? "OUI — Recommencer à zéro" : decision.type === "switch" ? "Suspendre et ouvrir" : "Reprendre le contrôle"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      {/* Manual end: same server path as the GALIA rescan. */}
      <Dialog open={finalizeOpen} onOpenChange={setFinalizeOpen}>
        <DialogContent
          tabIndex={-1}
          onKeyDown={capture.onKeyDown}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            capture.reset();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusScan();
          }}
        >
          {box && (
            <>
              <DialogHeader>
                <DialogTitle>Terminer le contrôle de la boîte {box.boxSerial} ?</DialogTitle>
                <DialogDescription asChild>
                  <div className="text-foreground">
                    <p>
                      {box.counts.distinct} / {box.expectedQty} pièces distinctes · {box.counts.conforming} conforme{box.counts.conforming > 1 ? "s" : ""} · {box.counts.nonconforming} non
                      conforme{box.counts.nonconforming > 1 ? "s" : ""}.
                    </p>
                    <p className={cn("mt-2 rounded-md p-3 text-xl font-black", predictedOk ? "bg-ok text-white" : "bg-nok text-white")} data-testid="finalize-prediction">
                      Résultat : {predictedOk ? "OK" : "NOT OK"}
                    </p>
                    <ul className="mt-1 list-disc pl-6 font-semibold">
                      {issueLines(box.counts).map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Le résultat est recalculé par le serveur. Après la fin : rapport enregistré, fenêtre d&apos;impression de l&apos;étiquette demandée une fois.
                    </p>
                  </div>
                </DialogDescription>
              </DialogHeader>
              {capture.captured > 0 && <p className="rounded-md bg-warn-soft p-2 font-semibold text-black">{capture.captured} scan(s) reçus : traités avant la fin du contrôle.</p>}
              <DialogFooter>
                <Button variant="outline" size="lg" onClick={() => setFinalizeOpen(false)}>
                  Annuler
                </Button>
                <Button size="lg" variant={predictedOk ? "success" : "destructive"} disabled={finalizing} onClick={() => void finishManually()} data-testid="finalize-confirm">
                  Terminer — {predictedOk ? "OK" : "NOT OK"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Read-only view of an already finalized box. */}
      <Dialog open={readOnlyBox !== null} onOpenChange={(o) => !o && setReadOnlyBox(null)}>
        <DialogContent
          tabIndex={-1}
          onKeyDown={capture.onKeyDown}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusScan();
          }}
        >
          {readOnlyBox && (
            <>
              <DialogHeader>
                <DialogTitle>Boîte {readOnlyBox.boxSerial} déjà finalisée</DialogTitle>
                <DialogDescription>Consultation seule : aucune nouvelle vérification possible.</DialogDescription>
              </DialogHeader>
              <div className={cn("rounded-md p-4 text-center text-4xl font-black", readOnlyBox.status === "OK" ? "bg-ok text-white" : "bg-nok text-white")}>
                {readOnlyBox.status === "OK" ? "✔ OK" : "✖ NOT OK"}
              </div>
              <p className="text-lg">
                {readOnlyBox.partNumber} — {readOnlyBox.counts.distinct} / {readOnlyBox.expectedQty} — {readOnlyBox.latestReport?.reference}
              </p>
              {readOnlyBox.latestReport && <p className="font-semibold">{readOnlyBox.latestReport.lines.join(" · ")}</p>}
              {readOnlyBox.latestReport && <PrintPanel reportId={readOnlyBox.latestReport.id} onSettled={focusScan} />}
              <DialogFooter>
                <Button asChild variant="outline">
                  <Link href={`/rapport/${readOnlyBox.latestReport?.id ?? ""}`}>Rapport courant</Link>
                </Button>
                <Button onClick={() => setReadOnlyBox(null)}>Fermer</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The few numbers that matter, adding up: conforming + nonconforming = distinct. */
function Counters({ counts }: { counts: ControlCounts }) {
  const issues: [string, string, number][] = [
    ["missing", "Manquant", counts.missing],
    ["extra", "Excédent", Math.max(counts.extra, counts.excess)],
    ["duplicates", "Scans en double", counts.duplicates],
    ["invalid", "Formats invalides", counts.invalid],
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md border-2 border-ok bg-ok-soft p-2">
          <div className="text-sm font-semibold uppercase">Quantité conforme</div>
          <div className="tabular font-mono text-4xl font-black text-ok" data-testid="conforming-count">
            {counts.conforming}
          </div>
        </div>
        <div className={cn("rounded-md border-2 p-2", counts.nonconforming > 0 ? "border-nok bg-nok-soft" : "border-border")}>
          <div className="text-sm font-semibold uppercase">Non conformes</div>
          <div className={cn("tabular font-mono text-4xl font-black", counts.nonconforming > 0 && "text-nok")} data-testid="nonconforming-count">
            {counts.nonconforming}
          </div>
        </div>
      </div>
      {issues.some(([, , n]) => n > 0) && (
        <div className="flex flex-wrap gap-2" data-testid="issue-chips">
          {issues
            .filter(([, , n]) => n > 0)
            .map(([key, label, n]) => (
              <span key={key} className="rounded-md bg-nok px-2 py-1 font-bold text-white" data-testid={`issue-${key}`}>
                {label} : {n}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

function StatusBanner({ counts }: { counts: ControlCounts }) {
  if (counts.distinct > counts.expected) {
    return (
      <div className="rounded-md border-4 border-nok bg-nok p-3 text-white" role="alert" data-testid="overflow-banner">
        <div className="text-2xl font-black">
          DÉPASSEMENT — {counts.distinct} pièces scannées pour {counts.expected} attendues
        </div>
        <div className="font-semibold">Contrôle NOT OK si terminé ainsi. Rescanner la GALIA de cette boîte pour terminer.</div>
      </div>
    );
  }
  const ok = isStrictOk(counts);
  if (counts.distinct === counts.expected) {
    return (
      <div className={cn("rounded-md border-4 p-3", ok ? "border-ok bg-ok-soft text-ok" : "border-warn bg-warn-soft text-black")} data-testid="target-banner">
        <div className="text-2xl font-black">
          Quantité cible atteinte : {counts.distinct}/{counts.expected}
        </div>
        <div className="text-lg font-bold">Rescanner la GALIA de cette boîte pour terminer</div>
        {!ok && <div className="font-semibold">Résultat si terminé : NOT OK — {issueLines(counts).join(" · ")}</div>}
      </div>
    );
  }
  return (
    <div className="rounded-md border-2 border-border bg-muted p-3 font-semibold" data-testid="progress-hint">
      Reste {counts.expected - counts.distinct} pièce{counts.expected - counts.distinct > 1 ? "s" : ""} à scanner. Pour terminer à tout moment : rescanner la GALIA de la boîte
      {issueLines(counts).length > 0 && !ok ? ` (résultat NOT OK — ${issueLines(counts).join(" · ")})` : ""}.
    </div>
  );
}

function LastResult({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) {
    return (
      <div className="rounded-lg border-2 border-dashed border-border p-6 text-center text-xl text-muted-foreground">Dernier résultat : aucun scan pour l&apos;instant.</div>
    );
  }
  const styles: Record<Tone, string> = {
    ok: "border-ok bg-ok text-white",
    nok: "border-nok bg-nok text-white",
    info: "border-primary bg-card text-foreground",
    warn: "border-warn bg-warn-soft text-black",
  };
  const Icon = feedback.tone === "ok" ? CheckCircle2 : feedback.tone === "nok" ? XCircle : feedback.tone === "warn" ? CircleAlert : Info;
  return (
    <div key={feedback.at} className={cn("rounded-lg border-4 p-5", styles[feedback.tone])} role="status" aria-live="assertive" data-testid="last-result" data-tone={feedback.tone}>
      <div className="flex items-center gap-3 text-4xl font-black">
        <Icon className="size-12 shrink-0" aria-hidden /> {feedback.title}
      </div>
      <div className="mt-2 flex flex-col gap-0.5 break-all font-mono text-xl">
        {feedback.lines.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
      <div className="mt-1 text-sm opacity-80">{formatTime(feedback.at)}</div>
    </div>
  );
}

function AutoPrintStatus({ state, onPrintNow }: { state: AutoPrintView | null; onPrintNow: () => void }) {
  if (!state) return null;
  if (state.phase === "opening") {
    return (
      <p className="rounded-md border-2 border-border bg-muted p-3 font-semibold" data-testid="auto-print-status" data-phase="opening">
        Préparation de la fenêtre d&apos;impression…
      </p>
    );
  }
  if (state.phase === "unconfirmed") {
    return (
      <div className="flex flex-col gap-2 rounded-md border-4 border-nok bg-nok-soft p-3 text-nok" role="alert" data-testid="auto-print-status" data-phase="unconfirmed">
        <p className="text-lg font-black">Étiquette prête — fenêtre d&apos;impression non ouverte</p>
        <p className="font-semibold">{state.reason} Le rapport est enregistré et reste valable.</p>
        <Button size="lg" className="self-start text-lg" onClick={onPrintNow} data-testid="print-now">
          <Printer /> Imprimer maintenant
        </Button>
        <p className="text-sm">Si l&apos;étiquette est déjà sortie, ne pas réimprimer.</p>
      </div>
    );
  }
  if (state.phase === "blocked") {
    return (
      <div className="rounded-md border-4 border-warn bg-warn-soft p-3 font-semibold text-black" role="alert" data-testid="auto-print-status" data-phase="blocked">
        Étiquette non préparée : {state.message} Le rapport est enregistré.{" "}
        {["LABEL_NOT_CONFIGURED", "LABEL_NOT_CONFIRMED"].includes(state.code) && (
          <Link className="underline" href="/imprimante">
            Régler l&apos;étiquette de ce poste
          </Link>
        )}
      </div>
    );
  }
  return (
    <p className="rounded-md border-2 border-border bg-muted p-3 font-semibold" data-testid="auto-print-status" data-phase={state.phase}>
      {state.phase === "shown"
        ? "Fenêtre d'impression demandée : choisir la ZD421 de ce poste et imprimer. Vérifier que l'étiquette est sortie (le logiciel ne peut pas le confirmer)."
        : "Étiquette déjà demandée pour ce rapport : pas de nouvelle fenêtre automatique. Utiliser « Réimprimer… » si nécessaire."}
    </p>
  );
}

function ResultCard({
  report,
  replaces,
  autoPrint,
  onPrintNow,
  onNext,
  onSettled,
}: {
  report: ReportSummary;
  replaces: string | null;
  autoPrint: AutoPrintView | null;
  onPrintNow: () => void;
  onNext: () => void;
  onSettled: () => void;
}) {
  const ok = report.result === "OK";
  const c = report.counts;
  return (
    <Card className={cn("border-4", ok ? "border-ok" : "border-nok")}>
      <CardContent className="flex flex-col gap-4 pt-4">
        <div className={cn("rounded-md p-6 text-center text-6xl font-black", ok ? "bg-ok text-white" : "bg-nok text-white")} data-testid="final-result">
          {ok ? "✔ OK" : "✖ NOT OK"}
          {report.kind === "CORRECTION" && <div className="mt-1 text-xl font-bold">Correction n°{report.attemptNumber}</div>}
        </div>
        <ul className={cn("text-xl font-bold", ok ? "text-ok" : "text-nok")} data-testid="final-lines">
          {report.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="final-figures">
          <Figure label="Attendu" value={c.expected} />
          <Figure label="Pièces distinctes scannées" value={c.distinct} />
          <Figure label="Quantité conforme" value={c.conforming} />
          <Figure label="Non conformes" value={c.nonconforming} />
        </div>
        <div className="grid gap-1 text-lg sm:grid-cols-2">
          <div>
            Boîte <b className="font-mono">{report.boxSerial}</b>
          </div>
          <div>
            PN <b className="font-mono">{report.partNumber}</b>
          </div>
          <div>
            Rapport <b className="font-mono">{report.reference}</b>
          </div>
          <div>
            Terminé par <b className="font-mono">{report.finalizedBy}</b> le {formatDateTime(report.finalizedAt)}
            {report.endTrigger === "GALIA_RESCAN" ? " (GALIA rescannée)" : report.endTrigger === "MANUAL" ? " (bouton Terminer)" : ""}
          </div>
        </div>
        <AutoPrintStatus state={autoPrint} onPrintNow={onPrintNow} />
        <PrintPanel reportId={report.id} replacesReference={replaces} onSettled={onSettled} />
        <Button size="lg" variant="outline" onClick={onNext}>
          Boîte suivante
        </Button>
      </CardContent>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border-2 border-border p-2">
      <div className="text-xs font-semibold uppercase text-muted-foreground">{label}</div>
      <div className="tabular font-mono text-3xl font-black">{value}</div>
    </div>
  );
}
