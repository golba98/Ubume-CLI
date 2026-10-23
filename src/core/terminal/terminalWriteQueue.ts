/** Ordered, cooperative publication of large TTY frames. Small writes stay synchronous. */
type Completion = (error?: Error | null) => void;
type Write = (
  chunk: string | Uint8Array,
  encoding?: BufferEncoding | Completion,
  callback?: Completion,
) => boolean;
interface PendingWrite {
  chunk: string | Uint8Array;
  encoding?: BufferEncoding;
  callback?: Completion;
  offset: number;
}

/** Never split an ANSI control string, a measured line, or a UTF-16 surrogate pair. */
export function terminalChunkEnd(text: string, start: number, limit: number): number {
  let cursor = start;
  let line = start;
  while (cursor < text.length) {
    if (text[cursor] === "\x1b") {
      const kind = text[cursor + 1];
      if (kind && "]P_^".includes(kind)) {
        const st = text.indexOf("\x1b\\", cursor + 2);
        const bell = kind === "]" ? text.indexOf("\x07", cursor + 2) : -1;
        const end = bell >= 0 && (st < 0 || bell < st) ? bell + 1 : st >= 0 ? st + 2 : text.length;
        cursor = end;
      } else if (kind === "[") {
        cursor += 2;
        while (cursor < text.length && !/[@-~]/.test(text[cursor]!)) cursor++;
        cursor++;
      } else cursor += 2;
    } else {
      if (text[cursor++] === "\n") line = cursor;
    }
    if (cursor - start >= limit && line > start) return line;
  }
  return text.length;
}

export function createTerminalWriteQueue(
  write: Write,
  {
    enabled = true,
    threshold = 32768,
    chunkSize = 8192,
    onError = (_error: Error) => {},
  }: {
    enabled?: boolean;
    threshold?: number;
    chunkSize?: number;
    onError?: (error: Error) => void;
  } = {},
) {
  const pending: PendingWrite[] = [];
  let scheduled: ReturnType<typeof setImmediate> | null = null;
  let writing = false;
  let epoch = 0;
  let disposed = false;
  const schedule = () => {
    if (!disposed && !scheduled && !writing && pending.length) scheduled = setImmediate(pump);
  };
  const pump = () => {
    scheduled = null;
    const job = pending[0];
    if (!job || disposed) return;
    const owner = epoch;
    const end =
      typeof job.chunk === "string"
        ? terminalChunkEnd(job.chunk, job.offset, chunkSize)
        : job.chunk.length;
    const part = job.chunk.slice(job.offset, end);
    writing = true;
    let reported = false;
    const complete: Completion = (error) => {
      if (owner !== epoch || reported) return;
      reported = true;
      writing = false;
      job.offset = end;
      if (error || end === job.chunk.length) {
        pending.shift();
        job.callback?.(error);
        if (error) onError(error);
      }
      schedule();
    };
    try {
      write(part, job.encoding, complete);
    } catch (error) {
      complete(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const cancel = () => {
    epoch++;
    if (scheduled) clearImmediate(scheduled);
    scheduled = null;
    writing = false;
    const removed = pending.splice(0);
    // Stop a synchronized update before releasing handoff barriers. The bytes
    // already accepted by the real Writable must drain before those resolve.
    if (removed.length) {
      try {
        write("\x1b[0m\x1b[?2026l");
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
    for (const job of removed) {
      if (!job.callback) continue;
      try {
        write("", job.encoding, job.callback);
      } catch (error) {
        queueMicrotask(() =>
          job.callback?.(error instanceof Error ? error : new Error(String(error))),
        );
      }
    }
  };
  return {
    write(
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | Completion,
      callback?: Completion,
    ): boolean {
      if (typeof encoding === "function") {
        callback = encoding;
        encoding = undefined;
      }
      if (typeof chunk === "string" && chunk.includes("\x1b[3J")) cancel();
      const graphic = typeof chunk === "string" && /\x1b(?:_G|P|\]1337;)/.test(chunk);
      if (
        !enabled ||
        disposed ||
        (!pending.length && (typeof chunk !== "string" || graphic || chunk.length < threshold))
      )
        return write(chunk, encoding, callback);
      pending.push({ chunk, encoding, callback, offset: 0 });
      schedule();
      return true;
    },
    cancel,
    dispose() {
      cancel();
      disposed = true;
    },
  };
}
