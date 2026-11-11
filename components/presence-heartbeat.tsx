"use client";
import { useEffect } from "react";
import { apiFetch } from "@/lib/client/api";
import { getWorkstationId } from "@/lib/client/workstation";

/** One ephemeral ID per mounted browser tab; no close event can log out another tab. */
export function PresenceHeartbeat() {
  useEffect(() => {
    const tabId = crypto.randomUUID();
    let boxId: string | null = null;
    let activity = true;
    let sending = false;
    let stopped = false;
    const touched = () => { if (document.visibilityState === "visible") activity = true; };
    const boxChanged = (event: Event) => { boxId = (event as CustomEvent<string | null>).detail; };
    const send = async () => {
      if (stopped || sending) return;
      sending = true;
      const active = activity;
      activity = false;
      try { await apiFetch("/api/presence", { body: { tabId, workstationId: getWorkstationId(), boxId, active } }); }
      catch { /* A failed heartbeat expires honestly; it is never shown as online indefinitely. */ }
      finally { sending = false; }
    };
    window.addEventListener("keydown", touched);
    window.addEventListener("pointerdown", touched);
    window.addEventListener("galia:active-box", boxChanged);
    const timer = window.setInterval(() => void send(), 20_000);
    void send();
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener("keydown", touched); window.removeEventListener("pointerdown", touched); window.removeEventListener("galia:active-box", boxChanged); };
  }, []);
  return null;
}
