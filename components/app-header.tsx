"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/client/api";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/controle", label: "Contrôle" },
    { href: "/imprimante", label: "Étiquette" },
  { href: "/diagnostic", label: "Diagnostic scan" },
];

export function AppHeader({ username, role }: { username: string; role: "OPERATOR" | "ADMIN" }) {
  const pathname = usePathname();
  const router = useRouter();
  const links = role === "ADMIN" ? [...LINKS, { href: "/admin", label: "Administration" }, { href: "/historique", label: "Historique" }, { href: "/admin/utilisateurs", label: "Utilisateurs" }] : LINKS;

  async function logout() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <header className="no-print sticky top-0 z-40 border-b-2 border-border bg-slate-900 text-white">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
        <span className="text-xl font-bold tracking-tight">GALIA Control</span>
        <nav className="flex flex-wrap gap-1" aria-label="Navigation principale">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "rounded-md px-3 py-2 text-base font-semibold hover:bg-white/10",
                pathname.startsWith(l.href) && "bg-white text-slate-900 hover:bg-white",
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-2 rounded-md bg-white/10 px-3 py-1.5 font-mono text-lg font-bold" data-testid="current-user">
            <UserRound className="size-5" aria-hidden /> {username}
            {role === "ADMIN" && <span className="rounded bg-warn px-1.5 text-xs font-bold text-black">ADMIN</span>}
          </span>
          <Button variant="outline" size="sm" className="border-white/40 bg-transparent text-white hover:bg-white/10" onClick={logout}>
            <LogOut /> Déconnexion
          </Button>
        </div>
      </div>
    </header>
  );
}
