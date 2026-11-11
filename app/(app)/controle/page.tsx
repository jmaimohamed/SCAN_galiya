import { requirePageActor } from "@/lib/server/auth/current";
import { listInProgressBoxes } from "@/lib/server/services/boxes";
import { ControlClient } from "@/components/control/control-client";

export const metadata = { title: "Contrôle — GALIA Control" };

export default async function ControlPage() {
  const actor = await requirePageActor();
  const inProgress = await listInProgressBoxes(15, actor);
  return <ControlClient username={actor.username} initialInProgress={inProgress} />;
}
