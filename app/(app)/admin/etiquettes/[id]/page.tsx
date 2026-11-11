import { notFound } from "next/navigation";
import { requirePageActor } from "@/lib/server/auth/current";
import { prisma } from "@/lib/server/db";
import { parseId } from "@/lib/server/schemas";
import { formatDateTime } from "@/lib/time";
export default async function AuditLabel({ params }: { params: Promise<{ id: string }> }) {
  await requirePageActor("ADMIN");
  const row = await prisma.printJob.findUnique({ where: { id: parseId((await params).id) } });
  if (!row) notFound();
  return <article className="flex flex-col gap-4"><h1 className="text-2xl font-black">Snapshot historique — AUDIT UNIQUEMENT</h1><p className="border-4 border-black p-3 text-xl font-black">COPIE D&apos;AUDIT — NE PAS UTILISER EN PRODUCTION. Cette vue ne crée aucune demande d&apos;impression.</p><p>{row.type} · {row.status} · {row.requestedByUsername} · {formatDateTime(row.createdAt)} · poste {row.workstationName} · format {row.widthMm} × {row.heightMm} mm</p><p>Motif de réimpression : {row.reprintReason ?? "—"}. Sortie physique non confirmée.</p><p className="break-all font-mono">SHA-256 : {row.payloadSha256}</p>{row.method === "PRINT_DIALOG" ?
    // eslint-disable-next-line @next/next/no-img-element
    <img alt="Snapshot immuable de l'étiquette (audit)" className="max-h-[600px] self-start border" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(row.payload)}`} /> : <pre className="overflow-auto">{row.payload}</pre>}</article>;
}
