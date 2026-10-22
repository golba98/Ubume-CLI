/**
 * Two real Ubume processes share `~/.ubume-settings.json`. Each one loads the file, then they
 * save different preferences one after the other; neither save may undo the other's change.
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const persistence = join(dirname(fileURLToPath(import.meta.url)), "persistence.ts");

/** Runs one child Bun process to completion and resolves its exit code. */
function runChild(args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

const CHILD = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { loadSettings, saveSettings } = await import(${JSON.stringify(persistence)});
const [role, dir] = process.argv.slice(2);
const wait = async (check) => { while (!check()) await new Promise((r) => setTimeout(r, 10)); };
const settings = loadSettings();
writeFileSync(join(dir, "loaded-" + role), "");
await wait(() => existsSync(join(dir, "loaded-a")) && existsSync(join(dir, "loaded-b")));
if (role === "a") {
  saveSettings({ ...settings, ui: { ...settings.ui, theme: "purple" } });
} else {
  // Save only after the other process has written, with this process's stale snapshot.
  await wait(() => readFileSync(join(process.env.HOME, ".ubume-settings.json"), "utf8").includes("purple"));
  saveSettings({ ...settings, ui: { ...settings.ui, startupLogoStyle: "minimal" } });
}
`;

test("concurrent instances keep each other's settings changes", async () => {
  const home = mkdtempSync(join(tmpdir(), "ubume-settings-race-"));
  try {
    writeFileSync(
      join(home, ".ubume-settings.json"),
      JSON.stringify({ ui: { theme: "dark", startup_logo_style: "full" }, extra: { kept: true } }),
    );
    const script = join(home, "child.ts");
    writeFileSync(script, CHILD);
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    expect(
      await Promise.all(["a", "b"].map((role) => runChild([script, role, home], env))),
    ).toEqual([0, 0]);

    const saved = JSON.parse(readFileSync(join(home, ".ubume-settings.json"), "utf8"));
    expect(saved.ui.theme).toBe("purple");
    expect(saved.ui.startup_logo_style).toBe("minimal");
    // Keys Ubume does not model survive both saves.
    expect(saved.extra).toEqual({ kept: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
