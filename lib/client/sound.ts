/**
 * Optional feedback sounds (Web Audio). Browsers only allow audio after a user
 * gesture; a key press from the scanner or a click counts. These sounds report
 * the APPLICATION result — the scanner's own beep only means "barcode decoded".
 */
let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  return ctx;
}

/** Call from a click/keydown handler to unlock audio. */
export function unlockAudio(): void {
  const c = context();
  if (c && c.state === "suspended") void c.resume();
}

function tone(freq: number, start: number, duration: number, type: OscillatorType = "sine") {
  const c = context();
  if (!c || c.state !== "running") return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, c.currentTime + start);
  gain.gain.exponentialRampToValueAtTime(0.25, c.currentTime + start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + duration);
  osc.connect(gain).connect(c.destination);
  osc.start(c.currentTime + start);
  osc.stop(c.currentTime + start + duration + 0.02);
}

export function playAccepted(): void {
  tone(1320, 0, 0.12);
}

export function playRejected(): void {
  tone(220, 0, 0.18, "square");
  tone(180, 0.22, 0.25, "square");
}

const KEY = "galia.sound";

export function soundPreference(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function setSoundPreference(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Storage unavailable: preference lasts for this page only.
  }
}
