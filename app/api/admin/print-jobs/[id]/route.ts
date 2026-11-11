import { api, jsonOk } from "@/lib/server/http";
import { prisma } from "@/lib/server/db";
import { parseId } from "@/lib/server/schemas";
import { notFound } from "@/lib/server/errors";
import { toJobDto } from "@/lib/server/services/printing";
/** Audit only: no production sheet marker and no print action. */
export const GET = api<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
 const row = await prisma.printJob.findUnique({ where: { id: parseId((await params).id) } });
 if (!row) throw notFound();
 return jsonOk({ job: toJobDto(row), svg: row.method === "PRINT_DIALOG" ? row.payload : null });
}, { role: "ADMIN" });
