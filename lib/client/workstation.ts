"use client";

import { clientUuid } from "@/lib/client/uuid";

import { useSyncExternalStore } from "react";

/**
 * Workstation reference: a random id kept in this browser's localStorage. It
 * only selects which printer profile (stored in PostgreSQL) this PC uses — it is
 * not an identity and grants nothing.
 */
const KEY = "galia.workstationId";

export function getWorkstationId(): string | null {
  try {
    let id = window.localStorage.getItem(KEY);
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      id = clientUuid();
      window.localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

const noSubscription = () => () => undefined;

/** Read a browser-only value without an effect (null/fallback during server rendering). */
export function useBrowserValue<T>(read: () => T, serverValue: T): T {
  return useSyncExternalStore(noSubscription, read, () => serverValue);
}

export function useWorkstationId(): string | null {
  return useBrowserValue(getWorkstationId, null);
}
