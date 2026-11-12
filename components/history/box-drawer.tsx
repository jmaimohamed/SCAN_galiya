"use client";

import Link from "next/link";
import * as React from "react";
import { DialogDescription, DialogTitle, SheetContent } from "@/components/ui/dialog";
import { PrintPanel } from "@/components/print/print-panel";
import { Badge } from "@/components/ui/card";
import { apiFetch } from "@/lib/client/api";
import { ISSUE_LABELS } from "@/lib/labels";
import { formatDateTime } from "@/lib/time";
import type { BoxDetail } from "@/lib/server/services/history";
import { StatusBadge } from "./history-view";

const EVENT_LABELS: Record<string, string> = {
  BOX_CREATED: "Boîte créée",
  BOX_RESUMED: "Boîte reprise",
  BOX_TAKEOVER: "Reprise de contrôle",
  BOX_SUSPENDED: "Boîte suspendue",
  BOX_CONFLICT: "Conflit d'étiquette",
  BOX_FINALIZED: "Contrôle finalisé",
  BOX_VIEWED_FINALIZED: "Consultation (finalisée)",
  BOX_CORRECTION_OFFERED: "Correction proposée (boîte NOT OK rescannée)",
  BOX_CORRECTION_OPENED: "Correction ouverte (OUI — Corriger)",
  LABEL_DIALOG_PRINT_REQUESTED: "Étiquette via fenêtre d'impression (secours)",
  PRINT_JOB_CREATED: "Impression demandée",
  PRINT_JOB_DISPATCHING: "Envoi à l'imprimante",
  PRINT_JOB_RESULT: "Résultat d'impression",
  A4_PRINT_REQUESTED: "Rapport A4 ouvert pour impression",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="border-b-2 border-border pb-1 text-lg font-bold">{title}</h3>
      {children}
    </section>
  );
}

