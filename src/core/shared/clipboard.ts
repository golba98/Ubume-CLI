/**
 * Platform clipboard bridges for text and PNG images. Text copies fall back to the terminal's
 * OSC 52 clipboard; image reads validate PNG bytes and size, clean up their temporary directory
 * and reject when no supported bridge succeeds.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "child_process";
import { platform } from "os";

function trySpawn(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
    proc.stdin?.on("error", () => undefined);
    proc.stdin?.write(text);
    proc.stdin?.end();
  });
}

export type ClipboardCopyMethod = "wl-copy" | "xclip" | "xsel" | "pbcopy" | "clip" | "osc52";

export type ClipboardCopyResult =
  | { ok: true; method: ClipboardCopyMethod }
  | { ok: false; reason: string };

export interface CopyToClipboardOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Runs a clipboard command with `text` on stdin; resolves whether it exited 0. */
  spawnText?: (cmd: string, args: string[], text: string) => Promise<boolean>;
  /** Writes a control sequence to the terminal; null when no terminal is attached. */
  writeTerminal?: ((sequence: string) => void) | null;
}

/** Largest text sent through OSC 52; terminals cap or reject bigger clipboard writes. */
export const MAX_OSC52_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * OSC 52 "set clipboard" for the terminal itself to perform (Kitty, WezTerm, foot, iTerm2...).
 * The payload is the text's exact UTF-8 bytes, so Unicode survives unchanged.
 */
export function buildOsc52Sequence(text: string, tmux = false): string {
  const sequence = `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
  return tmux ? `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\` : sequence;
}

/** Writes like the terminal title: stderr when it is the TTY, outside Ink's stdout frames. */
function defaultTerminalWriter(): ((sequence: string) => void) | null {
  if (process.stderr?.isTTY) return (sequence) => process.stderr.write(sequence);
  if (process.stdout?.isTTY) return (sequence) => process.stdout.write(sequence);
  return null;
}

/**
 * Copies text through the first bridge that works. Linux tries the display server's own tool
 * (wl-copy on Wayland, then xclip/xsel on X11), then asks the terminal via OSC 52. OSC 52 has no
 * acknowledgement: success means the request was sent, not that the terminal accepted it.
 */
export async function copyToClipboard(
  text: string,
  options: CopyToClipboardOptions = {},
): Promise<ClipboardCopyResult> {
  const os = options.platform ?? platform();
  const env = options.env ?? process.env;
  const run = options.spawnText ?? trySpawn;

  if (os === "win32")
    return (await run("clip", [], text))
      ? { ok: true, method: "clip" }
      : {
          ok: false,
          reason: "the Windows clip command failed",
        };
  if (os === "darwin")
    return (await run("pbcopy", [], text))
      ? { ok: true, method: "pbcopy" }
      : {
          ok: false,
          reason: "pbcopy failed",
        };

  const tried: string[] = [];
  if (env.WAYLAND_DISPLAY) {
    tried.push("wl-copy");
    if (await run("wl-copy", [], text)) return { ok: true, method: "wl-copy" };
  }
  if (env.DISPLAY) {
    tried.push("xclip", "xsel");
    if (await run("xclip", ["-selection", "clipboard"], text)) return { ok: true, method: "xclip" };
    if (await run("xsel", ["--clipboard", "--input"], text)) return { ok: true, method: "xsel" };
  }

  const write =
    options.writeTerminal === undefined ? defaultTerminalWriter() : options.writeTerminal;
  if (write && Buffer.byteLength(text, "utf8") <= MAX_OSC52_TEXT_BYTES) {
    write(buildOsc52Sequence(text, Boolean(env.TMUX)));
    return { ok: true, method: "osc52" };
  }

  const bridges = tried.length
    ? `${tried.join(", ")} unavailable or failed`
    : "no Wayland or X11 display";
  const terminal = write ? "text too large for OSC 52" : "no terminal attached for OSC 52";
  return { ok: false, reason: `${bridges}; ${terminal}` };
}

const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;

interface ClipboardImage {
  data: Buffer;
  mediaType: "image/png";
}

type CommandRunner = (file: string, args: string[]) => Promise<Buffer>;

function runBuffer(file: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "buffer", maxBuffer: MAX_CLIPBOARD_IMAGE_BYTES + 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(Buffer.from(stdout));
      },
    );
  });
}

function isPng(data: Buffer): boolean {
  return (
    data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  );
}

function validatePng(data: Buffer): ClipboardImage {
  if (!isPng(data)) throw new Error("The clipboard does not contain a supported PNG image.");
  if (data.length > MAX_CLIPBOARD_IMAGE_BYTES)
    throw new Error("The clipboard image exceeds the 20 MiB limit.");
  return { data, mediaType: "image/png" };
}

async function firstSuccessful(attempts: Array<() => Promise<Buffer>>): Promise<Buffer> {
  for (const attempt of attempts) {
    try {
      const data = await attempt();
      if (data.length > 0) return data;
    } catch {
      // Try the next platform-appropriate clipboard bridge.
    }
  }
  throw new Error("No PNG image is available on the system clipboard.");
}

async function readMacClipboard(run: CommandRunner): Promise<Buffer> {
  try {
    return await run("pngpaste", ["-"]);
  } catch {
    const tempDir = await mkdtemp(join(tmpdir(), "ubume-clipboard-"));
    const outputPath = join(tempDir, "clipboard.png");
    const applePath = outputPath.replace(/\\/g, "\\\\").replace(/\"/g, '\\"');
    try {
      await run("osascript", [
        "-e",
        "set imageData to the clipboard as «class PNGf»",
        "-e",
        `set imageFile to open for access POSIX file \"${applePath}\" with write permission`,
        "-e",
        "set eof imageFile to 0",
        "-e",
        "write imageData to imageFile",
        "-e",
        "close access imageFile",
      ]);
      return await readFile(outputPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

const WINDOWS_CLIPBOARD_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms;",
  "Add-Type -AssemblyName System.Drawing;",
  "$image=[System.Windows.Forms.Clipboard]::GetImage();",
  "if ($null -eq $image) { exit 2 };",
  "$stream=New-Object System.IO.MemoryStream;",
  "$image.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png);",
  "[Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()));",
].join("");

async function readWindowsClipboard(
  run: CommandRunner,
  executable = "powershell.exe",
): Promise<Buffer> {
  const encoded = await run(executable, [
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-Command",
    WINDOWS_CLIPBOARD_SCRIPT,
  ]);
  return Buffer.from(encoded.toString("utf8").trim(), "base64");
}

/**
 * Reads a bounded PNG through platform bridges. Missing/invalid/oversized image data rejects;
 * temporary macOS bridge files are removed in finally.
 */
export async function readClipboardImage(
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: CommandRunner } = {},
): Promise<ClipboardImage> {
  const targetPlatform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runBuffer;
  let data: Buffer;

  if (targetPlatform === "win32") {
    data = await readWindowsClipboard(run);
  } else if (targetPlatform === "darwin") {
    data = await readMacClipboard(run);
  } else if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    data = await firstSuccessful([
      () => readWindowsClipboard(run),
      () => run("wl-paste", ["--no-newline", "--type", "image/png"]),
      () => run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]),
    ]);
  } else {
    data = await firstSuccessful([
      () => run("wl-paste", ["--no-newline", "--type", "image/png"]),
      () => run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]),
    ]);
  }

  return validatePng(data);
}
