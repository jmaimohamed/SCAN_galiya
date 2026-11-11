"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { parseScan } from "@/lib/barcode";
import { formatTime } from "@/lib/time";
import { ScanInput } from "./scan-input";

interface Entry {
  id: number;
  raw: string;
  at: number;
}

function visible(raw: string): string {
  return JSON.stringify(raw).slice(1, -1);
}

function codes(raw: string): string {
  return [...raw].map((c) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

/**
 * Shows exactly what the scanner typed (nothing is sent to the server). Used to
 * check the real DS2208 output — letters, digits, underscores, keyboard layout —
 * before production.
 */
export function ScanDiagnostic() {
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const seq = React.useRef(0);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Diagnostic du scanner (aucun enregistrement)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ScanInput id="diag-input" label="Scanner une étiquette pour voir le texte reçu" onScan={(raw) => setEntries((e) => [{ id: ++seq.current, raw, at: Date.now() }, ...e].slice(0, 50))} />
          <p className="text-sm text-muted-foreground">
            Attendu : boîte <span className="font-mono">PL002815593B96AG_Q20_S10428865</span>, coiffe <span className="font-mono">L002815593B96AG_S70166592310</span>. Des
            caractères comme « &amp; é &quot; &apos; ( è ç à ° » au lieu de chiffres ou du « _ » indiquent une disposition clavier différente entre scanner et Windows.
            Le bip du scanner signifie seulement « code lu ».
          </p>
          <Button variant="ghost" className="self-start" onClick={() => setEntries([])}>
            <Trash2 /> Effacer
          </Button>
        </CardContent>
      </Card>
      {entries.map((e) => {
        const parsed = parseScan(e.raw);
        return (
          <Card key={e.id}>
            <CardContent className="flex flex-col gap-2 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular text-muted-foreground">{formatTime(e.at)}</span>
                {parsed.kind === "BOX" && <Badge tone="ok">Étiquette GALIA boîte</Badge>}
                {parsed.kind === "ITEM" && <Badge tone="ok">Étiquette coiffe</Badge>}
                {parsed.kind === "ERROR" && <Badge tone="nok">{parsed.message}</Badge>}
                <span className="text-sm">{[...e.raw].length} caractère(s)</span>
              </div>
              <div className="break-all rounded bg-muted p-2 font-mono text-xl">{visible(e.raw)}</div>
              <div className="break-all font-mono text-xs text-muted-foreground">{codes(e.raw)}</div>
              {parsed.kind === "BOX" && (
                <div className="font-mono">
                  PN {parsed.partNumber} · Qté {parsed.quantity} · Série boîte {parsed.boxSerial}
                </div>
              )}
              {parsed.kind === "ITEM" && (
                <div className="font-mono">
                  PN {parsed.partNumber} · Série {parsed.serial}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
