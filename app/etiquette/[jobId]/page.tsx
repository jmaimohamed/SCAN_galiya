import { notFound } from "next/navigation";
import { requirePageActor } from "@/lib/server/auth/current";
import { getJobLabel } from "@/lib/server/services/printing";
import { PRINT_TYPE_LABELS } from "@/lib/labels";
import { AppError } from "@/lib/server/errors";

export const metadata = { title: "Étiquette — GALIA Control" };

/**
 * Label print view: the exact SVG snapshot stored with the print job, at its
 * physical size. `@page` sets the paper to the label size with no margin; when
 * printing, only the label is visible. The application loads this page in a frame
 * and calls window.print() on it; the operator picks the printer in the dialog.
 * There is deliberately no print button here (prints go through the tracked
 * « Imprimer l'étiquette » / « Réimprimer… » actions).
 */
export default async function LabelPrintView({ params }: { params: Promise<{ jobId: string }> }) {
  const actor = await requirePageActor();
  const { jobId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) notFound();
  const data = await getJobLabel(jobId, actor).catch((e: unknown) => {
    if (e instanceof AppError && e.status === 404) notFound();
    if (e instanceof AppError) return { error: e.message };
    throw e;
  });
  if ("error" in data) return <p role="alert" data-label-error className="p-4 font-bold">{data.error}</p>;
  const { job, svg } = data;
  const w = job.widthMm;
  const h = job.heightMm;
  const css = `
@page { size: ${w}mm ${h}mm; margin: 0; }
.label-sheet { width: ${w}mm; height: ${h}mm; overflow: hidden; background: #fff; }
.label-sheet img { display: block; width: ${w}mm; height: ${h}mm; }
@media print {
  html, body { margin: 0 !important; padding: 0 !important; width: ${w}mm; height: ${h}mm; min-height: 0 !important; overflow: hidden; background: #fff !important; }
  .label-screen-only { display: none !important; }
  .label-sheet { margin: 0 !important; box-shadow: none !important; border: 0 !important; }
}`;

  return (
    <>
      <style>{css}</style>
      <div className="label-screen-only mx-auto max-w-2xl p-4 text-sm">
        <p className="font-bold">
          Étiquette enregistrée — {PRINT_TYPE_LABELS[job.type]} — {w} × {h} mm — demandée par {job.requestedBy}
          {job.workstationName ? ` sur ${job.workstationName}` : ""}
        </p>
        <p className="text-muted-foreground">
          Pour imprimer, utiliser « Imprimer l&apos;étiquette » ou « Réimprimer… » dans l&apos;application. Dans la fenêtre d&apos;impression : imprimante ZD421 de ce
          poste, papier {w} × {h} mm, échelle 100 % (taille réelle), marges aucune, en-têtes et pieds de page désactivés.
        </p>
      </div>
      {svg ? (
        <div className="label-sheet mx-auto border border-border shadow-lg" data-label-sheet={job.id}>
          {/* An SVG image cannot execute scripts or load external resources. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="Étiquette enregistrée" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} width={w} height={h} />
        </div>
      ) : (
        <p className="label-screen-only p-4 font-semibold">Ancien travail d&apos;impression directe : pas de vue d&apos;impression.</p>
      )}
    </>
  );
}
