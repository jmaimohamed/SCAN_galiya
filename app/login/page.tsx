import { redirect } from "next/navigation";
import { getCurrentActor } from "@/lib/server/auth/current";
import { LoginForm } from "./login-form";

export const metadata = { title: "Connexion — GALIA Control" };

export default async function LoginPage() {
  if (await getCurrentActor()) redirect("/controle");
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border-2 border-border bg-card p-8 shadow-sm">
        <h1 className="text-3xl font-bold">GALIA Control</h1>
        <p className="mt-1 text-muted-foreground">Contrôle des boîtes de coiffes</p>
        <LoginForm />
      </div>
    </main>
  );
}
