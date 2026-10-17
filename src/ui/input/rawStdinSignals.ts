/**
 * Short-lived "signals" derived from raw stdin chunks, for key sequences that Ink's
 * `useInput` cannot report reliably on every terminal.
 *
 * Ink parses stdin into `(input, key)` events, but some sequences arrive mangled:
 * - SGR / X10 mouse reports are split into printable fragments (e.g. `[<0;26;24M`).
 * - CSI-u modified keys (Ctrl+M as `ESC[109;5u`, Ctrl+Alt+P as `ESC[112;7u`) and
 *   Shift+Tab variants are not recognised by every Ink parser.
 *
 * A component therefore also listens to raw `data` events. When a chunk matches a
 * signal, the signal is held "active" for a short window. During that window the
 * component's `useInput` handler can either swallow the mangled events Ink emits for
 * the same chunk (mouse), or treat them as the intended shortcut and `consume()` the
 * signal so it fires only once.
 *
 * Ordering assumption: the raw listener sees a chunk before Ink delivers the parsed
 * events for it, so the signal is already set when `useInput` runs. The hold windows
 * (32–64 ms) cover Ink's event delivery for that chunk without leaking into the next
 * real keystroke.
 *
 * Lifecycle: the hook subscribes once per `stdin` stream, and on unmount it removes
 * the listener and clears every pending hold timer.
 */
import { useEffect, useRef } from "react";

/** SGR (`ESC[<b;x;yM`/`m`) or legacy X10 (`ESC[M…`) terminal mouse report. */
export function isMouseReportSequence(raw: string): boolean {
  return /\u001b\[<\d+;\d+;\d+[Mm]/.test(raw) || /\u001b\[M/.test(raw);
}

/** How a signal is recognised in a raw chunk and how long it stays active. */
export interface RawStdinSignalSpec {
  matches: (raw: string) => boolean;
  holdMs: number;
}

/** Read and consume access to the signals declared for one component. */
export interface RawStdinSignals<Name extends string> {
  /** True while the signal's hold window is open. */
  isActive: (name: Name) => boolean;
  /** Closes the hold window now, so the signal triggers at most one action. */
  consume: (name: Name) => void;
}

interface SignalSlot {
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Subscribes to raw stdin and tracks one hold window per declared signal.
 *
 * @param stdin - Ink's stdin stream (`useStdin().stdin`).
 * @param specs - Signal definitions. Must be a stable (module-level) object; it is
 *   read when the hook first runs.
 * @param onRawChunk - Optional extra handler for every chunk, called after the signals
 *   are updated. The latest function is always used, so callers may pass an inline
 *   closure.
 */
export function useRawStdinSignals<Name extends string>(
  stdin: NodeJS.ReadStream,
  specs: Readonly<Record<Name, RawStdinSignalSpec>>,
  onRawChunk?: (raw: string) => void,
): RawStdinSignals<Name> {
  const onRawChunkRef = useRef(onRawChunk);
  onRawChunkRef.current = onRawChunk;

  const slotsRef = useRef<Map<Name, SignalSlot> | null>(null);
  if (!slotsRef.current) {
    slotsRef.current = new Map(
      (Object.keys(specs) as Name[]).map((name) => [name, { active: false, timer: null }]),
    );
  }
  const slots = slotsRef.current;

  const signalsRef = useRef<RawStdinSignals<Name> | null>(null);
  if (!signalsRef.current) {
    signalsRef.current = {
      isActive: (name) => slots.get(name)?.active ?? false,
      consume: (name) => {
        const slot = slots.get(name);
        if (!slot) return;
        slot.active = false;
        if (slot.timer) {
          clearTimeout(slot.timer);
          slot.timer = null;
        }
      },
    };
  }

  useEffect(() => {
    const handleRawInput = (chunk: Buffer | string) => {
      const raw = typeof chunk === "string" ? chunk : chunk.toString();
      for (const [name, slot] of slots) {
        const spec = specs[name];
        if (!spec.matches(raw)) continue;
        slot.active = true;
        // Restart the window: a repeated sequence extends it rather than stacking timers.
        if (slot.timer) clearTimeout(slot.timer);
        slot.timer = setTimeout(() => {
          slot.active = false;
        }, spec.holdMs);
      }
      onRawChunkRef.current?.(raw);
    };

    stdin.on("data", handleRawInput);
    return () => {
      stdin.off("data", handleRawInput);
      for (const slot of slots.values()) {
        if (slot.timer) clearTimeout(slot.timer);
      }
    };
  }, [slots, specs, stdin]);

  return signalsRef.current;
}
