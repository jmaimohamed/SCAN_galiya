import Link from "next/link";
import { requirePageActor } from "@/lib/server/auth/current";
import { administrationDashboard, dashboardFilters } from "@/lib/server/services/dashboard";
import { AdminAutoRefresh } from "@/components/admin/auto-refresh";
import { formatDateTime } from "@/lib/time";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Administration — GALIA Control" };
const names: Record<string, string> = { ALL: "Toutes les boîtes courantes", COMPLETED: "Boîtes contrôlées (finalisées)", OK: "OK courant", NOK: "NOT OK courant", IN_PROGRESS: "En cours", RECONTROL: "À recontrôler", ARCHIVED: "Générations archivées" };
export default async function AdminDashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requirePageActor("ADMIN");
  const f = dashboardFilters(await searchParams);
  const data = await administrationDashboard(actor, f);
  const href = (status: string, page = 1) => `/admin?${new URLSearchParams({ from: f.from, to: f.to, operator: f.operator, pn: f.pn, status, page: String(page) })}#details`;
  const cards = [["COMPLETED", data.metrics.completed], ["OK", data.metrics.ok], ["NOK", data.metrics.nok], ["IN_PROGRESS", data.metrics.inProgress], ["RECONTROL", data.metrics.recontrol], ["ARCHIVED", data.metrics.archived]] as const;
  return <div className="flex flex-col gap-4">
    <h1 className="text-3xl font-black">Administration de production</h1>
    <AdminAutoRefresh />
    <form className="grid gap-3 rounded-lg border-2 bg-card p-4 md:grid-cols-6" method="get">
      <label>Du<Input name="from" type="date" defaultValue={f.from} /></label><label>Au<Input name="to" type="date" defaultValue={f.to} /></label>
      <label>Opérateur<Input name="operator" defaultValue={f.operator} maxLength={32} /></label><label>PN (préfixe)<Input name="pn" defaultValue={f.pn} maxLength={40} /></label>
      <label>État<Select name="status" defaultValue={f.status}>{Object.entries(names).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</Select></label><Button type="submit" className="self-end">Filtrer</Button>
    </form>
    <p className="text-sm">Dates inclusives en Africa/Tunis : dernière finalisation valide pour les boîtes terminées ; début de la génération pour les boîtes en cours/à recontrôler ; date d&apos;archivage pour les anciennes générations. Opérateur = contrôleur courant/finalisant ; dans les archives, administrateur ayant réinitialisé. Une correction ouverte est en cours. Chaque boîte courante compte une seule fois ; corrections et réimpressions n&apos;ajoutent aucune boîte.</p>
    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-7">{cards.map(([status, value]) => <Link key={status} href={href(status)}><Card><CardContent className="pt-4"><p className="font-semibold">{names[status]}</p><p className="text-4xl font-black">{value}</p></CardContent></Card></Link>)}<Link href="/admin/presence?state=ACTIVE"><Card><CardContent className="pt-4"><p className="font-semibold">Opérateurs connectés/actifs</p><p className="text-4xl font-black">{data.metrics.onlineOperators}</p></CardContent></Card></Link></div>
    <section id="details" className="overflow-x-auto rounded-lg border-2 bg-card p-4"><h2 className="mb-3 text-xl font-bold">{names[f.status]} — {data.total}</h2>
      <table className="w-full text-left"><thead><tr><th>Série boîte / PN</th><th>Génération</th><th>État</th><th>Quantité active</th><th>Opérateur / date</th><th>Détails</th></tr></thead><tbody>
        {data.rows.map((b) => <tr className="border-t" key={b.id}><td className="py-3 font-mono">{b.serial}<br />{b.pn}</td><td>{b.generation}</td><td>{names[b.status] ?? b.status}</td><td>{b.acceptedQty} / {b.expectedQty}</td><td>{b.operator ?? "—"}<br />{b.finalizedAt ? formatDateTime(b.finalizedAt) : "—"}</td><td><Link className="font-bold underline" href={`/admin/boites/${b.id}`}>Ouvrir</Link></td></tr>)}
        {data.archived.map((g) => <tr className="border-t" key={g.id}><td className="py-3 font-mono">{g.boxSerial}<br />{g.partNumber}</td><td>{g.number}</td><td>Archivée : {g.voidReason}</td><td>Retirée de la production</td><td>{formatDateTime(g.voidedAt)}</td><td><Link className="underline" href={`/admin/boites/${g.boxId}`}>Audit conservé</Link></td></tr>)}
      </tbody></table>{data.total === 0 && <p className="py-4">Aucun résultat.</p>}
      <div className="mt-4 flex gap-5"><span>Page {data.page} / {data.pageCount} (25 lignes)</span>{data.page > 1 && <Link className="underline" href={href(f.status, data.page - 1)}>Précédente</Link>}{data.page < data.pageCount && <Link className="underline" href={href(f.status, data.page + 1)}>Suivante</Link>}</div>
    </section>
  </div>;
}
