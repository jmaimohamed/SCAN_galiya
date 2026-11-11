"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/client/api";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      await apiFetch("/api/auth/login", { body: { username: String(form.get("username") ?? ""), password: String(form.get("password") ?? "") } });
      router.replace("/controle");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Serveur injoignable. Vérifier la connexion.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="username">Identifiant utilisateur</Label>
        <Input id="username" name="username" autoComplete="username" autoCapitalize="characters" required autoFocus maxLength={32} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Mot de passe</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required maxLength={128} />
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-nok-soft px-3 py-2 font-semibold text-nok">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending}>
        <LogIn /> {pending ? "Connexion…" : "Se connecter"}
      </Button>
    </form>
  );
}
