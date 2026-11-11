/**
 * Called only by an explicit print action, never by an effect or the label page.
 * A same-origin frame avoids popup blockers. The browser still controls printing;
 * print() / afterprint cannot confirm the selected printer or physical output.
 */
let current: HTMLIFrameElement | null = null;
const requested = new Set<string>();

export function openLabelPrintDialog(jobId: string, widthMm: number, heightMm: number): Promise<void> {
  if (current) return Promise.reject(new Error("Une demande d'impression est déjà en cours."));
  if (requested.has(jobId)) return Promise.reject(new Error("Fenêtre déjà demandée pour cette étiquette. Vérifier la sortie puis utiliser « Réimprimer… » si nécessaire."));

  return new Promise((resolve, reject) => {
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
        try {
          win.print();
        } catch {
          throw new Error("Le navigateur a refusé la demande d'impression. Autoriser l'impression, vérifier la sortie puis utiliser « Réimprimer… » si nécessaire.");
        }
        settled = true;
        // Some browsers render after print() returns. Cleanup never starts a print.
        if (current === frame) current = null;
        window.setTimeout(remove, 60_000);
        resolve();
      })().catch((e: unknown) => fail(e instanceof Error ? e : new Error("Impression impossible.")));
    };
    frame.src = `/etiquette/${encodeURIComponent(jobId)}`;
    document.body.appendChild(frame);
  });
}
