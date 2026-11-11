import { requirePageActor } from "@/lib/server/auth/current";
import { listUsers } from "@/lib/server/services/users";
import { UsersAdmin } from "@/components/admin/users-admin";

export const metadata = { title: "Utilisateurs — GALIA Control" };

export default async function UsersPage() {
  const actor = await requirePageActor("ADMIN");
  return <UsersAdmin currentUserId={actor.userId} initialUsers={await listUsers()} />;
}
