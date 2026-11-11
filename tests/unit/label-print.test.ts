// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let openLabelPrintDialog: typeof import("@/lib/client/label-print").openLabelPrintDialog;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  ({ openLabelPrintDialog } = await import("@/lib/client/label-print"));
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function loadedLabel(jobId: string, decode = vi.fn().mockResolvedValue(undefined)) {
  const frame = document.querySelector("iframe")!;
  const doc = frame.contentDocument!;
  if (!doc.body) {
    const root = doc.documentElement ?? doc.appendChild(doc.createElement("html"));
    root.appendChild(doc.createElement("body"));
  }
  doc.body.innerHTML = `<div data-label-sheet="${jobId}"><img alt="Label" /></div>`;
  const img = doc.querySelector("img")!;
  Object.defineProperty(img, "decode", { value: decode });
  Object.defineProperty(img, "naturalWidth", { value: 800 });
  const print = vi.spyOn(frame.contentWindow!, "print").mockImplementation(() => undefined);
  vi.spyOn(frame.contentWindow!, "focus").mockImplementation(() => undefined);
  Object.defineProperty(frame.contentWindow!, "requestAnimationFrame", { value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
  return { frame, doc, print, decode };
}

describe("explicit browser label printing", () => {
  it("waits for fonts and decoded SVG, then requests one dialog even on repeated load events", async () => {
    const pending = openLabelPrintDialog("job-1", 100, 100);
    let fontsReady!: () => void;
    let imageReady!: () => void;
    const decode = vi.fn(() => new Promise<void>((resolve) => { imageReady = resolve; }));
    const { frame, doc, print } = loadedLabel("job-1", decode);
    Object.defineProperty(doc, "fonts", { value: { ready: new Promise<void>((resolve) => { fontsReady = resolve; }) } });
    frame.dispatchEvent(new Event("load"));
    expect(print).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    fontsReady();
    await Promise.resolve();
    expect(decode).toHaveBeenCalledOnce();
    expect(print).not.toHaveBeenCalled();
    imageReady();
    await pending;
    frame.dispatchEvent(new Event("load"));
    expect(print).toHaveBeenCalledOnce();
    await expect(openLabelPrintDialog("job-1", 100, 100)).rejects.toThrow(/déjà demandée/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(print).toHaveBeenCalledOnce();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("refuses a login/error page and surfaces correction errors without printing", async () => {
    const pending = openLabelPrintDialog("job-2", 100, 100);
    const { frame, doc, print } = loadedLabel("wrong-job");
    doc.body.innerHTML = '<p data-label-error>Correction en cours : impression bloquée.</p>';
    frame.dispatchEvent(new Event("load"));
    await expect(pending).rejects.toThrow(/Correction en cours/);
    expect(print).not.toHaveBeenCalled();
  });

  it("refuses an undecodable SVG and removes the frame", async () => {
    const pending = openLabelPrintDialog("job-3", 100, 100);
    const { frame, print } = loadedLabel("job-3", vi.fn().mockRejectedValue(new Error("SVG illisible")));
    frame.dispatchEvent(new Event("load"));
    await expect(pending).rejects.toThrow(/SVG illisible/);
    expect(print).not.toHaveBeenCalled();
    expect(frame.isConnected).toBe(false);
  });

  it("times out even when font loading stalls and refuses concurrent requests", async () => {
    const pending = openLabelPrintDialog("job-4", 100, 100);
    const { frame, doc, print } = loadedLabel("job-4");
    Object.defineProperty(doc, "fonts", { value: { ready: new Promise(() => undefined) } });
    frame.dispatchEvent(new Event("load"));
    await expect(openLabelPrintDialog("job-5", 100, 100)).rejects.toThrow(/en cours/);
    const rejection = expect(pending).rejects.toThrow(/chargée à temps/);
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
    expect(print).not.toHaveBeenCalled();
  });

  it("reports browser print refusal and never automatically retries", async () => {
    const pending = openLabelPrintDialog("job-6", 100, 100);
    const { frame, print } = loadedLabel("job-6");
    print.mockImplementation(() => { throw new Error("Blocked"); });
    frame.dispatchEvent(new Event("load"));
    await expect(pending).rejects.toThrow(/navigateur a refusé/);
    await expect(openLabelPrintDialog("job-6", 100, 100)).rejects.toThrow(/déjà demandée/);
    expect(print).toHaveBeenCalledOnce();
  });
});
