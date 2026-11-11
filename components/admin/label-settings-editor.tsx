"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export function AdminLabelSettings({ profile }: { profile: { workstationId: string; name: string; widthMm: number; heightMm: number } }) {
  const router = useRouter(); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null);
  return <form className="grid items-end gap-2 rounded-md border-2 bg-card p-4 md:grid-cols-5" onSubmit={async (e) => {
    e.preventDefault(); if (busy) return; const f = new FormData(e.currentTarget); setBusy(true);
    try { await apiFetch("/api/admin/settings", { method: "PATCH", body: { workstationId: profile.workstationId, name: String(f.get("name")), widthMm: Number(f.get("widthMm")), heightMm: Number(f.get("heightMm")), reason: String(f.get("reason")) } }); setMessage("Enregistré. Un changement de taille exige une nouvelle confirmation TEST sur ce poste."); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Erreur"); } finally { setBusy(false); }
  }}><label>Poste<Input name="name" defaultValue={profile.name} required maxLength={64} /></label><label>Largeur (mm)<Input name="widthMm" type="number" min={50} max={104} required defaultValue={profile.widthMm} /></label><label>Hauteur (mm)<Input name="heightMm" type="number" min={50} max={200} required defaultValue={profile.heightMm} /></label><label>Motif administratif<Input name="reason" required minLength={3} maxLength={500} /></label><Button disabled={busy}>Enregistrer</Button>{message && <p className="md:col-span-5" role="status">{message}</p>}<p className="break-all text-xs text-muted-foreground md:col-span-5">Profil navigateur {profile.workstationId}. L&apos;opérateur choisit toujours sa propre imprimante dans la fenêtre du navigateur.</p></form>;
}
