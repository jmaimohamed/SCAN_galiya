"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, CircleAlert, Clock, Info, PauseCircle, RefreshCw, Volume2, VolumeX, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label, Textarea } from "@/components/ui/input";
import { ScanInput, useDialogScanCapture, type ScanInputHandle } from "@/components/scan/scan-input";
import { PrintPanel } from "@/components/print/print-panel";
import { ApiError, apiFetch, isRetryable, NetworkError } from "@/lib/client/api";
import { ScanQueue, type ScanJob } from "@/lib/client/scan-queue";
import { playAccepted, playRejected, setSoundPreference, soundPreference, unlockAudio } from "@/lib/client/sound";
import { parseScan, type BoxLabel } from "@/lib/barcode";
import { ISSUE_LABELS, STATUS_LABELS } from "@/lib/labels";
import { formatDateTime, formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { BoxSummary, BoxWorkState, FinalizeResult, OpenBoxResult, ReportSummary, ScanResult } from "@/lib/server/services/boxes";

interface ActiveBox {
  box: BoxSummary;
  leaseToken: string;
  items: BoxWorkState["items"];
  rejections: BoxWorkState["rejections"];
  /** Set when another session took the box over: writes from this page are refused. */
  lost: string | null;
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
  | { type: "correction"; box: BoxSummary; report: ReportSummary };
type Decision = DecisionInput & { resolve: (yes: boolean) => void };

export function ControlClient({ username, initialInProgress }: { username: string; initialInProgress: BoxSummary[] }) {
  const scanRef = React.useRef<ScanInputHandle>(null);
  const activeRef = React.useRef<ActiveBox | null>(null);
  const [active, setActiveState] = React.useState<ActiveBox | null>(null);
  const [finalized, setFinalized] = React.useState<{ report: ReportSummary; replaces: string | null } | null>(null);
  const [readOnlyBox, setReadOnlyBox] = React.useState<BoxSummary | null>(null);
  const [feedback, setFeedback] = React.useState<Feedback | null>(null);
  const [decision, setDecision] = React.useState<Decision | null>(null);
  const [finalizeOpen, setFinalizeOpen] = React.useState(false);
  const [finalizing, setFinalizing] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [inProgress, setInProgress] = React.useState(initialInProgress);
  const [sessionExpired, setSessionExpired] = React.useState(false);
  const [sound, setSound] = React.useState(false);
  const soundRef = React.useRef(false);
  const [jobs, setJobs] = React.useState<readonly ScanJob<void>[]>([]);

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

  const ask = React.useCallback((d: DecisionInput) => new Promise<boolean>((resolve) => setDecision({ ...d, resolve })), []);

  const applyScan = React.useCallback(
    (res: ScanResult) => {
      setActive((prev) => {
        if (!prev || prev.box.id !== res.box.id) return prev;
        const box = { ...prev.box, acceptedCount: res.box.acceptedCount, remaining: res.box.remaining, status: res.box.status };
        const items = res.item && !prev.items.some((i) => i.id === res.item!.id) ? [res.item, ...prev.items] : prev.items;
        const rejections = res.accepted
          ? prev.rejections
          : [{ id: res.attemptId, outcome: res.outcome, title: res.title, raw: res.raw, createdAt: res.createdAt, username, message: res.message }, ...prev.rejections.filter((r) => r.id !== res.attemptId)].slice(0, 10);
        const lost = res.outcome === "NOT_BOX_OWNER" || res.outcome === "BOX_NOT_IN_PROGRESS" ? res.message ?? "Contrôle fermé ou réinitialisé. Rescanner la GALIA." : prev.lost;
        return { ...prev, box, items, rejections, lost };
      });
      const lines: string[] = [];
      switch (res.outcome) {
        case "ACCEPTED":
          lines.push(`PN ${res.partNumber}`, `Série ${res.serial}`);
          break;
        case "WRONG_PART_NUMBER":
          lines.push(`Attendu : ${res.expectedPartNumber}`, `Scanné : ${res.partNumber}`);
          break;
        case "DUPLICATE_SAME_BOX":
          lines.push(`Série ${res.serial}`);
          break;
        case "DUPLICATE_OTHER_BOX":
          lines.push(`Série ${res.serial}`);
          if (res.duplicate) lines.push(`Boîte ${res.duplicate.boxSerial} — ${formatDateTime(res.duplicate.acceptedAt)} — ${res.duplicate.acceptedBy}`);
          break;
        case "INVALID_FORMAT":
          if (res.message) lines.push(res.message);
          lines.push(`Reçu : ${res.raw}`);
          break;
        case "QUANTITY_REACHED":
          lines.push(`${res.box.acceptedCount} / ${res.box.expectedQty} : terminer le contrôle.`);
          break;
        default:
          if (res.message) lines.push(res.message);
      }
      if (res.replayed) lines.push("Réponse d'un envoi précédent (même requête) — pas de double comptage.");
      say({ tone: res.accepted ? "ok" : "nok", title: res.title, lines });
    },
    [setActive, say, username],
  );

  const openWith = React.useCallback(
    async (body: { raw?: string; boxId?: string; takeover?: boolean; startCorrection?: boolean }): Promise<void> => {
      const r = await apiFetch<OpenBoxResult>("/api/boxes/open", { body });
      switch (r.kind) {
        case "OPENED": {
          const state = await apiFetch<BoxWorkState>(`/api/boxes/${r.box.id}/state`);
          setActive({ box: state.box, leaseToken: r.leaseToken, items: state.items, rejections: state.rejections, lost: null });
          setFinalized(null);
          setReadOnlyBox(null);
          const attempt = state.box.activeAttempt;
          say({
            tone: "info",
            title: r.correctionStarted
              ? `Correction n°${attempt?.number ?? "?"} ouverte`
              : r.created
                ? "Nouvelle boîte ouverte"
                : r.tookOverFrom
                  ? `Boîte reprise (contrôlée par ${r.tookOverFrom})`
                  : attempt?.kind === "CORRECTION"
                    ? "Correction reprise"
                    : "Boîte reprise",
            lines: [`PN ${state.box.partNumber}`, `Boîte ${state.box.boxSerial} — ${state.box.acceptedCount} / ${state.box.expectedQty}`],
          });
          void refreshInProgress();
          return;
        }
        case "FINALIZED":
          setReadOnlyBox(r.box);
          say({ tone: "info", title: "Boîte déjà contrôlée OK — consultation seule", lines: [`Boîte ${r.box.boxSerial} : ${STATUS_LABELS[r.box.status]}`] });
          return;
        case "CORRECTION_OFFER":
          // Nothing is reopened before an explicit "OUI — Corriger".
          if (await ask({ type: "correction", box: r.box, report: r.report })) return openWith({ boxId: r.box.id, startCorrection: true });
          say({
            tone: "info",
            title: "Correction annulée",
            lines: [`La boîte ${r.box.boxSerial} reste NOT OK (${r.report.acceptedQty} / ${r.report.expectedQty}). Aucune coiffe ne peut y être ajoutée.`],
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

  const handleBoxLabel = React.useCallback(
    async (job: ScanJob<void>, label: BoxLabel) => {
      const current = activeRef.current;
      if (current && current.box.boxSerial === label.boxSerial && !current.lost) {
        say({ tone: "info", title: "Cette boîte est déjà en cours", lines: [`Boîte ${label.boxSerial}`] });
        return;
      }
      if (current && !current.lost) {
        const yes = await ask({ type: "switch", from: current.box, to: label });
        if (!yes) {
          say({ tone: "info", title: "Changement de boîte annulé", lines: [`La boîte ${current.box.boxSerial} reste active.`] });
          return;
        }
        try {
          await apiFetch(`/api/boxes/${current.box.id}/suspend`, { body: { leaseToken: current.leaseToken, reason: "switch" } });
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
        }
        setActive(null);
      }
      await openWith({ raw: job.raw });
    },
    [ask, openWith, say, setActive],
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
          title: parsed.kind === "ERROR" ? "Format invalide" : "Aucune boîte active",
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
        if (canceled || activeRef.current?.leaseToken !== current.leaseToken) return;
        const changed = state.box.generation !== current.box.generation || !state.leaseValid;
        setActive({ ...current, box: state.box, items: state.items, rejections: state.rejections, lost: changed ? "Contrôle réinitialisé, fermé ou repris. Rescanner la GALIA. Retirer les anciennes étiquettes." : current.lost });
        if (changed || state.box.acceptedCount < current.box.acceptedCount) {
          setFinalizeOpen(false);
          say({ tone: "warn", title: "Contrôle actualisé par le serveur", lines: ["Une modification administrative ou un changement de contrôle a eu lieu. Vérifier les quantités et retirer les anciennes étiquettes."] });
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setSessionExpired(true);
      } finally { polling = false; }
    };
    const timer = window.setInterval(() => void poll(), 3000);
    window.addEventListener("focus", poll);
    return () => { canceled = true; window.clearInterval(timer); window.removeEventListener("focus", poll); };
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
          setFinalized(null); setReadOnlyBox(null);
          say({ tone: "warn", title: "Ancien résultat retiré de la production", lines: ["Contrôle modifié, invalidé ou réinitialisé. Retirer les anciennes étiquettes et rescanner la GALIA."] });
        }
      } catch { /* Server checks still refuse stale print requests while offline. */ }
    };
    const timer = window.setInterval(() => void poll(), 3000);
    return () => { canceled = true; window.clearInterval(timer); };
  }, [readOnlyBox?.id, readOnlyBox?.latestReport?.id, finalized?.report.boxId, finalized?.report.id, say]);

  React.useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (queue.size > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queue]);

  const onScan = React.useCallback(
    (raw: string) => {
      if (soundRef.current) unlockAudio();
      queue.enqueue(raw);
    },
    [queue],
  );

  const capture = useDialogScanCapture(onScan);

  /* -------------------------------------------------------------- actions */

  async function reconcile(): Promise<ActiveBox | null> {
    const current = activeRef.current;
    if (!current) return null;
    const state = await apiFetch<BoxWorkState>(`/api/boxes/${current.box.id}/state`);
    const next = { ...current, box: state.box, items: state.items, rejections: state.rejections };
    setActive(next);
    return next;
  }

  async function finalize(withReason: string | null) {
    const current = activeRef.current;
    if (!current || finalizing) return;
    setFinalizing(true);
    try {
      await queue.idle();
      const shown = current.box.acceptedCount;
      const fresh = await reconcile();
      if (!fresh) return;
      if (fresh.box.acceptedCount !== shown) {
        say({ tone: "warn", title: "Compteur mis à jour depuis le serveur", lines: ["Vérifier le compteur puis relancer « Terminer le contrôle »."] });
        return;
      }
      const r = await apiFetch<FinalizeResult>(`/api/boxes/${fresh.box.id}/finalize`, {
        body: { leaseToken: fresh.leaseToken, observedAcceptedCount: fresh.box.acceptedCount, incompleteReason: withReason },
      });
      if (r.kind === "FINALIZED" || (r.kind === "ALREADY_FINALIZED" && r.report)) {
        const report = r.report!;
        setFinalized({ report, replaces: report.kind === "CORRECTION" ? fresh.box.previousReport?.reference ?? null : null });
        setActive(null);
        setFinalizeOpen(false);
        setReason("");
        const what = report.kind === "CORRECTION" ? `Correction n°${report.attemptNumber} terminée` : "Contrôle terminé";
        say({
          tone: report.result === "OK" ? "ok" : "nok",
          title: report.result === "OK" ? `${what} : OK` : `${what} : NOT OK`,
          lines: [`Boîte ${report.boxSerial} — ${report.acceptedQty} / ${report.expectedQty}`, `Rapport ${report.reference}`],
        });
        void refreshInProgress();
      } else if (r.kind === "STATE_CHANGED") {
        await reconcile();
        say({ tone: "warn", title: "Le compteur a changé", lines: ["Vérifier puis relancer « Terminer le contrôle »."] });
      } else if (r.kind === "REASON_REQUIRED") {
        setFinalizeOpen(true);
        say({ tone: "warn", title: "Motif obligatoire", lines: [`Boîte incomplète : ${r.acceptedCount} / ${r.expectedQty}.`] });
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "NOT_BOX_OWNER") {
        setActive((prev) => (prev ? { ...prev, lost: e.message } : prev));
      }
      say({
        tone: e instanceof NetworkError ? "warn" : "nok",
        title: e instanceof NetworkError ? "Non confirmé — connexion interrompue" : "Finalisation refusée",
        lines: [e instanceof NetworkError ? "Rien n'est validé tant que le serveur n'a pas répondu. Réessayer." : e instanceof Error ? e.message : "Erreur"],
      });
    } finally {
      setFinalizing(false);
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
  const complete = !!box && box.acceptedCount >= box.expectedQty;
  const canFinalize = !!active && !active.lost && jobs.length === 0 && !finalizing && !sessionExpired;

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
                {box.needsRecontrol && <p className="rounded-md border-2 border-warn bg-warn-soft p-3 font-bold">À recontrôler — génération {box.generation}. Retirer les anciennes étiquettes de la boîte. Aucune étiquette de résultat avant une nouvelle finalisation.</p>}
                {box.activeAttempt?.kind === "CORRECTION" && (
                  <div className="flex flex-wrap items-center gap-3 rounded-md border-2 border-warn bg-warn-soft p-3 text-black" data-testid="correction-banner">
                    <span className="text-xl font-black">Correction en cours (n°{box.activeAttempt.number})</span>
                    {box.previousReport && (
                      <span className="rounded bg-nok px-2 py-1 font-bold text-white" data-testid="previous-result">
                        Résultat précédent : NOT OK — {box.previousReport.acceptedQty} / {box.previousReport.expectedQty} — {box.previousReport.reference} —{" "}
                        {box.previousReport.finalizedBy}, {formatDateTime(box.previousReport.finalizedAt)}
                      </span>
                    )}
                    <span className="text-sm">Ajouter les coiffes manquantes. Les coiffes déjà acceptées sont conservées.</span>
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
                      </span>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Ouverte par <span className="font-mono">{box.createdBy}</span> le {formatDateTime(box.createdAt)} · Opérateur actif{" "}
                      <span className="font-mono font-bold">{username}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="tabular font-mono text-7xl font-black leading-none" data-testid="box-counter">
                      {box.acceptedCount} / {box.expectedQty}
                    </div>
                    <div className="mt-1 text-xl font-bold">
                      Reste : <span className="tabular">{box.remaining}</span>
                    </div>
                  </div>
                </div>
                <div className="h-5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={box.expectedQty} aria-valuenow={box.acceptedCount}>
                  <div className={cn("h-full transition-all", complete ? "bg-ok" : "bg-primary")} style={{ width: `${Math.min(100, (box.acceptedCount / box.expectedQty) * 100)}%` }} />
                </div>
                {complete && !active.lost && (
                  <div className="rounded-md bg-ok-soft p-3 text-xl font-bold text-ok">Quantité atteinte — prête à valider</div>
                )}
                {active.lost && (
                  <div className="flex flex-wrap items-center gap-3 rounded-md bg-nok-soft p-3 text-lg font-bold text-nok" role="alert">
                    {active.lost}
                    <Button variant="outline" onClick={() => void resume(box)}>
                      Reprendre le contrôle
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap gap-3">
                  <Button
                    size="lg"
                    variant={complete ? "success" : "outline"}
                    className={cn("min-w-64", !complete && "border-nok text-nok")}
                    disabled={!canFinalize}
                    onClick={() => {
                      if (!complete) setReason("");
                      setFinalizeOpen(true);
                    }}
                    data-testid="finalize"
                  >
                    {complete ? <CheckCircle2 /> : <XCircle />} Terminer le contrôle{complete ? "" : " (incomplet)"}
                  </Button>
                  <Button size="lg" variant="ghost" onClick={() => void suspend()} disabled={jobs.length > 0 || !!active.lost}>
                    <PauseCircle /> Suspendre
                  </Button>
                  {jobs.length > 0 && <span className="self-center font-semibold text-muted-foreground">Attente des scans en cours…</span>}
                </div>
              </CardContent>
            </Card>
          ) : finalized ? (
            <ResultCard report={finalized.report} replaces={finalized.replaces} onNext={() => { setFinalized(null); focusScan(); }} onSettled={focusScan} />
          ) : (
            <Card>
              <CardContent className="flex flex-col gap-4 pt-4">
                <p className="text-2xl font-bold">Scanner l&apos;étiquette GALIA de la boîte pour commencer.</p>
                {inProgress.length > 0 && (
                  <div>
                    <h2 className="mb-2 text-lg font-bold">Boîtes en cours</h2>
                    <ul className="divide-y divide-border rounded-md border-2 border-border">
                      {inProgress.map((b) => (
                        <li key={b.id} className="flex flex-wrap items-center gap-3 p-2">
                          <span className="font-mono font-bold">{b.boxSerial}</span>
                          <span className="font-mono">{b.partNumber}</span>
                          <span className="tabular font-bold">
                            {b.acceptedCount} / {b.expectedQty}
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
                <CardTitle>Coiffes acceptées ({active.items.length})</CardTitle>
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
                <CardTitle className="text-base">Derniers rejets</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-1 text-sm">
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

      {/* Box switch / takeover decision: scanner keystrokes are queued, never treated as a button press. */}
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
                      Quantité acceptée : <b className="tabular">{decision.report.acceptedQty}</b>.
                    </p>
                    <p className="mt-2 font-bold">Voulez-vous reprendre le contrôle pour corriger cette boîte ?</p>
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
                  Boîte active : <b className="font-mono">{decision.from.boxSerial}</b> ({decision.from.acceptedCount} / {decision.from.expectedQty}).
                  <br />
                  Nouvelle étiquette : <b className="font-mono">{decision.to.boxSerial}</b> — {decision.to.partNumber} — Qté {decision.to.quantity}.
                  <br />
                  Suspendre la boîte active et ouvrir la nouvelle ?
                </DialogDescription>
              </DialogHeader>
            ) : (
              <DialogHeader>
                <DialogTitle>Boîte contrôlée par {decision.owner.username}</DialogTitle>
                <DialogDescription>
                  Boîte <b className="font-mono">{decision.box.boxSerial}</b> ({decision.box.acceptedCount} / {decision.box.expectedQty}) en cours
                  {decision.owner.since ? ` depuis ${formatTime(decision.owner.since)}` : ""}. Reprendre le contrôle ? L&apos;autre poste ne pourra plus scanner
                  dans cette boîte (reprise enregistrée).
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
                onClick={() => {
                  decision.resolve(true);
                  setDecision(null);
                }}
              >
                {decision.type === "correction" ? "OUI — Corriger" : decision.type === "switch" ? "Suspendre et ouvrir" : "Reprendre le contrôle"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      {/* Finalization confirmation (reason required when incomplete). */}
      <Dialog open={finalizeOpen} onOpenChange={setFinalizeOpen}>
        <DialogContent onCloseAutoFocus={(e) => { e.preventDefault(); focusScan(); }}>
          {box && (
            <>
              <DialogHeader>
                <DialogTitle>{complete ? "Terminer le contrôle" : "Boîte incomplète — résultat NON OK"}</DialogTitle>
                <DialogDescription>
                  {box.acceptedCount} / {box.expectedQty} coiffes acceptées.{" "}
                  {complete ? "Le résultat est calculé par le serveur à partir des enregistrements." : "Le contrôle sera enregistré NON OK. Motif obligatoire."}
                </DialogDescription>
              </DialogHeader>
              {!complete && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="nok-reason">Motif</Label>
                  <Textarea id="nok-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Ex. : coiffes manquantes, boîte refaite…" />
                  <p className="text-sm text-muted-foreground">Ne pas scanner pendant cette fenêtre.</p>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" size="lg" onClick={() => setFinalizeOpen(false)}>
                  Annuler
                </Button>
                <Button
                  size="lg"
                  variant={complete ? "success" : "destructive"}
                  disabled={finalizing || (!complete && reason.trim().length < 3)}
                  onClick={() => {
                    setFinalizeOpen(false);
                    void finalize(complete ? null : reason.trim());
                  }}
                >
                  {complete ? "Valider" : "Confirmer NON OK"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Read-only view of an already finalized box. */}
      <Dialog open={readOnlyBox !== null} onOpenChange={(o) => !o && setReadOnlyBox(null)}>
        <DialogContent tabIndex={-1} onKeyDown={capture.onKeyDown} onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement | null)?.focus(); }} onCloseAutoFocus={(e) => { e.preventDefault(); focusScan(); }}>
          {readOnlyBox && (
            <>
              <DialogHeader>
                <DialogTitle>Boîte {readOnlyBox.boxSerial} déjà finalisée</DialogTitle>
                <DialogDescription>Consultation seule : aucune nouvelle vérification possible.</DialogDescription>
              </DialogHeader>
              <div className={cn("rounded-md p-4 text-center text-4xl font-black", readOnlyBox.status === "OK" ? "bg-ok text-white" : "bg-nok text-white")}>
                {readOnlyBox.status === "OK" ? "✔ OK" : "✖ NON OK"}
              </div>
              <p className="text-lg">
                {readOnlyBox.partNumber} — {readOnlyBox.acceptedCount} / {readOnlyBox.expectedQty} — {readOnlyBox.latestReport?.reference}
              </p>
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

function ResultCard({ report, replaces, onNext, onSettled }: { report: ReportSummary; replaces: string | null; onNext: () => void; onSettled: () => void }) {
  const ok = report.result === "OK";
  return (
    <Card className={cn("border-4", ok ? "border-ok" : "border-nok")}>
      <CardContent className="flex flex-col gap-4 pt-4">
        <div className={cn("rounded-md p-6 text-center text-6xl font-black", ok ? "bg-ok text-white" : "bg-nok text-white")} data-testid="final-result">
          {ok ? "✔ OK" : "✖ NOT OK"}
          {report.kind === "CORRECTION" && <div className="mt-1 text-xl font-bold">Correction n°{report.attemptNumber}</div>}
        </div>
        <div className="grid gap-2 text-lg sm:grid-cols-2">
          <div>
            Boîte <b className="font-mono">{report.boxSerial}</b>
          </div>
          <div>
            PN <b className="font-mono">{report.partNumber}</b>
          </div>
          <div>
            Acceptées / prévues :{" "}
            <b className="tabular">
              {report.acceptedQty} / {report.expectedQty}
            </b>{" "}
            (écart {report.difference})
          </div>
          <div>
            Rapport <b className="font-mono">{report.reference}</b>
          </div>
          <div>
            Finalisé par <b className="font-mono">{report.finalizedBy}</b> le {formatDateTime(report.finalizedAt)}
          </div>
          {!ok && (
            <div>
              {report.issues.map((i) => ISSUE_LABELS[i] ?? i).join(", ")}
              {report.reason ? ` — ${report.reason}` : ""}
            </div>
          )}
        </div>
        <PrintPanel reportId={report.id} replacesReference={replaces} onSettled={onSettled} />
        <Button size="lg" variant="outline" onClick={onNext}>
          Boîte suivante
        </Button>
      </CardContent>
    </Card>
  );
}
