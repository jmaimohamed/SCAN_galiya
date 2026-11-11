"use client";

import { useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/client/api";

/**
 * A4 fallback: records the request (audited), marks RÉIMPRESSION when it is not
 * the first one, then opens the browser print dialog. Opening the dialog does not
 * prove anything was printed.
 */
export function A4PrintButton({ reportId }: { reportId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function print() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<{ reprint: boolean }>(`/api/reports/${reportId}/a4-print`, { method: "POST" });
      document.getElementById("reprint-marker")?.classList.toggle("hidden", !r.reprint);
      window.print();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={print} disabled={busy}>
        <Printer /> Imprimer (A4)
      </Button>
      {error && <span className="self-center font-semibold text-nok">{error}</span>}
    </>
  );
}
