"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { STATUS_LABELS } from "@/lib/labels";
import { formatDateTime } from "@/lib/time";
import type { HistoryRow } from "@/lib/server/services/history";
import { BoxDrawer } from "./box-drawer";

interface Props {
  data: { rows: HistoryRow[]; total: number; page: number; pageCount: number };
  filters: { q: string; status: string; from: string; to: string; page: number };
  openBoxId: string | null;
}

export function StatusBadge({ status }: { status: "IN_PROGRESS" | "OK" | "NOK" }) {
  return <Badge tone={status === "OK" ? "ok" : status === "NOK" ? "nok" : "info"}>{status === "OK" ? "✔ OK" : status === "NOK" ? "✖ NON OK" : STATUS_LABELS.IN_PROGRESS}</Badge>;
}

export function HistoryView({ data, filters, openBoxId }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const withParams = React.useCallback(
    (changes: Record<string, string | null>) => {
      const p = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === "") p.delete(k);
        else p.set(k, v);
      }
      const qs = p.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [pathname, searchParams],
  );

  return (
    <div className="flex flex-col gap-4">
      <form method="get" action={pathname} className="grid gap-3 rounded-lg border-2 border-border bg-card p-4 md:grid-cols-[2fr_1fr_1fr_1fr_auto] md:items-end">
        <div className="flex flex-col gap-1">
          <Label htmlFor="q">Recherche (série boîte, série coiffe, PN, opérateur)</Label>
          <Input id="q" name="q" defaultValue={filters.q} placeholder="Ex. 10428865, 70166592310, L0028…, OP042" maxLength={64} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="status">Statut</Label>
          <Select id="status" name="status" defaultValue={filters.status}>
            <option value="ALL">Tous</option>
            <option value="IN_PROGRESS">En cours (contrôle ou correction)</option>
            <option value="OK">OK</option>
            <option value="NOK">NON OK</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="from">Du</Label>
          <Input id="from" name="from" type="date" defaultValue={filters.from} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="to">Au</Label>
          <Input id="to" name="to" type="date" defaultValue={filters.to} />
        </div>
        <Button type="submit">
          <Search /> Filtrer
        </Button>
      </form>

      <div className="overflow-x-auto rounded-lg border-2 border-border bg-card">
        <table className="w-full text-base">
          <thead className="bg-muted text-left">
            <tr>
              <th className="px-3 py-2">Début</th>
              <th className="px-3 py-2">Boîte</th>
              <th className="px-3 py-2">PN</th>
              <th className="px-3 py-2">Qté</th>
              <th className="px-3 py-2">Statut</th>
              <th className="px-3 py-2">Opérateur</th>
              <th className="px-3 py-2">Finalisée</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                  Aucune boîte pour ces filtres.
                </td>
              </tr>
            )}
            {data.rows.map((r) => (
              <tr
                key={r.id}
                tabIndex={0}
                className="cursor-pointer border-t border-border hover:bg-muted focus:bg-muted focus:outline-none"
                onClick={() => router.push(withParams({ box: r.id }), { scroll: false })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") router.push(withParams({ box: r.id }), { scroll: false });
                }}
              >
                <td className="px-3 py-2 tabular">{formatDateTime(r.createdAt)}</td>
                <td className="px-3 py-2 font-mono font-bold">{r.boxSerial}</td>
                <td className="px-3 py-2 font-mono">{r.partNumber}</td>
                <td className="px-3 py-2 tabular">
                  <b>
                    {r.counts.distinct} / {r.expectedQty}
                  </b>
                  <div className="text-xs">
                    {r.counts.conforming} conf. · {r.counts.nonconforming} non conf.
                  </div>
                </td>
                <td className="px-3 py-2">
                  <span className="flex flex-wrap items-center gap-1">
                    <StatusBadge status={r.status} />
                    {r.correctionActive && <Badge tone="warn">Correction en cours</Badge>}
                    {r.attemptCount > 1 && <span className="text-xs text-muted-foreground">{r.attemptCount} tentatives</span>}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono">{r.finalizedBy ?? r.createdBy}</td>
                <td className="px-3 py-2 tabular">{r.finalizedAt ? formatDateTime(r.finalizedAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">
          {data.total} boîte(s) — page {data.page} / {data.pageCount}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link aria-disabled={data.page <= 1} className={data.page <= 1 ? "pointer-events-none opacity-50" : ""} href={withParams({ page: String(data.page - 1), box: null })}>
              <ChevronLeft /> Précédente
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link aria-disabled={data.page >= data.pageCount} className={data.page >= data.pageCount ? "pointer-events-none opacity-50" : ""} href={withParams({ page: String(data.page + 1), box: null })}>
              Suivante <ChevronRight />
            </Link>
          </Button>
        </div>
      </div>

      <Dialog open={openBoxId !== null} onOpenChange={(open) => !open && router.push(withParams({ box: null }), { scroll: false })}>
        {openBoxId && <BoxDrawer key={openBoxId} boxId={openBoxId} />}
      </Dialog>
    </div>
  );
}
