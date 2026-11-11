// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScanInput, splitScans } from "@/components/scan/scan-input";

afterEach(cleanup);

describe("ScanInput (DS2208 keyboard-wedge input)", () => {
  it("submits each Enter-terminated scan once, in order, during rapid typing", async () => {
    const onScan = vi.fn();
    render(<ScanInput onScan={onScan} autoRefocus={false} />);
    const input = screen.getByRole("textbox");
    input.focus();
    const user = userEvent.setup({ delay: null });
    const scans = Array.from({ length: 25 }, (_, i) => `L002815593B96AG_S${70166592310 + i}`);
    await user.keyboard(scans.map((s) => `${s}{Enter}`).join(""));
    expect(onScan.mock.calls.map((c) => c[0])).toEqual(scans);
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("does not submit twice when the scanner sends CR then LF (empty Enter ignored)", async () => {
    const onScan = vi.fn();
    render(<ScanInput onScan={onScan} autoRefocus={false} />);
    const input = screen.getByRole("textbox");
    input.focus();
    const user = userEvent.setup({ delay: null });
    await user.keyboard("PL002815593B96AG_Q20_S10428865{Enter}{Enter}L002815593B96AG_S70166592310{Enter}{Enter}");
    expect(onScan.mock.calls.map((c) => c[0])).toEqual(["PL002815593B96AG_Q20_S10428865", "L002815593B96AG_S70166592310"]);
  });

  it("keeps the raw value untouched (case and characters) for the server to judge", async () => {
    const onScan = vi.fn();
    render(<ScanInput onScan={onScan} autoRefocus={false} />);
    const input = screen.getByRole("textbox");
    input.focus();
    await userEvent.setup({ delay: null }).keyboard("l002815593b96ag°s123{Enter}");
    expect(onScan).toHaveBeenCalledWith("l002815593b96ag°s123");
  });

  it("splits a multi-line paste into ordered scans", () => {
    const onScan = vi.fn();
    render(<ScanInput onScan={onScan} autoRefocus={false} />);
    const input = screen.getByRole("textbox");
    fireEvent.paste(input, { clipboardData: { getData: () => "A_S1111\r\nB_S2222\nC_S33" } });
    expect(onScan.mock.calls.map((c) => c[0])).toEqual(["A_S1111", "B_S2222"]);
    expect((input as HTMLInputElement).value).toBe("C_S33");
  });

  it("shows 'Prêt à scanner' only while focused, and a visible warning otherwise", () => {
    render(<ScanInput onScan={() => undefined} autoRefocus={false} />);
    expect(screen.getByTestId("scan-ready").textContent).toContain("Champ de scan inactif");
    expect(screen.getByRole("button", { name: /cliquer ici avant de scanner/ })).toBeTruthy();
    fireEvent.focus(screen.getByRole("textbox"));
    expect(screen.getByTestId("scan-ready").textContent).toContain("Prêt à scanner");
  });

  it("never steals focus from another input (e.g. a search field)", async () => {
    render(
      <>
        <input aria-label="search" />
        <ScanInput onScan={() => undefined} />
      </>,
    );
    const search = screen.getByLabelText("search");
    search.focus();
    await new Promise((r) => setTimeout(r, 500));
    expect(document.activeElement).toBe(search);
  });

  it("re-takes focus when it falls back to the page body", async () => {
    render(<ScanInput onScan={() => undefined} />);
    (document.activeElement as HTMLElement | null)?.blur();
    await new Promise((r) => setTimeout(r, 500));
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });

  it("splitScans keeps an unterminated tail", () => {
    expect(splitScans("A\r\nB\n\nC")).toEqual({ complete: ["A", "B"], rest: "C" });
  });
});
