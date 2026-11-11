import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "../config";
import type { Actor } from "../errors";
import { validateSessionToken } from "./session";

/** Session of the current page request (server components). */
export async function getCurrentActor(): Promise<Actor | null> {
  const store = await cookies();
  return validateSessionToken(store.get(SESSION_COOKIE)?.value);
}

/** Redirect to the login page when there is no valid session (or the role is insufficient). */
export async function requirePageActor(role?: "ADMIN"): Promise<Actor> {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");
  if (role === "ADMIN" && actor.role !== "ADMIN") redirect("/controle");
  return actor;
}
