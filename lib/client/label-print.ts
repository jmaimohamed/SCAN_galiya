/**
 * Called only by an explicit action (end of control, print / reprint buttons),
 * never by an effect or the label page. A hidden same-origin frame avoids popup
 * blockers. The browser still controls printing; print() / afterprint cannot
 * confirm the selected printer or the physical output.
 *
 * Chrome/Edge keep print() blocked while their print dialog is open, so a call
 * that returns almost immediately usually means the dialog did not appear
 * (blocked, or printing disabled): `likelyShown` is false and the page offers a
 * prominent « Imprimer maintenant » (a heuristic, never a proof either way).
 */
let current: HTMLIFrameElement | null = null;
const requested = new Set<string>();

/** print() returning faster than this almost certainly did not show a dialog. */
export const DIALOG_SHOWN_MIN_MS = 250;

export interface PrintDialogOutcome {
  elapsedMs: number;
  likelyShown: boolean;
}

export interface PrintDialogOptions {
  /** Explicit operator retry of the same job after a blocked / unconfirmed dialog. */
  allowRepeat?: boolean;
  now?: () => number;
}

export function openLabelPrintDialog(jobId: string, widthMm: number, heightMm: number, options: PrintDialogOptions = {}): Promise<PrintDialogOutcome> {
  if (current) return Promise.reject(new Error("Une demande d'impression est déjà en cours."));
  if (requested.has(jobId) && !options.allowRepeat) return Promise.reject(new Error("Fenêtre déjà demandée pour cette étiquette. Vérifier la sortie puis utiliser « Réimprimer… » si nécessaire."));
  const now = options.now ?? (() => performance.now());

  return new Promise<PrintDialogOutcome>((resolve, reject) => {
    const frame = document.createElement("iframe");
    current = frame;
    frame.title = "Impression de l'étiquette";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${widthMm}mm;height:${heightMm}mm;border:0;`;
    let handled = false;
    let settled = false;
    const remove = () => {
      if (current === frame) current = null;
      frame.remove();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      remove();
      reject(error);
    };
    // Includes slow fonts / image decoding, not just the navigation.
    const timer = window.setTimeout(() => fail(new Error("L'étiquette ne s'est pas chargée à temps. Aucune fenêtre demandée ; vérifier le réseau et utiliser « Réimprimer… » pour une étiquette de production.")), 20_000);
    frame.onerror = () => fail(new Error("Chargement de l'étiquette impossible. Vérifier la connexion et la session."));
    frame.onload = () => {
      if (handled || settled) return;
      handled = true;
      void (async () => {
        const win = frame.contentWindow;
        const doc = frame.contentDocument;
        // Never print a login, error, superseded report, or incomplete streamed page.
        const sheet = doc?.querySelector("[data-label-sheet]");
        if (!win || !doc || sheet?.getAttribute("data-label-sheet") !== jobId) {
          throw new Error(doc?.querySelector("[data-label-error]")?.textContent || "Étiquette introuvable ou session expirée : aucune fenêtre demandée.");
        }
        await doc.fonts?.ready;
        const images = Array.from(sheet.querySelectorAll("img"));
        if (images.length !== 1) throw new Error("Contenu de l'étiquette incomplet : impression refusée.");
        await Promise.all(images.map((img) => img.decode()));
        if (images.some((img) => !img.naturalWidth)) throw new Error("Image de l'étiquette illisible : impression refusée.");
        // Let the decoded SVG and physical-size styles reach layout before printing.
        await new Promise<void>((ready) => win.requestAnimationFrame(() => ready()));
        if (settled || !frame.isConnected) return;
        window.clearTimeout(timer);
        requested.add(jobId); // Set BEFORE print(): repeated load events cannot reopen it.
        win.focus();
        const started = now();
        try {
          win.print();
        } catch {
          throw new Error("Le navigateur a refusé la demande d'impression. Autoriser l'impression, vérifier la sortie puis utiliser « Réimprimer… » si nécessaire.");
        }
        const elapsedMs = Math.max(0, Math.round(now() - started));
        settled = true;
        // Some browsers render after print() returns. Cleanup never starts a print.
        if (current === frame) current = null;
        window.setTimeout(remove, 60_000);
        resolve({ elapsedMs, likelyShown: elapsedMs >= DIALOG_SHOWN_MIN_MS });
      })().catch((e: unknown) => fail(e instanceof Error ? e : new Error("Impression impossible.")));
    };
    frame.src = `/etiquette/${encodeURIComponent(jobId)}`;
    document.body.appendChild(frame);
  });
}