export function BoxDrawer({ boxId }: { boxId: string }) {
  const [detail, setDetail] = React.useState<BoxDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // The parent keys this component by boxId, so state starts empty for each box.
  React.useEffect(() => {
    let alive = true;
    apiFetch<BoxDetail>(`/api/boxes/${boxId}`)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Erreur"));
    return () => {
      alive = false;
    };
  }, [boxId]);

  return (
    <SheetContent aria-describedby="box-drawer-desc">
      <div className="border-b-2 border-border p-4 pr-12">
        <DialogTitle className="text-2xl font-bold">Boîte {detail?.boxSerial ?? "…"}</DialogTitle>
        <DialogDescription id="box-drawer-desc">Traçabilité complète de la vérification.</DialogDescription>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {error && <p className="rounded-md bg-nok-soft p-3 font-semibold text-nok">{error}</p>}
        {!detail && !error && <p>Chargement…</p>}
        {detail && (
          <div className="flex flex-col gap-6">
            <Link className="font-bold underline" href={`/admin/boites/${boxId}`}>Détails complets paginés et actions administratives</Link>
            {detail.needsRecontrol && <Badge tone="warn">À recontrôler</Badge>}
            <Section title="Boîte">
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt className="font-semibold">Statut</dt>
                <dd className="flex flex-wrap gap-2">
                  <StatusBadge status={detail.status} />
                  {detail.correctionActive && <Badge tone="warn">Correction en cours</Badge>}
                  <span className="text-sm text-muted-foreground">{detail.attempts.length} tentative(s)</span>
                </dd>
                <dt className="font-semibold">PN</dt>
                <dd className="font-mono">{detail.partNumber}</dd>
                <dt className="font-semibold">Série boîte</dt>
                <dd className="font-mono">{detail.boxSerial}</dd>
                <dt className="font-semibold">Quantités</dt>
                <dd className="tabular">
                  <b>
                    {detail.counts.distinct} pièces distinctes / {detail.expectedQty} attendues
                  </b>
                  <div>
                    {detail.counts.conforming} conformes (dont {detail.acceptedQty} comptées dans la boîte) · {detail.counts.nonconforming} non conformes
                  </div>
                  {detail.status !== "OK" && <div className="font-semibold text-nok">{detail.lines.join(" · ")}</div>}
                </dd>
                <dt className="font-semibold">Étiquette GALIA</dt>
                <dd className="break-all font-mono">{detail.galiaPayload}</dd>
                <dt className="font-semibold">Ouverte par</dt>
                <dd>
                  <span className="font-mono">{detail.createdBy}</span> — {formatDateTime(detail.createdAt)}
                </dd>
                {detail.currentOwner && (
                  <>
                    <dt className="font-semibold">Contrôlée par</dt>
                    <dd className="font-mono">{detail.currentOwner}</dd>
                  </>
                )}
              </dl>
            </Section>

            {[...detail.attempts].reverse().map((a) => {
              const previous = detail.attempts.find((p) => p.number === a.number - 1)?.report ?? null;
              return (
                <Section
                  key={a.id}
                  title={`${a.kind === "CORRECTION" ? `Correction n°${a.number}` : "Contrôle initial (n°1)"}${a.status === "IN_PROGRESS" ? " — en cours" : ""}`}
                >
                  <div className="text-sm text-muted-foreground">
                    Ouvert par <span className="font-mono">{a.startedBy}</span> le {formatDateTime(a.startedAt)} · {a.acceptedInAttempt} coiffe(s) acceptée(s) dans cette
                    tentative
                  </div>
                  {a.report ? (
                    <>
                      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1" data-testid={`report-${a.number}`}>
                        <dt className="font-semibold">Rapport</dt>
                        <dd className="font-mono">{a.report.reference}</dd>
                        <dt className="font-semibold">Résultat</dt>
                        <dd>
                          <StatusBadge status={a.report.result} />{" "}
                          <span className="tabular font-bold">
                            {a.report.counts.distinct} / {a.report.expectedQty}
                          </span>{" "}
                          — {a.report.counts.conforming} conformes · {a.report.counts.nonconforming} non conformes
                          {a.report.countingVersion < 2 && <span className="text-xs text-muted-foreground"> (ancien décompte)</span>}
                        </dd>
                        <dt className="font-semibold">Détail</dt>
                        <dd className={a.report.result === "OK" ? "text-ok" : "font-semibold text-nok"}>{a.report.lines.join(" · ")}</dd>
                        <dt className="font-semibold">Finalisé par</dt>
                        <dd>
                          <span className="font-mono">{a.report.finalizedBy}</span> — {formatDateTime(a.report.finalizedAt)}
                        </dd>
                        {a.report.endTrigger && (
                          <>
                            <dt className="font-semibold">Fin</dt>
                            <dd>{a.report.endTrigger === "GALIA_RESCAN" ? "GALIA rescannée" : "Bouton « Terminer le contrôle »"}</dd>
                          </>
                        )}
                        {a.report.issues.length > 0 && (
                          <>
                            <dt className="font-semibold">Anomalies</dt>
                            <dd>{a.report.issues.map((i) => ISSUE_LABELS[i] ?? i).join(", ")}</dd>
                          </>
                        )}
                        {a.report.reason && (
                          <>
                            <dt className="font-semibold">Motif</dt>
                            <dd>{a.report.reason}</dd>
                          </>
                        )}
                      </dl>
                      <PrintPanel
                        reportId={a.report.id}
                        blockedReason={
                          a.printable
                            ? null
                            : detail.correctionActive || detail.attempts.some((x) => x.status === "IN_PROGRESS")
                              ? "Correction en cours : impression bloquée jusqu'à la finalisation de la correction."
                              : "Rapport remplacé par une tentative plus récente : impression désactivée (consultation seule)."
                        }
                        replacesReference={a.printable && a.kind === "CORRECTION" && previous?.result === "NOK" ? previous.reference : null}
                      />
                    </>
                  ) : (
                    <p className="font-semibold">Tentative ouverte : pas encore de rapport.</p>
                  )}
                </Section>
              );
            })}

            <Section title={`Coiffes acceptées (${detail.items.length})`}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left">
                    <tr className="border-b border-border">
                      <th className="py-1 pr-2">#</th>
                      <th className="py-1 pr-2">Tent.</th>
                      <th className="py-1 pr-2">PN</th>
                      <th className="py-1 pr-2">Série</th>
                      <th className="py-1 pr-2">Scan brut</th>
                      <th className="py-1 pr-2">Opérateur</th>
                      <th className="py-1 pr-2">Heure</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((i, idx) => (
                      <tr key={i.id} className="border-b border-border">
                        <td className="py-1 pr-2 tabular">{idx + 1}</td>
                        <td className="py-1 pr-2 tabular">{i.attemptNumber}</td>
                        <td className="py-1 pr-2 font-mono">{i.partNumber}</td>
                        <td className="py-1 pr-2 font-mono font-bold">{i.serial}</td>
                        <td className="break-all py-1 pr-2 font-mono text-xs">{i.rawPayload}</td>
                        <td className="py-1 pr-2 font-mono">{i.acceptedBy}</td>
                        <td className="py-1 pr-2 tabular">{formatDateTime(i.acceptedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section title={`Scans refusés (${detail.rejections.length})`}>
              {detail.rejections.length === 0 ? (
                <p className="text-muted-foreground">Aucun.</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {detail.rejections.map((r) => (
                    <li key={r.id} className="border-b border-border py-1">
                      <span className="font-semibold text-nok">{r.title}</span> — <span className="font-mono">{r.username}</span> — {formatDateTime(r.createdAt)}
                      {r.attemptNumber !== null && <span className="text-muted-foreground"> — tentative {r.attemptNumber}</span>}
                      {r.message && <div>{r.message}</div>}
                      <div className="break-all font-mono text-xs">
                        {r.raw}
                        {r.rawLength > r.raw.length ? ` … (${r.rawLength} caractères)` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Journal">
              <ul className="flex flex-col gap-1 text-sm">
                {detail.events.map((e) => (
                  <li key={e.id} className="flex flex-wrap gap-x-2 border-b border-border py-1">
                    <span className="tabular">{formatDateTime(e.createdAt)}</span>
                    <span className="font-semibold">{EVENT_LABELS[e.type] ?? e.type}</span>
                    {e.username && <span className="font-mono">{e.username}</span>}
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        )}
      </div>
    </SheetContent>
  );
}
