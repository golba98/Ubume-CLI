/** In-memory Ink terminal for App fixtures. Specialized raw-mode tests own their stream doubles. */
import { PassThrough } from "node:stream";
import { render } from "ink";
import type { ReactNode } from "react";

class TerminalInput extends PassThrough {
  readonly isTTY = true;
  setRawMode(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

class TerminalOutput extends PassThrough {
  readonly isTTY = true;
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }
}

/**
 * Renders with whole-frame debug output and real stream flow control. The caller must dispose
 * the terminal and independently stop providers/stores it owns. No process streams are patched.
 */
export function createTestTerminal(
  element: ReactNode,
  { columns = 100, rows = 32 }: { columns?: number; rows?: number } = {},
) {
  const stdin = new TerminalInput();
  const stdout = new TerminalOutput(columns, rows);
  let output = "";
  let frame = "";
  const capture = (chunk: Buffer) => {
    // Ink debug mode writes a complete frame in each chunk; this is not a VT screen emulator.
    frame = chunk.toString();
    output += frame;
  };
  stdout.on("data", capture);
  let instance: ReturnType<typeof render>;
  try {
    instance = render(element, {
      // These streams implement the TTY subset Ink consumes, not file-descriptor-backed stdio.
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
  } catch (error) {
    stdout.off("data", capture);
    stdin.destroy();
    stdout.destroy();
    throw error;
  }
  let disposal: Promise<void> | undefined;
  return {
    stdin,
    stdout,
    instance,
    output: () => output,
    lastFrame: () => frame,
    /** Unmounts, waits for output teardown, releases Ink's instance, and destroys owned streams. */
    dispose(): Promise<void> {
      disposal ??= (async () => {
        try {
          instance.unmount();
          await instance.waitUntilExit();
        } finally {
          try {
            instance.cleanup();
          } finally {
            stdout.off("data", capture);
            stdin.destroy();
            stdout.destroy();
          }
        }
      })();
      return disposal;
    },
  };
}
