import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageActor } from "@/lib/server/auth/current";
import { prisma } from "@/lib/server/db";
import { parseId } from "@/lib/server/schemas";
import { formatDateTime } from "@/lib/time";
import { countsFromReport, issueLines } from "@/lib/counting";
export default async function AuditReport({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> }) {
  await requirePageActor("ADMIN");
  const id = parseId((await params).id);
  const r = await prisma.report.findUnique({ where: { id } });
  if (!r) notFound();
  const total = await prisma.printJob.count({ where: { reportId: id } });
  const pageCount = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(pageCount, Math.max(1, parseInt((await searchParams).page ?? "1", 10) || 1));
  const jobs = await prisma.printJob.findMany({ where: { reportId: id }, orderBy: { createdAt: "desc" }, take: 25, skip: (page - 1) * 25 });
  return <article className="flex flex-col gap-4"><h1 className="text-3xl font-bold">Rapport immuable n°{r.number} — {r.result}</h1><p>Audit uniquement : ce rapport peut avoir été remplacé ou invalidé.</p><p className="font-mono">{r.galiaPayload}</p><p>PN {r.partNumber} · série {r.boxSerial} · {countsFromReport(r).distinct}/{r.expectedQty} distinctes · {countsFromReport(r).conforming} conformes · {countsFromReport(r).nonconforming} non conformes · tentative {r.attemptNumber} · {r.finalizedByUsername} · {formatDateTime(r.finalizedAt)}</p><p className="font-semibold">{issueLines(countsFromReport(r)).join(" · ")}{r.endTrigger ? ` · fin : ${r.endTrigger === "GALIA_RESCAN" ? "GALIA rescannée" : "bouton Terminer"}` : ""}{r.countingVersion < 2 ? " · ancien décompte" : ""}</p><p>{r.issues.join(", ")} · {r.reason}</p><Link className="underline" href={`/admin/boites/${r.boxId}`}>Revenir à la boîte et à son état courant</Link><h2 className="text-2xl font-bold">Demandes d&apos;impression : {total}</h2>{jobs.map((j) => <p className="border-t py-2" key={j.id}><Link className="underline" href={`/admin/etiquettes/${j.id}`}>{formatDateTime(j.createdAt)} · {j.type}</Link> · {j.requestedByUsername} · {j.workstationName} · {j.status} · {j.reprintReason}</p>)}<nav className="flex gap-4">Page {page}/{pageCount}{page > 1 && <Link href={`?page=${page - 1}`}>Précédente</Link>}{page < pageCount && <Link href={`?page=${page + 1}`}>Suivante</Link>}</nav></article>;
}
