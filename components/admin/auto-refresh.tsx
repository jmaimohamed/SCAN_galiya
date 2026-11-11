"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
export function AdminAutoRefresh() {
  const router = useRouter();
  useEffect(() => { const timer = window.setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, 15_000); return () => window.clearInterval(timer); }, [router]);
  return <p className="text-sm text-muted-foreground">Actualisation automatique toutes les 15 secondes. La présence reflète les signaux du navigateur, pas une simple connexion enregistrée.</p>;
}
