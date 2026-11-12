import { api, jsonOk, readJson } from "@/lib/server/http";
import { finalizeSchema, parseId } from "@/lib/server/schemas";
import { finalizeBox } from "@/lib/server/services/boxes";
import { requestAutomaticPrint, type AutoPrint } from "@/lib/server/services/printing";

/**
 * End the control (same GALIA rescanned, or « Terminer le contrôle »). The
 * OK / NOT OK result is computed on the server and committed first; only then is
 * the automatic label request prepared (one ORIGINAL job per report, idempotent).
 * A print problem is reported in `print` and never rolls the finalization back.
 */
export const POST = api<{ params: Promise<{ id: string }> }>(async (req, { params, actor }) => {
  const boxId = parseId((await params).id);
  const { workstationId, ...body } = await readJson(req, finalizeSchema);
  const result = await finalizeBox(actor, { boxId, ...body });
  let print: AutoPrint | null = null;
  if (result.kind === "FINALIZED" || result.kind === "ALREADY_FINALIZED") {
    print = await requestAutomaticPrint(actor, result.report.id, workstationId);
  }
  return jsonOk({ ...result, print });
});
