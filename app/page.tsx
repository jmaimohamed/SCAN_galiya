import { redirect } from "next/navigation";
import { getCurrentActor } from "@/lib/server/auth/current";

export default async function Home() {
  const actor = await getCurrentActor();
  redirect(actor ? "/controle" : "/login");
}
