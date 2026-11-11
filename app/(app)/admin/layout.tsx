import Link from "next/link";
import { requirePageActor } from "@/lib/server/auth/current";
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requirePageActor("ADMIN");
  return <div className="flex flex-col gap-4"><nav className="flex flex-wrap gap-5 font-bold" aria-label="Administration"><Link href="/admin">Tableau de bord</Link><Link href="/admin/utilisateurs">Utilisateurs</Link><Link href="/historique">Historique</Link><Link href="/admin/reglages">Réglages des postes</Link></nav>{children}</div>;
}
