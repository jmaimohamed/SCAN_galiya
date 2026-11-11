"use client";

import * as React from "react";
import { ScanLine, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ScanInputHandle {
  focus(): void;
}

interface ScanInputProps {
  /** Called once per complete scan (Enter-terminated), in arrival order. */
  onScan(raw: string): void;
  /** Re-take focus when it falls back to the page body (never from other inputs or dialogs). */
  autoRefocus?: boolean;
  disabled?: boolean;
  busyLabel?: string | null;
  label?: string;
  id?: string;
}

/** True when a dialog/drawer is open: never steal focus from it. */
function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

/** Split pasted text on CR/LF so several scans pasted at once stay separate and ordered. */
export function splitScans(buffer: string): { complete: string[]; rest: string } {
  const parts = buffer.split(/\r\n|\r|\n/);
  const rest = parts.pop() ?? "";
  return { complete: parts.filter((p) => p.trim() !== ""), rest };
}

/**
 * Dedicated scanner field for a Zebra DS2208 in USB keyboard (HID) mode with an
 * Enter suffix. Uncontrolled input: characters typed by the scanner go straight
 * into the DOM value; on Enter the value is taken and cleared synchronously, so
 * the next scan always starts empty. One React handler only — no duplicate
 * listeners — and an empty Enter (CR then LF) is ignored, so CR/LF never submits
 * twice. Focus does not prove a scanner is connected: HID mode cannot tell.
 */
export const ScanInput = React.forwardRef<ScanInputHandle, ScanInputProps>(function ScanInput(
  { onScan, autoRefocus = true, disabled = false, busyLabel = null, label = "Scanner ici", id = "scan-input" },
  ref,
) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [focused, setFocused] = React.useState(false);
  const onScanRef = React.useRef(onScan);
  React.useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const focus = React.useCallback(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  React.useImperativeHandle(ref, () => ({ focus }), [focus]);

  const submit = React.useCallback((value: string) => {
    if (value.trim() === "") return;
    onScanRef.current(value);
  }, []);

  React.useEffect(() => {
    if (!autoRefocus) return;
    const maybeRefocus = () => {
      const active = document.activeElement;
      if ((active === null || active === document.body) && !dialogOpen()) focus();
    };
    const timer = window.setInterval(maybeRefocus, 400);
    window.addEventListener("focus", maybeRefocus);
    maybeRefocus();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", maybeRefocus);
    };
  }, [autoRefocus, focus]);

  const ready = focused && !disabled;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="flex items-center justify-between text-sm font-semibold">
        <span className="flex items-center gap-2">
          <ScanLine className="size-5" aria-hidden /> {label}
        </span>
        <span
          data-testid="scan-ready"
          className={cn(
            "flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold",
            ready ? "bg-ok-soft text-ok" : "bg-warn-soft text-black",
          )}
        >
          <span className={cn("size-3 rounded-full", ready ? "bg-ok" : "bg-warn")} aria-hidden />
          {disabled ? busyLabel ?? "En pause" : ready ? "Prêt à scanner" : "Champ de scan inactif"}
        </span>
      </label>
      {/* The "not focused" warning overlays the (empty) field instead of adding a row:
          a layout shift on blur would move the button the operator is clicking. */}
      <div className="relative">
        <input
          id={id}
          ref={inputRef}
          type="text"
          inputMode="none"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={512}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          className={cn(
            "h-16 w-full rounded-lg border-4 bg-card px-4 font-mono text-2xl tracking-wide outline-none",
            ready ? "border-ok" : "border-warn",
          )}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const el = e.currentTarget;
            const value = el.value;
            el.value = "";
            submit(value);
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (!/[\r\n]/.test(text)) return;
            e.preventDefault();
            const el = e.currentTarget;
            const { complete, rest } = splitScans(el.value + text);
            el.value = rest;
            complete.forEach(submit);
          }}
        />
        {!focused && !disabled && (
          <button
            type="button"
            onClick={focus}
            className="no-print absolute inset-1 flex items-center gap-2 rounded-md bg-warn px-3 text-left text-base font-bold text-black"
          >
            <TriangleAlert className="size-6 shrink-0" aria-hidden />
            Le curseur n&apos;est pas dans le champ de scan : cliquer ici avant de scanner.
          </button>
        )}
      </div>
      <p id={`${id}-hint`} className="sr-only">
        Le scanner tape le code puis Entrée. Chaque code est envoyé au serveur dans l&apos;ordre.
      </p>
    </div>
  );
});

/**
 * Keyboard capture for dialogs that only contain buttons: scanner keystrokes
 * typed while the dialog is open are collected and queued (never lost, never
 * turned into a button press by the trailing Enter).
 */
export function useDialogScanCapture(onScan: (raw: string) => void) {
  const buffer = React.useRef("");
  const [captured, setCaptured] = React.useState(0);
  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "Enter") {
        e.preventDefault();
        const value = buffer.current;
        buffer.current = "";
        if (value.trim() !== "") {
          onScan(value);
          setCaptured((n) => n + 1);
        }
        return;
      }
      if (e.key.length === 1) {
        e.preventDefault();
        buffer.current += e.key;
      }
    },
    [onScan],
  );
  const reset = React.useCallback(() => {
    buffer.current = "";
    setCaptured(0);
  }, []);
  return { onKeyDown, captured, reset };
}
