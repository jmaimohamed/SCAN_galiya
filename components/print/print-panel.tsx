"use client";

import * as React from "react";
import Link from "next/link";
import { FileText, Printer, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { ApiError, apiFetch, NetworkError } from "@/lib/client/api";
import { openLabelPrintDialog } from "@/lib/client/label-print";
import { useWorkstationId } from "@/lib/client/workstation";
import { PRINT_STATUS_LABELS, PRINT_TYPE_LABELS } from "@/lib/labels";
import { formatDateTime } from "@/lib/time";
import type { PrinterProfileDto, PrintJobDto } from "@/lib/server/services/printing";

const REPRINT_REASONS = [
  "Fenêtre d'impression annulée ou mauvaise imprimante",
  "Étiquette non sortie",
  "Étiquette illisible / abîmée",
  "Étiquette perdue",
];

type Message = { tone: "ok" | "nok" | "warn" | "info"; text: string };

const toneClass: Record<Message["tone"], string> = {
  ok: "bg-ok-soft text-ok border-ok",
  nok: "bg-nok-soft text-nok border-nok",
  warn: "bg-warn-soft text-black border-warn",
  info: "bg-muted text-foreground border-border",
};

/** Settings to use in the browser print dialog (shown next to every print action). */
export function PrintDialogHelp({ widthMm, heightMm }: { widthMm: number; heightMm: number }) {
  return (
    <ul className="list-disc pl-5 text-sm" data-testid="print-dialog-help">
      <li>
        Imprimante : la <b>ZD421 de ce poste</b> (pilote Windows ZDesigner).
      </li>
      <li>
        Papier : <b>{widthMm} × {heightMm} mm</b> (format d&apos;étiquette défini dans le pilote) ; copies : <b>1</b>.
      </li>
      <li>
        Échelle : <b>100 % / taille réelle</b> (pas « Ajuster ») ; marges : <b>aucune</b>.
      </li>
      <li>
        <b>En-têtes et pieds de page : désactivés</b> ; graphiques d&apos;arrière-plan : activés.
      </li>
    </ul>
  );
}

export interface PrintPanelProps {
  reportId: string;
  /** When set, printing of this report is not allowed (correction open, newer report…). */
  blockedReason?: string | null;
  /** For a correction report: reference of the NOT OK report whose label must be replaced. */
  replacesReference?: string | null;
  onSettled?: () => void;
}

export function PrintPanel({ reportId, blockedReason = null, replacesReference = null, onSettled }: PrintPanelProps) {
  const workstationId = useWorkstationId();
  const [loadedProfile, setProfile] = React.useState<PrinterProfileDto | null | undefined>(undefined);
  const profile = workstationId === null ? null : loadedProfile;
  const [jobs, setJobs] = React.useState<PrintJobDto[]>([]);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<Message | null>(null);
  const [reprintOpen, setReprintOpen] = React.useState(false);
  const [reason, setReason] = React.useState(REPRINT_REASONS[0]);
  const [reasonDetail, setReasonDetail] = React.useState("");
  const [checkedPrinter, setCheckedPrinter] = React.useState(false);
  /** Idempotency key of the current logical print action (kept across network retries). */
  const pendingKey = React.useRef<{ kind: string; key: string } | null>(null);
  const inFlight = React.useRef(false);

  const loadJobs = React.useCallback(async () => {
    try {
      const r = await apiFetch<{ jobs: PrintJobDto[] }>(`/api/reports/${reportId}/print-jobs`);
      setJobs(r.jobs);
    } catch {
      /* shown as empty list */
    }
  }, [reportId]);

  React.useEffect(() => {
    apiFetch<{ jobs: PrintJobDto[] }>(`/api/reports/${reportId}/print-jobs`)
      .then((r) => setJobs(r.jobs))
      .catch(() => undefined);
    if (!workstationId) return;
    apiFetch<{ profile: PrinterProfileDto | null }>(`/api/printer-profile?workstationId=${workstationId}`)
      .then((r) => {
        setProfile(r.profile);
        if (r.profile && !blockedReason) {
          apiFetch<{ svg: string }>(`/api/reports/${reportId}/label-preview?workstationId=${workstationId}`)
            .then((p) => setPreview(p.svg))
            .catch((e) => setMessage({ tone: "nok", text: e instanceof Error ? e.message : "Aperçu impossible" }));
        }
      })
      .catch(() => setProfile(null));
  }, [reportId, workstationId, blockedReason]);

  const firstOriginal = jobs.find((j) => j.type === "ORIGINAL" && j.status !== "FAILED");
  const ready = !blockedReason && !!workstationId && !!profile?.confirmedAt;

  async function print(kind: "ORIGINAL" | "REPRINT", reprintReason: string | null) {
    if (inFlight.current || !workstationId) return;
    inFlight.current = true;
    setBusy(true);
    setMessage({ tone: "info", text: "Préparation de l'étiquette…" });
    if (!pendingKey.current || pendingKey.current.kind !== kind) pendingKey.current = { kind, key: crypto.randomUUID() };
    try {
      const { job, replayed } = await apiFetch<{ job: PrintJobDto; replayed: boolean }>("/api/print-jobs", {
        body: { idempotencyKey: pendingKey.current.key, kind, reportId, workstationId, reprintReason },
      });
      pendingKey.current = null;
      await openLabelPrintDialog(job.id, job.widthMm, job.heightMm);
      setMessage({
        tone: "info",
        text: `Fenêtre d'impression demandée${kind === "REPRINT" ? " (RÉIMPRESSION)" : ""}${replayed ? " (même demande)" : ""}. Vérifier que l'étiquette est bien sortie sur la ZD421 de ce poste : le logiciel ne peut pas le confirmer (une annulation n'est pas détectée).`,
      });
    } catch (e) {
      if (e instanceof NetworkError) {
        // The job may or may not exist: keep the same key so a new click cannot create a second job.
        setMessage({ tone: "warn", text: "Non confirmé — connexion interrompue. Cliquer à nouveau réutilise la même demande (pas de doublon)." });
      } else {
        pendingKey.current = null;
        setMessage({ tone: "nok", text: e instanceof ApiError || e instanceof Error ? e.message : "Erreur d'impression" });
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      await loadJobs();
      onSettled?.();
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="print-panel">
      {replacesReference && (
        <p className="flex items-start gap-2 rounded-md border-2 border-nok bg-nok-soft p-3 font-bold text-nok" data-testid="replace-label-notice">
          <TriangleAlert className="mt-0.5 size-5 shrink-0" />
          Correction du rapport {replacesReference} : retirer l&apos;ancienne étiquette NOT OK de la boîte et la remplacer par cette nouvelle étiquette. Le logiciel ne peut
          pas invalider une étiquette déjà posée.
        </p>
      )}

      {blockedReason ? (
        <p className="rounded-md border-2 border-border bg-muted p-3 font-semibold" data-testid="print-blocked">
          {blockedReason}
        </p>
      ) : (
        <>
          {(profile === null || (profile && !profile.confirmedAt)) && (
            <p className="flex items-start gap-2 rounded-md border-2 border-warn bg-warn-soft p-3 font-semibold text-black" data-testid="label-not-configured">
              <TriangleAlert className="mt-0.5 size-5 shrink-0" />
              <span>
                {profile === null ? "Taille d'étiquette non réglée pour ce poste." : "Taille d'étiquette non confirmée (étiquette TEST)."}{" "}
                <Link className="underline" href="/imprimante">
                  Étiquette de ce poste
                </Link>
              </span>
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {!firstOriginal ? (
              <Button size="lg" onClick={() => print("ORIGINAL", null)} disabled={!ready || busy} data-testid="print-label">
                <Printer /> {busy ? "Préparation…" : "Imprimer l'étiquette"}
              </Button>
            ) : (
              <Button
                size="lg"
                variant="outline"
                onClick={() => {
                  setCheckedPrinter(false);
                  setReprintOpen(true);
                }}
                disabled={!ready || busy}
                data-testid="reprint-label"
              >
                <RotateCcw /> Réimprimer…
              </Button>
            )}
            <Button variant="ghost" onClick={() => void loadJobs()} disabled={busy}>
              <RefreshCw /> Actualiser
            </Button>
          </div>
          {profile?.confirmedAt && <PrintDialogHelp widthMm={profile.widthMm} heightMm={profile.heightMm} />}
        </>
      )}
      <Button variant="ghost" asChild className="self-start">
        <Link href={`/rapport/${reportId}`} target="_blank">
          <FileText /> Rapport A4
        </Link>
      </Button>

      {message && <p className={`rounded-md border-2 p-3 font-semibold ${toneClass[message.tone]}`} role="status">{message.text}</p>}

      {preview && (
        <details className="rounded-md border-2 border-border bg-card p-2">
          <summary className="cursor-pointer font-semibold">Aperçu de l&apos;étiquette</summary>
          {/* SVG generated server-side from the saved report; shown as an image (no script execution). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="Aperçu de l'étiquette" className="mx-auto mt-2 max-h-80 border border-border" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview)}`} />
        </details>
      )}

      {jobs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-border text-left">
                <th className="py-1 pr-2">Date</th>
                <th className="py-1 pr-2">Type</th>
                <th className="py-1 pr-2">État</th>
                <th className="py-1 pr-2">Demandé par</th>
                <th className="py-1 pr-2">Poste / format</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-border align-top">
                  <td className="py-1 pr-2 tabular">{formatDateTime(j.createdAt)}</td>
                  <td className="py-1 pr-2">
                    {PRINT_TYPE_LABELS[j.type]}
                    {j.reprintReason && <div className="text-muted-foreground">{j.reprintReason}</div>}
                  </td>
                  <td className="py-1 pr-2">
                    <Badge tone={j.status === "FAILED" ? "nok" : j.status === "UNKNOWN" ? "warn" : "neutral"}>{PRINT_STATUS_LABELS[j.status] ?? j.status}</Badge>
                  </td>
                  <td className="py-1 pr-2 font-mono">{j.requestedBy}</td>
                  <td className="py-1 pr-2">
                    {j.workstationName ?? "?"} · {j.widthMm}×{j.heightMm} mm
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={reprintOpen} onOpenChange={setReprintOpen}>
        <DialogContent onCloseAutoFocus={(e) => { e.preventDefault(); onSettled?.(); }}>
          <DialogHeader>
            <DialogTitle>Réimpression</DialogTitle>
            <DialogDescription>
              L&apos;étiquette portera « RÉIMPRESSION » et reprend exactement ce rapport. L&apos;opérateur d&apos;origine reste en haut à droite. Une réimpression peut
              créer un doublon si l&apos;étiquette précédente est déjà sortie.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="reprint-reason">Motif</Label>
            <Select id="reprint-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
              {REPRINT_REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
            <Input placeholder="Précision (optionnel)" value={reasonDetail} maxLength={120} onChange={(e) => setReasonDetail(e.target.value)} />
            <label className="mt-2 flex items-start gap-2 font-semibold">
              <input type="checkbox" className="mt-1 size-5" checked={checkedPrinter} onChange={(e) => setCheckedPrinter(e.target.checked)} />
              J&apos;ai vérifié l&apos;imprimante : l&apos;étiquette précédente n&apos;est pas sortie ou n&apos;est pas utilisable.
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReprintOpen(false)}>
              Annuler
            </Button>
            <Button
              disabled={!checkedPrinter || busy}
              onClick={() => {
                setReprintOpen(false);
                void print("REPRINT", reasonDetail.trim() ? `${reason} — ${reasonDetail.trim()}` : reason);
              }}
            >
              <RotateCcw /> Réimprimer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
