/**
 * Retention policy for subprocess output that a caller keeps after streaming it.
 * Streaming callbacks always see every chunk; this only bounds what is retained.
 */

/**
 * `"full"` keeps everything (callers that parse or persist complete output).
 * `{ maxChars }` keeps the first and last `maxChars / 2` characters and records
 * how much was dropped, for callers that only inspect diagnostics.
 */
export type OutputCapture = "full" | { maxChars: number };

export interface OutputBuffer {
  append(text: string): void;
  /** Retained text; bounded buffers mark omitted characters explicitly. */
  text(): string;
  /** Characters dropped from the middle (always 0 for full capture). */
  readonly omittedChars: number;
}

/** The explicit marker a bounded buffer places where it dropped output. */
export function omissionMarker(omittedChars: number): string {
  return `\n[… ${omittedChars} characters of output omitted …]\n`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function splitsPair(text: string, index: number): boolean {
  return index > 0 && index < text.length && isHighSurrogate(text.charCodeAt(index - 1));
}

/** Cut index at or before `index` that does not split a surrogate pair. */
function cutBefore(text: string, index: number): number {
  return splitsPair(text, index) ? index - 1 : index;
}

/** Cut index at or after `index` that does not split a surrogate pair. */
function cutAfter(text: string, index: number): number {
  return splitsPair(text, index) ? index + 1 : index;
}

export function createOutputBuffer(capture: OutputCapture = "full"): OutputBuffer {
  if (capture === "full") {
    let value = "";
    return {
      append(text) {
        value += text;
      },
      text: () => value,
      omittedChars: 0,
    };
  }

  if (!Number.isSafeInteger(capture.maxChars) || capture.maxChars < 2) {
    throw new RangeError("maxChars must be a safe integer of at least 2.");
  }
  const half = Math.floor(capture.maxChars / 2);
  let head = "";
  let headClosed = false;
  // Tail chunks are kept as an array so trimming the oldest data is cheap.
  const tail: string[] = [];
  let tailLength = 0;
  let omitted = 0;

  const trimTail = () => {
    while (tailLength > half) {
      const first = tail[0]!;
      const excess = tailLength - half;
      if (first.length <= excess) {
        tail.shift();
        tailLength -= first.length;
        omitted += first.length;
        continue;
      }
      const cut = cutAfter(first, excess);
      tail[0] = first.slice(cut);
      tailLength -= cut;
      omitted += cut;
    }
  };

  return {
    append(text) {
      if (!text) return;
      let rest = text;
      if (!headClosed) {
        const room = half - head.length;
        const cut = rest.length <= room ? rest.length : cutBefore(rest, room);
        head += rest.slice(0, cut);
        rest = rest.slice(cut);
        if (!rest) return;
        headClosed = true;
      }
      tail.push(rest);
      tailLength += rest.length;
      trimTail();
    },
    text() {
      const retainedTail = tail.join("");
      return omitted > 0 ? `${head}${omissionMarker(omitted)}${retainedTail}` : head + retainedTail;
    },
    get omittedChars() {
      return omitted;
    },
  };
}
