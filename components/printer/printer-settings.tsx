"use client";

import * as React from "react";
import { CheckCircle2, CircleAlert, Printer, Save, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/client/api";
import { openLabelPrintDialog } from "@/lib/client/label-print";
import { useWorkstationId } from "@/lib/client/workstation";
import { formatDateTime } from "@/lib/time";
import { PrintDialogHelp } from "@/components/print/print-panel";
import type { PrinterProfileDto, PrintJobDto } from "@/lib/server/services/printing";

type Msg = { tone: "ok" | "nok" | "warn" | "info"; text: string } | null;
const tones = { ok: "border-ok bg-ok-soft text-ok", nok: "border-nok bg-nok-soft text-nok", warn: "border-warn bg-warn-soft text-black", info: "border-border bg-muted" } as const;

function Note({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return <p className={`rounded-md border-2 p-3 font-semibold ${tones[msg.tone]}`} role="status">{msg.text}</p>;
}

/**
 * « Étiquette de ce poste »: label size per browser/workstation profile, a TEST
 * label and printing instructions. The printer is NOT chosen here: each operator
 * selects the ZD421 of their PC in the browser print dialog.
 */
export function PrinterSettings() {
  const ws = useWorkstationId();
  const [profile, setProfile] = React.useState<PrinterProfileDto | null>(null);
  const [form, setForm] = React.useState({ name: "", widthMm: 100, heightMm: 100 });
  const [preview, setPreview] = React.useState<string | null>(null);
  const [checked, setChecked] = React.useState(false);
  const [testOpened, setTestOpened] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);
  const [busy, setBusy] = React.useState(false);
  const testKey = React.useRef<string | null>(null);
  const inFlight = React.useRef(false);

  const applyProfile = React.useCallback((id: string, p: PrinterProfileDto | null) => {
    setProfile(p);
    if (!p) return;
    setForm({ name: p.name, widthMm: p.widthMm, heightMm: p.heightMm });
    apiFetch<{ svg: string }>(`/api/printer-profile/test-preview?workstationId=${id}`)
      .then((r) => setPreview(r.svg))
      .catch(() => setPreview(null));
  }, []);

  React.useEffect(() => {
    if (!ws) return;
    apiFetch<{ profile: PrinterProfileDto | null }>(`/api/printer-profile?workstationId=${ws}`)
      .then((r) => applyProfile(ws, r.profile))
      .catch(() => undefined);
  }, [ws, applyProfile]);

  async function save() {
    if (!ws) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ profile: PrinterProfileDto }>("/api/printer-profile", {
        method: "PUT",
        body: { workstationId: ws, name: form.name.trim() || "Poste sans nom", widthMm: Number(form.widthMm), heightMm: Number(form.heightMm) },
      });
      applyProfile(ws, r.profile);
      setChecked(false);
      setTestOpened(false);
      setMsg({ tone: r.profile.confirmedAt ? "ok" : "warn", text: r.profile.confirmedAt ? "Enregistré." : "Enregistré pour ce poste. Imprimer une étiquette TEST puis confirmer." });
    } catch (e) {
      setMsg({ tone: "nok", text: e instanceof ApiError ? e.message : "Enregistrement impossible." });
    } finally {
      setBusy(false);
    }
  }

  async function testPrint() {
    if (!ws || busy || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    testKey.current ??= crypto.randomUUID();
    try {
      const { job } = await apiFetch<{ job: PrintJobDto }>("/api/print-jobs", {
        body: { idempotencyKey: testKey.current, kind: "TEST", reportId: null, workstationId: ws, reprintReason: null },
      });
      testKey.current = null;
      await openLabelPrintDialog(job.id, job.widthMm, job.heightMm);
      setTestOpened(true);
      setMsg({ tone: "info", text: "Fenêtre d'impression demandée pour l'étiquette TEST. Choisir la ZD421 de ce poste, puis vérifier l'étiquette sortie (le logiciel ne peut pas savoir si elle a été imprimée)." });
    } catch (e) {
      if (!(e instanceof Error && e.name === "NetworkError")) testKey.current = null;
      setMsg({ tone: "nok", text: e instanceof Error ? e.message : "Échec du test." });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function confirm() {
    if (!ws) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ profile: PrinterProfileDto }>("/api/printer-profile/confirm", { body: { workstationId: ws, labelChecked: checked } });
      setProfile(r.profile);
      setMsg({ tone: "ok", text: "Taille d'étiquette confirmée : impression des étiquettes autorisée sur ce poste." });
    } catch (e) {
      setMsg({ tone: "nok", text: e instanceof ApiError ? e.message : "Confirmation impossible." });
    } finally {
      setBusy(false);
    }
  }

  const dirty = !!profile && (profile.widthMm !== Number(form.widthMm) || profile.heightMm !== Number(form.heightMm) || profile.name !== form.name);
  const rulerMm = Math.min(50, Math.floor((Number(form.widthMm) - 10) / 10) * 10);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Étiquette de ce poste</CardTitle>
          <p className="text-sm text-muted-foreground">
            Réglage propre à ce PC et à ce navigateur. Effacer les données du navigateur ou changer de profil/navigateur impose de refaire ce réglage.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor="ws-name">Nom du poste</Label>
              <Input id="ws-name" value={form.name} maxLength={64} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex. POSTE-CONTROLE-1" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="w">Largeur de l&apos;étiquette (mm)</Label>
              <Input id="w" type="number" min={50} max={104} value={form.widthMm} onChange={(e) => setForm({ ...form, widthMm: Number(e.target.value) })} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="h">Hauteur de l&apos;étiquette (mm)</Label>
              <Input id="h" type="number" min={50} max={200} value={form.heightMm} onChange={(e) => setForm({ ...form, heightMm: Number(e.target.value) })} />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">100 × 100 mm n&apos;est qu&apos;une valeur de départ : mesurer l&apos;étiquette réelle (largeur × hauteur, sans le support).</p>
          <Button onClick={() => void save()} disabled={busy || (!dirty && !!profile)} className="self-start">
            <Save /> Enregistrer
          </Button>
          <div className="flex items-center gap-2 font-bold" data-testid="label-confirmation">
            {profile?.confirmedAt ? <CheckCircle2 className="text-ok" /> : <CircleAlert className="text-nok" />}
            {profile?.confirmedAt ? (
              <span>
                Confirmée par {profile.confirmedBy} le {formatDateTime(profile.confirmedAt)} <Badge tone="ok">{profile.widthMm} × {profile.heightMm} mm</Badge>
              </span>
            ) : (
              "Non confirmée : impression des étiquettes bloquée sur ce poste."
            )}
          </div>
          <Note msg={msg} />
          {!ws && <Note msg={{ tone: "nok", text: "Stockage local indisponible : impossible d'identifier ce poste (mode privé ?)." }} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Étiquette TEST et confirmation</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button size="lg" variant="outline" onClick={testPrint} disabled={busy || !profile || dirty} data-testid="test-print">
            <Printer /> Imprimer une étiquette TEST
          </Button>
          {(!profile || dirty) && <p className="text-sm text-muted-foreground">Enregistrer d&apos;abord la taille d&apos;étiquette.</p>}
          {preview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img alt="Aperçu de l'étiquette test" className="mx-auto max-h-72 border border-border" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview)}`} />
          )}
          {profile && !profile.confirmedAt && !dirty && (
            <div className="flex flex-col gap-2 rounded-md border-2 border-border p-3">
              {!testOpened && <p className="text-sm">Imprimer d&apos;abord l&apos;étiquette TEST et la vérifier.</p>}
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1 size-5" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                <span>
                  L&apos;étiquette TEST est sortie <b>entière</b> sur la ZD421 de ce poste ({profile.widthMm} × {profile.heightMm} mm, cadre complet) et la règle mesure
                  exactement <b>{rulerMm} mm</b> (échelle 100 %).
                </span>
              </label>
              <p className="text-sm text-muted-foreground">Confirmation déclarée par l&apos;opérateur : le logiciel ne vérifie ni l&apos;imprimante choisie ni la sortie papier.</p>
              <Button onClick={confirm} disabled={busy || !checked || !testOpened} className="self-start">
                <ShieldCheck /> Confirmer la taille d&apos;étiquette
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle>Comment imprimer (fenêtre d&apos;impression du navigateur)</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="mb-1 font-bold">1. Une fois par poste — pilote Windows ZD421</h3>
            <ol className="list-decimal pl-5 text-sm">
              <li>Installer le pilote Zebra « ZDesigner » de la ZD421, puis brancher l&apos;imprimante en USB.</li>
              <li>
                Paramètres Windows → Imprimantes → ZD421 → <b>Options d&apos;impression</b> : créer/choisir le format d&apos;étiquette <b>{form.widthMm} × {form.heightMm} mm</b>
                , type de support (étiquettes avec espace / marque noire), méthode (thermique direct ou transfert), vitesse et noirceur.
              </li>
              <li>Faire l&apos;étalonnage du support depuis l&apos;imprimante ou le pilote si l&apos;étiquette se décale.</li>
            </ol>
          </div>
          <div>
            <h3 className="mb-1 font-bold">2. À chaque impression — fenêtre d&apos;impression</h3>
            <PrintDialogHelp widthMm={form.widthMm} heightMm={form.heightMm} />
            <p className="mt-2 text-sm text-muted-foreground">
              Le site ne choisit jamais l&apos;imprimante : c&apos;est l&apos;opérateur qui sélectionne la ZD421 de son poste. Chrome/Edge proposent ensuite la dernière
              imprimante utilisée — toujours vérifier avant d&apos;imprimer. L&apos;ouverture de la fenêtre ne prouve pas que l&apos;étiquette est sortie.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
