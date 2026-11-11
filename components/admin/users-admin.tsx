"use client";

import * as React from "react";
import { KeyRound, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/client/api";
import { formatDateTime } from "@/lib/time";
import type { UserDto } from "@/lib/server/services/users";

export function UsersAdmin({ currentUserId, initialUsers }: { currentUserId: string; initialUsers: UserDto[] }) {
  const [reason, setReason] = React.useState("");
  const [users, setUsers] = React.useState(initialUsers);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [resetFor, setResetFor] = React.useState<UserDto | null>(null);
  const [editFor, setEditFor] = React.useState<UserDto | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function reload() {
    const r = await apiFetch<{ users: UserDto[] }>("/api/admin/users");
    setUsers(r.users);
  }

  async function run(action: () => Promise<unknown>, ok: string) {
    if (reason.trim().length < 3) { setMsg({ ok: false, text: "Saisir un motif administratif (3 caractères minimum)." }); return false; }
    setBusy(true);
    try {
      await action();
      await reload();
      setMsg({ ok: true, text: ok });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "Action impossible." });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const f = new FormData(formEl);
    if (f.get("password") !== f.get("confirm")) {
      setMsg({ ok: false, text: "Les mots de passe ne correspondent pas." });
      return;
    }
    const done = await run(
      () =>
        apiFetch("/api/admin/users", {
          body: {
            reason,
            username: String(f.get("username") ?? ""),
            displayName: String(f.get("displayName") ?? "") || null,
            role: String(f.get("role")),
            password: String(f.get("password") ?? ""),
          },
        }),
      "Utilisateur créé.",
    );
    if (done) formEl.reset();
  }

  async function resetPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!resetFor) return;
    const f = new FormData(e.currentTarget);
    if (f.get("password") !== f.get("confirm")) {
      setMsg({ ok: false, text: "Les mots de passe ne correspondent pas." });
      return;
    }
    const done = await run(() => apiFetch(`/api/admin/users/${resetFor.id}/password`, { body: { reason, password: String(f.get("password") ?? "") } }), `Mot de passe de ${resetFor.username} modifié (sessions fermées).`);
    if (done) setResetFor(null);
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_2fr]">
      <label className="xl:col-span-2 rounded-lg border-2 bg-card p-4 font-bold">Motif administratif obligatoire pour toute modification<Input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} placeholder="Création de compte, changement d’affectation…" /></label>
      <Card>
        <CardHeader>
          <CardTitle>Nouvel utilisateur</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="flex flex-col gap-3" autoComplete="off">
            <div className="flex flex-col gap-1">
              <Label htmlFor="u">Identifiant utilisateur</Label>
              <Input id="u" name="username" required minLength={2} maxLength={32} placeholder="Ex. OP042" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="d">Nom affiché (optionnel)</Label>
              <Input id="d" name="displayName" maxLength={80} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="r">Rôle</Label>
              <Select id="r" name="role" defaultValue="OPERATOR">
                <option value="OPERATOR">Opérateur</option>
                <option value="ADMIN">Administrateur</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="p">Mot de passe initial (8 caractères min.)</Label>
              <Input id="p" name="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="c">Confirmer</Label>
              <Input id="c" name="confirm" type="password" required minLength={8} maxLength={128} autoComplete="new-password" />
            </div>
            <Button type="submit" disabled={busy}>
              <UserPlus /> Créer
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Utilisateurs ({users.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {msg && <p className={`rounded-md p-2 font-semibold ${msg.ok ? "bg-ok-soft text-ok" : "bg-nok-soft text-nok"}`}>{msg.text}</p>}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="text-left">
                <tr className="border-b-2 border-border">
                  <th className="py-2 pr-2">Identifiant</th>
                  <th className="py-2 pr-2">Rôle</th>
                  <th className="py-2 pr-2">État</th>
                  <th className="py-2 pr-2">Dernière connexion</th>
                  <th className="py-2 pr-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-border">
                    <td className="py-2 pr-2">
                      <span className="font-mono font-bold">{u.username}</span>
                      {u.displayName && <div className="text-sm text-muted-foreground">{u.displayName}</div>}
                    </td>
                    <td className="py-2 pr-2">
                      <Select
                        aria-label={`Rôle de ${u.username}`}
                        value={u.role}
                        disabled={busy || u.id === currentUserId}
                        onChange={(e) => void run(() => apiFetch(`/api/admin/users/${u.id}`, { method: "PATCH", body: { reason, role: e.target.value } }), "Rôle modifié (sessions fermées).")}
                        className="h-9"
                      >
                        <option value="OPERATOR">Opérateur</option>
                        <option value="ADMIN">Administrateur</option>
                      </Select>
                    </td>
                    <td className="py-2 pr-2">{u.active ? <Badge tone="ok">Actif</Badge> : <Badge tone="neutral">Désactivé</Badge>}</td>
                    <td className="py-2 pr-2 tabular">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "—"}</td>
                    <td className="flex flex-wrap gap-2 py-2 pr-2">
                      <Button
                        size="sm"
                        variant={u.active ? "outline" : "secondary"}
                        disabled={busy || u.id === currentUserId}
                        onClick={() => void run(() => apiFetch(`/api/admin/users/${u.id}`, { method: "PATCH", body: { reason, active: !u.active } }), u.active ? "Utilisateur désactivé (sessions fermées)." : "Utilisateur réactivé.")}
                      >
                        {u.active ? "Désactiver" : "Réactiver"}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setResetFor(u)}>
                        <KeyRound /> Mot de passe
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditFor(u)}>Nom affiché</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={editFor !== null} onOpenChange={(o) => !o && setEditFor(null)}><DialogContent><DialogHeader><DialogTitle>Nom affiché — {editFor?.username}</DialogTitle><DialogDescription>Le motif administratif saisi en haut de la page sera enregistré dans l&apos;audit.</DialogDescription></DialogHeader><form className="flex flex-col gap-3" onSubmit={async (e) => { e.preventDefault(); if (!editFor) return; const form = new FormData(e.currentTarget); const ok = await run(() => apiFetch(`/api/admin/users/${editFor.id}`, { method: "PATCH", body: { displayName: String(form.get("displayName") ?? "") || null, reason } }), "Nom affiché modifié."); if (ok) setEditFor(null); }}><label>Nom affiché<Input name="displayName" maxLength={80} defaultValue={editFor?.displayName ?? ""} /></label><DialogFooter><Button type="button" variant="outline" onClick={() => setEditFor(null)}>Annuler</Button><Button disabled={busy || reason.trim().length < 3}>Enregistrer</Button></DialogFooter></form></DialogContent></Dialog>

      <Dialog open={resetFor !== null} onOpenChange={(o) => !o && setResetFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nouveau mot de passe — {resetFor?.username}</DialogTitle>
            <DialogDescription>Les sessions ouvertes de cet utilisateur seront fermées.</DialogDescription>
          </DialogHeader>
          <form onSubmit={resetPassword} className="flex flex-col gap-3" autoComplete="off">
            <Input name="password" type="password" required minLength={8} maxLength={128} placeholder="Nouveau mot de passe" autoComplete="new-password" />
            <Input name="confirm" type="password" required minLength={8} maxLength={128} placeholder="Confirmer" autoComplete="new-password" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setResetFor(null)}>
                Annuler
              </Button>
              <Button type="submit" disabled={busy}>
                Enregistrer
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
