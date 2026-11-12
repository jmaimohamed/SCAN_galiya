"use client";

import { clientUuid } from "@/lib/client/uuid";

import * as React from "react";
import { CheckCircle2, CircleAlert, Printer, Save, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/client/api";
import { openLabelPrintDialog } from "@/lib/client/label-print";
import { useWorkstationId } from "@/lib/client/workstation";
import { formatDateTime } from "@/lib/time";
import { PrintDialogHelp } from "@/components/print/print-panel";
import { LABEL_LIMITS, PRINTHEAD_MAX_MM, testRulerMm, type Orientation, type ContentPosition } from "@/lib/zpl/layout";
import type { PrinterProfileDto, PrintJobDto } from "@/lib/server/services/printing";

type Msg = { tone: "ok" | "nok" | "warn" | "info"; text: string } | null;
const tones = { ok: "border-ok bg-ok-soft text-ok", nok: "border-nok bg-nok-soft text-nok", warn: "border-warn bg-warn-soft text-black", info: "border-border bg-muted" } as const;

function Note({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return <p className={`rounded-md border-2 p-3 font-semibold ${tones[msg.tone]}`} role="status">{msg.text}</p>;
}

const ORIENTATION_LABELS: Record<Orientation, string> = { LANDSCAPE: "paysage (pilote)", ROTATE_90: "paysage 90° (application)", NONE: "portrait" };

/**
 * « Étiquette de ce poste »: label stock and orientation per browser/workstation
 * profile, a TEST label and printing instructions. The printer is NOT chosen
 * here: each operator selects the ZD421 of their PC in the browser print dialog.
 */
export function PrinterSettings() {
  const ws = useWorkstationId();
  const [profile, setProfile] = React.useState<PrinterProfileDto | null>(null);
  const [form, setForm] = React.useState<{ name: string; widthMm: number; printableWidthMm: number | null; heightMm: number; orientation: Orientation; contentPosition: ContentPosition; contentLengthMm: number | null }>({ name: "", widthMm: 110, printableWidthMm: PRINTHEAD_MAX_MM, heightMm: 400, orientation: "ROTATE_90", contentPosition: "CENTER", contentLengthMm: null });
  const [preview, setPreview] = React.useState<{ svg: string; pageSvg: string } | null>(null);
  const [checked, setChecked] = React.useState(false);
  const [testOpened, setTestOpened] = React.useState(false);
  const [msg, setMsg] = React.useState<Msg>(null);
  const [busy, setBusy] = React.useState(false);
  const testKey = React.useRef<string | null>(null);
  const inFlight = React.useRef(false);

  const applyProfile = React.useCallback((id: string, p: PrinterProfileDto | null) => {
    setProfile(p);
    if (!p) return;
    setForm({ name: p.name, widthMm: p.widthMm, printableWidthMm: p.printableWidthMm, heightMm: p.heightMm, orientation: p.orientation, contentPosition: p.contentPosition, contentLengthMm: p.contentLengthMm });
    apiFetch<{ svg: string; pageSvg: string }>(`/api/printer-profile/test-preview?workstationId=${id}`)
      .then((r) => setPreview({ svg: r.svg, pageSvg: r.pageSvg }))
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
        body: { workstationId: ws, name: form.name.trim() || "Poste sans nom", widthMm: Number(form.widthMm), printableWidthMm: form.printableWidthMm, heightMm: Number(form.heightMm), orientation: form.orientation, contentPosition: form.contentPosition, contentLengthMm: form.contentLengthMm },
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
    testKey.current ??= clientUuid();
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

  const dirty =
    !!profile && (profile.widthMm !== Number(form.widthMm) || profile.printableWidthMm !== form.printableWidthMm || profile.heightMm !== Number(form.heightMm) || profile.name !== form.name || profile.orientation !== form.orientation || profile.contentPosition !== form.contentPosition || profile.contentLengthMm !== form.contentLengthMm);
  const rulerMm = testRulerMm({ widthMm: Number(form.widthMm), printableWidthMm: form.printableWidthMm, heightMm: form.contentLengthMm ?? Number(form.heightMm), orientation: form.orientation });
  const landscape = form.orientation === "LANDSCAPE";

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
              <Label htmlFor="w">Largeur du rouleau — en travers de la tête (mm)</Label>
              <Input id="w" type="number" min={LABEL_LIMITS.widthMinMm} max={LABEL_LIMITS.widthMaxMm} value={form.widthMm} onChange={(e) => setForm({ ...form, widthMm: Number(e.target.value) })} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="h">Longueur de l&apos;étiquette — sens de sortie (mm)</Label>
              <Input id="h" type="number" min={LABEL_LIMITS.heightMinMm} max={LABEL_LIMITS.heightMaxMm} value={form.heightMm} onChange={(e) => setForm({ ...form, heightMm: Number(e.target.value) })} />
            </div>
            <fieldset className="flex flex-col gap-1 sm:col-span-2">
              <legend className="text-sm font-semibold">Sens de lecture</legend>
              <label className="flex items-start gap-2">
                <input type="radio" name="orientation" className="mt-1 size-4" checked={form.orientation === "LANDSCAPE"} onChange={() => setForm({ ...form, orientation: "LANDSCAPE" })} />
                <span>
                  <b>Paysage — rotation par le pilote</b> (ancien mode) : le texte occupe toute la longueur ({form.heightMm} mm) ; la page est envoyée en paysage et le
                  pilote Windows la tourne une seule fois.
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="orientation" className="mt-1 size-4" checked={form.orientation === "ROTATE_90"} onChange={() => setForm({ ...form, orientation: "ROTATE_90" })} />
                <span>
                  <b>Paysage plein format — page au format du rouleau</b> (recommandé) : page {form.widthMm} × {form.heightMm} mm en Portrait, texte lu à l&apos;horizontale.
                  L&apos;application tourne le contenu une fois ; aucune rotation dans le pilote.
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="orientation" className="mt-1 size-4" checked={form.orientation === "NONE"} onChange={() => setForm({ ...form, orientation: "NONE" })} />
                <span>
                  <b>Portrait</b> : texte dans la largeur, sans rotation.
                </span>
              </label>
            </fieldset>
            <fieldset className="flex flex-col gap-2 rounded-md border-2 border-border p-3 sm:col-span-2">
              <legend className="px-1 text-sm font-bold">Occupation et position sur le papier</legend>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1 size-5" checked={form.printableWidthMm === null} onChange={(e) => setForm({ ...form, printableWidthMm: e.target.checked ? null : PRINTHEAD_MAX_MM })} />
                <span><b>Utiliser toute la largeur du papier ({form.widthMm} mm)</b> — agrandir le contenu vers les deux côtés, avec une marge de sécurité de 1,5 mm.</span>
              </label>
              {form.printableWidthMm !== null && <div className="flex flex-col gap-1">
                <Label htmlFor="printable-width">Largeur imprimable maximale (mm)</Label>
                <Input id="printable-width" type="number" min={LABEL_LIMITS.widthMinMm} max={LABEL_LIMITS.widthMaxMm} value={form.printableWidthMm} onChange={(e) => setForm({ ...form, printableWidthMm: Number(e.target.value) })} />
                <p className="text-sm text-muted-foreground">La zone est centrée et ne dépasse jamais le papier. Réglage ZD421 203 dpi habituel : {PRINTHEAD_MAX_MM} mm.</p>
              </div>}
              {(form.printableWidthMm === null ? form.widthMm : Math.min(form.widthMm, form.printableWidthMm)) > PRINTHEAD_MAX_MM && <p className="rounded-md border-2 border-warn bg-warn-soft p-3 text-sm font-semibold" role="status">
                Largeur personnalisée : vérifier que l&apos;imprimante et le pilote peuvent l&apos;imprimer. La ZD421 203 dpi imprime au maximum {PRINTHEAD_MAX_MM} mm ; au-delà, les côtés peuvent être coupés. Mesurer le TEST et vérifier les deux cadres avant de confirmer.
              </p>}
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1 size-5" checked={form.contentLengthMm === null} onChange={(e) => setForm({ ...form, contentLengthMm: e.target.checked ? null : Math.min(210, form.heightMm) })} />
                <span><b>Utiliser toute la longueur du papier ({form.heightMm} mm)</b> — recommandé pour remplir l&apos;étiquette.</span>
              </label>
              {form.contentLengthMm !== null && <div className="flex flex-col gap-1">
                <Label htmlFor="content-length">Longueur de la zone imprimée (mm)</Label>
                <Input id="content-length" type="number" min={50} max={form.heightMm} value={form.contentLengthMm} onChange={(e) => setForm({ ...form, contentLengthMm: Number(e.target.value) })} />
              </div>}
              <Label htmlFor="content-position">Position dans le sens de sortie du papier</Label>
              <Select id="content-position" value={form.contentPosition} onChange={(e) => setForm({ ...form, contentPosition: e.target.value as ContentPosition })}>
                <option value="TOP">En haut — début de l&apos;étiquette</option><option value="CENTER">Au centre</option><option value="BOTTOM">En bas — fin de l&apos;étiquette</option>
              </Select>
              <p className="text-sm text-muted-foreground">La position déplace une zone plus courte sur la feuille. En plein format, elle occupe déjà toute la longueur. Le QR reste carré et les dimensions restent réelles.</p>
            </fieldset>
          </div>
          <p className="text-sm text-muted-foreground">
            <b>Largeur</b> = largeur du papier en travers de la tête. Valeur personnalisée de {LABEL_LIMITS.widthMinMm} à {LABEL_LIMITS.widthMaxMm} mm ; ce plafond logiciel n&apos;est pas une capacité de l&apos;imprimante.{" "}
            <b>Longueur</b> = longueur d&apos;une étiquette dans le sens où elle sort (ex. 210 mm, jusqu&apos;à {LABEL_LIMITS.heightMaxMm} mm).
            Mesurer le papier réel : augmenter ces valeurs sans changer le papier ne corrige pas une réduction à l&apos;impression.
          </p>
          <Button variant="outline" onClick={() => { setForm({ ...form, widthMm: 110, heightMm: 210, orientation: "ROTATE_90", contentPosition: "CENTER", contentLengthMm: null }); setChecked(false); setTestOpened(false); setMsg({ tone: "info", text: "Format rouleau 110 × 210 mm sélectionné. Enregistrer, puis imprimer un nouveau TEST en Portrait, à 100 %." }); }} disabled={busy} className="self-start">Utiliser le rouleau 110 × 210 mm — plein format</Button>
          <Button variant="outline" onClick={() => { setForm({ ...form, widthMm: 110, heightMm: 400, orientation: "ROTATE_90", contentPosition: "CENTER", contentLengthMm: null }); setChecked(false); setTestOpened(false); setMsg({ tone: "info", text: "Format 110 × 400 mm sélectionné, impression sur toute la longueur. Mesurer le papier, enregistrer puis imprimer le TEST à 100 %." }); }} disabled={busy} className="self-start">Utiliser le rouleau 110 × 400 mm — plein format</Button>
          <Button onClick={() => void save()} disabled={busy || (!dirty && !!profile)} className="self-start">
            <Save /> Enregistrer
          </Button>
          <div className="flex items-center gap-2 font-bold" data-testid="label-confirmation">
            {profile?.confirmedAt ? <CheckCircle2 className="text-ok" /> : <CircleAlert className="text-nok" />}
            {profile?.confirmedAt ? (
              <span>
                Confirmée par {profile.confirmedBy} le {formatDateTime(profile.confirmedAt)}{" "}
                <Badge tone="ok">
                  {profile.widthMm} × {profile.heightMm} mm · {ORIENTATION_LABELS[profile.orientation]}
                </Badge>
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
          {preview && !dirty && (
            <figure className="flex flex-col items-center gap-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="Aperçu de l'étiquette test" className="max-h-72 w-full object-contain border border-border" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.svg)}`} />
              <figcaption className="text-sm text-muted-foreground">Aperçu : étiquette lue {profile?.orientation === "NONE" ? "en portrait" : "tenue à l'horizontale"} (flèche HAUT en haut)</figcaption>
            </figure>
          )}
          {preview && !dirty && <figure className="flex flex-col items-center gap-1 rounded-md bg-muted p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="Position sur toute la feuille, dans le sens de sortie" className="max-h-96 max-w-full border-2 border-border bg-white" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.pageSvg)}`} />
            <figcaption className="text-center text-sm">Papier complet enregistré : {profile?.widthMm} × {profile?.heightMm} mm — zone {profile?.contentLengthMm ?? profile?.heightMm} mm,
              position {profile?.contentPosition === "TOP" ? "en haut" : profile?.contentPosition === "BOTTOM" ? "en bas" : "au centre"}, largeur utilisée {profile ? Math.min(profile.widthMm, profile.printableWidthMm ?? profile.widthMm) : "—"} mm. Le blanc représente le papier laissé libre.</figcaption>
          </figure>}
          {profile && !profile.confirmedAt && !dirty && (
            <div className="flex flex-col gap-2 rounded-md border-2 border-border p-3">
              {!testOpened && <p className="text-sm">Imprimer d&apos;abord l&apos;étiquette TEST et la vérifier.</p>}
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1 size-5" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                <span>
                  L&apos;étiquette TEST est sortie <b>seule et en entier</b> sur la ZD421 de ce poste ({profile.widthMm} × {profile.heightMm} mm) : le texte{" "}
                  <b>occupe la zone choisie à la bonne position, sans date, adresse du site ni numéro de page ajoutés par le navigateur</b> et se lit {profile.orientation === "NONE" ? "en portrait" : "étiquette tenue à l'horizontale"} (flèche HAUT en haut), les deux
                  cadres sont complets, la barre mesure exactement <b>{rulerMm} mm</b> (échelle 100 %), le QR est net et aucune étiquette blanche n&apos;a suivi.
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
                Paramètres Windows → Imprimantes → ZD421 → <b>Options d&apos;impression</b> → Papier : format <b>largeur {form.widthMm} mm × hauteur {form.heightMm} mm</b>{" "}
                (le rouleau tel qu&apos;il sort), 203 dpi, type de support (étiquettes avec espace / marque noire), méthode (thermique direct ou transfert), vitesse et
                noirceur. Si le pilote refuse {form.widthMm} mm, mettre {PRINTHEAD_MAX_MM} mm <b>ici et dans l&apos;application</b> (même valeur partout).
              </li>
              <li>
                {landscape
                  ? "Paysage : l'application envoie une page paysage, le pilote la tourne une fois. Ne cocher aucune autre rotation. Si le texte sort à l'envers, cocher « Rotation 180° » dans le pilote."
                  : "Orientation Portrait, rotation 0° : ne cocher ni « Paysage » ni « Rotation 180° »."}
              </li>
              <li>Faire l&apos;étalonnage du support depuis l&apos;imprimante ou le pilote si l&apos;étiquette se décale.</li>
            </ol>
          </div>
          <div>
            <h3 className="mb-1 font-bold">2. À chaque impression — fenêtre d&apos;impression</h3>
            <p className="mb-3 rounded-md border-2 border-warn bg-warn-soft p-3 text-sm font-semibold">Si l&apos;étiquette est petite avec beaucoup de blanc : vérifier le format du papier dans le pilote ET le navigateur, choisir 100 % / taille réelle (pas « Ajuster »), puis désactiver les en-têtes et pieds de page. La barre TEST doit mesurer exactement 50 mm. Le site ne peut pas imposer ces options au navigateur.</p>
            <PrintDialogHelp widthMm={form.widthMm} heightMm={form.heightMm} orientation={form.orientation} />
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
