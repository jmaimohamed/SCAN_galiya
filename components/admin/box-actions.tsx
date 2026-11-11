"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/client/api";
import type { BoxDetail } from "@/lib/server/services/history";

type Action = { kind: "ITEM"; item: BoxDetail["items"][number] } | { kind: "RESET" | "IDENTITY" | "NOTES" };
export function AdminBoxActions({ box, item }: { box: BoxDetail; item?: BoxDetail["items"][number] }) {
  const router = useRouter();
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [serial, setSerial] = useState("");
  const [notes, setNotes] = useState(box.notes ?? "");
  const [galia, setGalia] = useState(box.galiaPayload);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  function open(next: Action) { setReason(""); setSerial(""); setError(null); setNotes(box.notes ?? ""); setGalia(box.galiaPayload); setAction(next); }
  async function submit() {
    if (!action || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      if (action.kind === "ITEM") await apiFetch(`/api/admin/boxes/${box.id}/void-item`, { body: { itemId: action.item.id, confirmSerial: serial, reason } });
      else if (action.kind === "NOTES") await apiFetch(`/api/admin/boxes/${box.id}`, { method: "PATCH", body: { notes, reason } });
      else await apiFetch(`/api/admin/boxes/${box.id}/reset`, { body: { confirmSerial: serial, expectedGeneration: box.generation, expectedAcceptedCount: box.acceptedQty, reason, ...(action.kind === "IDENTITY" ? { newGalia: galia } : {}) } });
      setAction(null); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Modification impossible."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const targetSerial = action?.kind === "ITEM" ? action.item.serial : box.boxSerial;
  const title = action?.kind === "ITEM" ? "Retirer cette coiffe des contenus actifs" : action?.kind === "NOTES" ? "Modifier la note administrative" : action?.kind === "IDENTITY" ? "Corriger la GALIA et réinitialiser le contrôle" : "Réinitialiser le contrôle";
  return <>
    {item ? !item.voidedAt && item.generation === box.generation && <Button size="sm" variant="outline" onClick={() => open({ kind: "ITEM", item })}>Retirer cette coiffe…</Button> : <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={() => open({ kind: "NOTES" })}>Modifier la note</Button><Button variant="outline" onClick={() => open({ kind: "IDENTITY" })}>Corriger la GALIA…</Button><Button variant="destructive" onClick={() => open({ kind: "RESET" })}>Réinitialiser le contrôle…</Button></div>}
    <Dialog open={!!action} onOpenChange={(value) => { if (!value && !busy) setAction(null); }}><DialogContent><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>Action réservée à un administrateur, enregistrée avec votre identité, la date, le motif et les valeurs avant/après.</DialogDescription></DialogHeader>
      <div className="flex flex-col gap-3"><p className="font-bold">Boîte {box.boxSerial} · PN {box.partNumber} · génération {box.generation} · {box.needsRecontrol ? "À recontrôler" : box.status} · {box.acceptedQty}/{box.expectedQty} coiffes actives.</p>
      {action?.kind === "ITEM" && <p>Coiffe PN {action.item.partNumber} · série <b>{action.item.serial}</b> · boîte source {box.boxSerial}. Son historique sera conservé comme annulé ; sa réservation sera libérée. Le résultat courant sera invalidé.</p>}
      {action && action.kind !== "NOTES" && <p className="rounded-md border-2 border-nok bg-nok-soft p-3 font-bold text-nok">{action.kind !== "ITEM" && `${box.acceptedQty} coiffe(s) seront libérées. Une nouvelle génération commencera à zéro ; les baux opérateurs seront révoqués. `}Retirer les anciennes étiquettes de la boîte : elles peuvent encore exister physiquement. Les rapports et demandes d&apos;impression restent dans l&apos;audit.</p>}
      {action?.kind === "IDENTITY" && <label>Nouvelle GALIA (PN, quantité et série validés ensemble)<Input value={galia} onChange={(e) => setGalia(e.target.value)} maxLength={128} /><span className="text-sm">La correction invalide explicitement le contrôle ; elle ne modifie aucun ancien rapport.</span></label>}
      {action?.kind === "NOTES" && <label>Note (aucun effet sur la vérification)<Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></label>}
      <label>Motif administratif obligatoire<Textarea value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} /></label>
      {action?.kind !== "NOTES" && <label>Saisir la série {targetSerial} pour confirmer<Input value={serial} onChange={(e) => setSerial(e.target.value)} autoComplete="off" /></label>}
      {error && <p role="alert" className="font-bold text-nok">{error}</p>}</div><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setAction(null)}>Annuler</Button><Button variant={action?.kind === "NOTES" ? "default" : "destructive"} disabled={busy || reason.trim().length < 3 || action?.kind !== "NOTES" && serial !== targetSerial} onClick={() => void submit()}>Confirmer</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}
