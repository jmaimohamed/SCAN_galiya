import { requirePageActor } from "@/lib/server/auth/current";
import { AppHeader } from "@/components/app-header";
import { PresenceHeartbeat } from "@/components/presence-heartbeat";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requirePageActor();
  return (
    <div className="flex min-h-screen flex-col">
      <PresenceHeartbeat />
      <AppHeader username={actor.username} role={actor.role} />
      <main className="mx-auto w-full max-w-[1600px] flex-1 p-4">{children}</main>
    </div>
  );
}
