// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrintPanel } from "@/components/print/print-panel";

const { fetchApi, printDialog } = vi.hoisted(() => ({ fetchApi: vi.fn(), printDialog: vi.fn() }));
vi.mock("@/lib/client/api", async (original) => ({ ...await original<object>(), apiFetch: fetchApi }));
vi.mock("@/lib/client/label-print", () => ({ openLabelPrintDialog: printDialog }));
vi.mock("@/lib/client/workstation", () => ({ useWorkstationId: () => "workstation-a" }));

beforeEach(() => {
  vi.clearAllMocks();
  fetchApi.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/printer-profile?")) return { profile: { confirmedAt: "2026-11-11T08:00:00Z", widthMm: 100, heightMm: 100 } };
    if (url.includes("label-preview")) return { svg: "<svg/>" };
    if (url === "/api/print-jobs") return { job: { id: "job-a", widthMm: 100, heightMm: 100 }, replayed: false };
    return { jobs: [] };
  });
  printDialog.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("print panel actions", () => {
  it("does not print on Strict Mode mounts, rerenders or explicit history refresh", async () => {
    const view = render(<StrictMode><PrintPanel reportId="report-a" /></StrictMode>);
    await waitFor(() => expect((screen.getByTestId("print-label") as HTMLButtonElement).disabled).toBe(false));
    view.rerender(<StrictMode><PrintPanel reportId="report-a" /></StrictMode>);
    fireEvent.click(screen.getByText("Actualiser"));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith("/api/reports/report-a/print-jobs"));
    expect(printDialog).not.toHaveBeenCalled();
    expect(fetchApi.mock.calls.some(([url]) => url === "/api/print-jobs")).toBe(false);
  });

  it("rapid explicit clicks create one job and request one dialog", async () => {
    render(<PrintPanel reportId="report-a" />);
    const button = await screen.findByTestId("print-label");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(printDialog).toHaveBeenCalledOnce());
    expect(fetchApi.mock.calls.filter(([url]) => url === "/api/print-jobs")).toHaveLength(1);
    expect(printDialog).toHaveBeenCalledWith("job-a", 100, 100);
    // Status is informational, never a physical success.
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("ne peut pas le confirmer"));
  });
});
