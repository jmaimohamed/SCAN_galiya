import { notFound } from "next/navigation";
import { requirePageActor } from "@/lib/server/auth/current";
import { assertReportAccess } from "@/lib/server/permissions";
import { prisma } from "@/lib/server/db";
import { toReportSummary } from "@/lib/server/services/boxes";
import { ISSUE_LABELS } from "@/lib/labels";
import { formatDateTime } from "@/lib/time";
import { A4PrintButton } from "./print-button";

export const metadata = { title: "Rapport A4 — GALIA Control" };

/** Optional A4 fallback, rendered from the saved immutable report only. */
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePageActor();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const row = await prisma.report.findUnique({ where: { id } });
  if (!row) notFound();
  await assertReportAccess(actor, row.id);
  const r = toReportSummary(row);
  const ok = r.result === "OK";
  const latest = await prisma.report.findFirst({ where: { boxId: row.boxId }, orderBy: [{ finalizedAt: "desc" }, { number: "desc" }] });
  const supersededBy = latest && latest.id !== row.id ? toReportSummary(latest).reference : null;

  return (
    <main className="mx-auto max-w-[210mm] bg-white p-8 text-black print:p-0">
      <style>{`@page { size: A4; margin: 12mm; }`}</style>
      <div className="no-print mb-6 flex gap-2">
        <A4PrintButton reportId={r.id} />
      </div>
      <header className="flex items-start justify-between border-b-4 border-black pb-3">
        <div>
          <div className="text-2xl font-bold">GALIA Control — Rapport de vérification</div>
          <div id="reprint-marker" className="mt-1 hidden text-2xl font-black">RÉIMPRESSION</div>
        </div>
        <div className="text-right" data-testid="report-operator">
          <div className="text-sm font-bold uppercase">Opérateur</div>
          <div className="font-mono text-4xl font-black">{r.finalizedBy}</div>
        </div>
      </header>
      {supersededBy && (
        <div className="mt-4 border-4 border-black p-3 text-center text-2xl font-black">RAPPORT REMPLACÉ PAR {supersededBy} — NE PAS UTILISER COMME RÉSULTAT ACTUEL</div>
      )}
      <div className={`my-8 rounded-lg border-[10px] p-8 text-center ${ok ? "border-black bg-[#15803d] text-white" : "border-double border-black bg-[#b91c1c] text-white"}`}>
        <div className="text-[110px] font-black leading-none">{ok ? "✔ OK" : "✖ NOT OK"}</div>
      </div>
      <table className="w-full border-collapse text-xl">
        <tbody>
          {[
            ["Tentative", r.kind === "CORRECTION" ? `Correction n°${r.attemptNumber}` : "Contrôle initial (n°1)"],
            ["Série boîte", r.boxSerial],
            ["Référence (PN)", r.partNumber],
            ["Quantité attendue", String(r.expectedQty)],
            ["Pièces distinctes scannées", String(r.counts.distinct)],
            ["Quantité conforme", String(r.counts.conforming)],
            ["Non conformes", String(r.counts.nonconforming)],
            ...(r.counts.missing > 0 ? [["Manquant", String(r.counts.missing)]] : []),
            ...(Math.max(r.counts.extra, r.counts.excess) > 0 ? [["Excédent", String(Math.max(r.counts.extra, r.counts.excess))]] : []),
            ...(r.counts.duplicates > 0 ? [["Scans en double (tentatives)", String(r.counts.duplicates)]] : []),
            ...(r.counts.invalid > 0 ? [["Formats invalides (tentatives)", String(r.counts.invalid)]] : []),
            ["Conclusion", r.lines.join(" · ")],
            ["Terminé le (Africa/Tunis)", formatDateTime(r.finalizedAt)],
            ["Référence du rapport", r.reference],
            ...(r.countingVersion < 2 ? [["Décompte", "Ancien rapport : seules les coiffes acceptées étaient enregistrées"]] : []),
            ...(!ok && (r.issues.length > 0 || r.reason) ? [["Anomalies / note", [r.issues.map((i) => ISSUE_LABELS[i] ?? i).join(", "), r.reason].filter(Boolean).join(" — ")]] : []),
          ].map(([k, v]) => (
            <tr key={k} className="border-b-2 border-black">
              <th className="w-1/3 py-2 pr-4 text-left">{k}</th>
              <td className="py-2 font-mono font-bold">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-8 text-sm">
        Ce document atteste la vérification des étiquettes scannées (identités et quantités), pas la présence physique des pièces dans la boîte.
      </p>
    </main>
  );
}
