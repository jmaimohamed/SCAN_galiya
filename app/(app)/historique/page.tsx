import { requirePageActor } from "@/lib/server/auth/current";
import { searchHistory } from "@/lib/server/services/history";
import { HistoryView } from "@/components/history/history-view";

export const metadata = { title: "Historique — GALIA Control" };

type SP = Record<string, string | string[] | undefined>;

export default async function HistoryPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePageActor("ADMIN");
  const sp = await searchParams;
  const get = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const statusParam = get("status");
  const status = statusParam === "IN_PROGRESS" || statusParam === "OK" || statusParam === "NOK" ? statusParam : "ALL";
  const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
  const filters = { q: get("q").slice(0, 64), status, from: day(get("from")), to: day(get("to")), page: Math.max(1, Number.parseInt(get("page"), 10) || 1) } as const;
  const data = await searchHistory(filters);
  const boxParam = get("box");
  return <HistoryView data={data} filters={filters} openBoxId={/^[0-9a-f-]{36}$/i.test(boxParam) ? boxParam : null} />;
}
