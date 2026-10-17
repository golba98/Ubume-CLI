import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Parse editor arguments without running a shell or expanding substitutions. */
export function editorCommand(value: string): string[] {
  const args: string[] = [];
  let current = "",
    quote = "",
    started = false;
  for (const char of value.trim()) {
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error("Editor command has an unclosed quote.");
  if (started || current) args.push(current);
  if (!args[0]) throw new Error("Set VISUAL or EDITOR to edit prompts externally.");
  return args;
}
/**
 * Writes a private temporary draft, invokes VISUAL/EDITOR through the supplied terminal
 * suspension boundary, then reads it back. Failures reject and temporary files are removed.
 */
export async function editExternalPrompt(
  value: string,
  suspend: (action: () => Promise<void>) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const [command, ...args] = editorCommand(env.VISUAL?.trim() || env.EDITOR?.trim() || "");
  const directory = await mkdtemp(join(tmpdir(), "ubume-prompt-"));
  const file = join(directory, "prompt.txt");
  try {
    await writeFile(file, value, { mode: 0o600 });
    await suspend(
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(command!, [...args, file], { stdio: "inherit", shell: false });
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0
              ? resolve()
              : reject(new Error("Editor closed without saving successfully; draft retained.")),
          );
        }),
    );
    return await readFile(file, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
