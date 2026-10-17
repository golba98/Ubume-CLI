/**
 * Reassembles pasted text from the chunks Ink delivers to the composer's `useInput`.
 *
 * Pastes arrive in two shapes, and both must end up as one insertion so that the
 * large-paste threshold (`isLargePaste`) sees the whole paste:
 * 1. **Bracketed paste:** the terminal wraps the paste in `ESC[200~` … `ESC[201~`,
 *    and the payload may be split across several input events. Everything between
 *    the markers is buffered and emitted once, as a paste.
 * 2. **Unbracketed bursts:** Ink/readline may strip the markers, or the terminal
 *    may not send them. Then a large paste arrives as several plain text events in
 *    quick succession. A chunk of at least `PASTE_CHUNK_CANDIDATE_MIN` characters
 *    (or any chunk while a burst is already buffering) starts or extends the burst.
 *    The burst is emitted as a paste once no chunk has arrived for
 *    `PASTE_CHUNK_SETTLE_MS`.
 *
 * Short plain chunks are ordinary typing and are emitted immediately as text.
 *
 * The class is framework-free: emission and timers are injected, so the composer
 * hook owns the side effects and tests can drive the timer by hand.
 */
import { normalizeInputText } from "../../input/inputBuffer.js";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  PASTE_CHUNK_CANDIDATE_MIN,
  PASTE_CHUNK_SETTLE_MS,
} from "./composerKeymap.js";

/** Where reassembled input goes. Both receive line-ending-normalised text. */
export interface PasteAssemblerSink {
  /** Typed text, inserted as-is. */
  text: (text: string) => void;
  /** A complete paste; the sink decides whether it becomes a pasted-content token. */
  paste: (text: string) => void;
}

/** Injected timer functions (defaults: the global `setTimeout`/`clearTimeout`). */
export interface PasteAssemblerTimers {
  setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const GLOBAL_TIMERS: PasteAssemblerTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class PasteAssembler {
  /** Text inside an open bracketed paste, or null when no bracket is open. */
  private bracketBuffer: string | null = null;
  /** Unbracketed burst waiting for the settle timer, or null when no burst is pending. */
  private burstBuffer: string | null = null;
  private burstTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sink: PasteAssemblerSink,
    private readonly timers: PasteAssemblerTimers = GLOBAL_TIMERS,
  ) {}

  /** Feeds one `useInput` text chunk. */
  feed(chunk: string): void {
    let remaining = chunk;

    while (remaining.length > 0) {
      if (this.bracketBuffer !== null) {
        const endMatch = BRACKETED_PASTE_END.exec(remaining);
        if (!endMatch) {
          this.bracketBuffer += remaining;
          return;
        }

        this.bracketBuffer += remaining.slice(0, endMatch.index);
        const pastedText = normalizeInputText(this.bracketBuffer);
        this.bracketBuffer = null;
        this.sink.paste(pastedText);
        remaining = remaining.slice(endMatch.index + endMatch[0].length);
        continue;
      }

      const startMatch = BRACKETED_PASTE_START.exec(remaining);
      if (!startMatch) {
        // Coalesce burst chunks before the large-paste threshold is applied, so a
        // multi-kilobyte paste cannot leak into the draft as several smaller raw
        // fragments.
        if (this.burstBuffer !== null || remaining.length >= PASTE_CHUNK_CANDIDATE_MIN) {
          this.bufferBurst(remaining);
        } else {
          this.sink.text(normalizeInputText(remaining));
        }
        return;
      }

      const prefix = remaining.slice(0, startMatch.index);
      if (prefix) this.sink.text(normalizeInputText(prefix));

      this.bracketBuffer = "";
      remaining = remaining.slice(startMatch.index + startMatch[0].length);
    }
  }

  /** Cancels a pending burst without emitting it (the composer is unmounting). */
  dispose(): void {
    if (this.burstTimer) this.timers.clearTimeout(this.burstTimer);
    this.burstTimer = null;
  }

  private bufferBurst(text: string): void {
    this.burstBuffer = `${this.burstBuffer ?? ""}${text}`;
    if (this.burstTimer) this.timers.clearTimeout(this.burstTimer);
    this.burstTimer = this.timers.setTimeout(() => this.flushBurst(), PASTE_CHUNK_SETTLE_MS);
  }

  private flushBurst(): void {
    const buffered = this.burstBuffer;
    this.burstBuffer = null;
    this.burstTimer = null;
    if (buffered) this.sink.paste(buffered);
  }
}
