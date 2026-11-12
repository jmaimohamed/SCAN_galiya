import Link from "next/link";
import { prisma } from "@/lib/server/db";
import { requirePageActor } from "@/lib/server/auth/current";
import { AdminLabelSettings } from "@/components/admin/label-settings-editor";
export default async function AdminSettings({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requirePageActor("ADMIN");
  const total = await prisma.printerProfile.count(); const pageCount = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(pageCount, Math.max(1, parseInt((await searchParams).page ?? "1", 10) || 1));
  const profiles = await prisma.printerProfile.findMany({ orderBy: [{ name: "asc" }, { workstationId: "asc" }], take: 25, skip: (page - 1) * 25, select: { workstationId: true, name: true, widthMm: true, printableWidthMm: true, heightMm: true, orientation: true, contentPosition: true, contentLengthMm: true } });
  return <div className="flex flex-col gap-4"><h1 className="text-3xl font-bold">Réglages des postes</h1><p>Dimensions d&apos;étiquette par profil navigateur. Toute modification est motivée et auditée. Changer la taille efface sa confirmation ; l&apos;opérateur doit mesurer une nouvelle étiquette TEST. Aucun réglage ne choisit une imprimante physique ni ne confirme une sortie papier.</p>{profiles.map((p) => <AdminLabelSettings key={p.workstationId} profile={p} />)}<nav className="flex gap-4">Page {page}/{pageCount}{page > 1 && <Link href={`?page=${page - 1}`}>Précédente</Link>}{page < pageCount && <Link href={`?page=${page + 1}`}>Suivante</Link>}</nav></div>;
}
