/**
 * Several Ubume processes saving the same workspace's providers.json at once must neither crash
 * on a shared temporary file nor leave a truncated or interleaved file behind.
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getProviderWorkspaceConfigFile } from "./workspaceConfig.js";

const workspaceConfigModule = join(dirname(fileURLToPath(import.meta.url)), "workspaceConfig.ts");

const CHILD = `
const { saveProviderWorkspaceConfig } = await import(${JSON.stringify(workspaceConfigModule)});
const [workspace, role] = process.argv.slice(2);
for (let i = 0; i < 40; i++)
  saveProviderWorkspaceConfig(workspace, {
    workspaceDefaultProviderId: role,
    legacyProviderData: { writer: role, iteration: i, padding: "x".repeat(4096) },
  });
`;

function runChild(args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

test("concurrent providers.json saves from four processes stay whole", async () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-providers-race-"));
  try {
    const workspace = join(root, "project");
    mkdirSync(workspace);
    const script = join(root, "child.ts");
    writeFileSync(script, CHILD);
    const env = { ...process.env, UBUME_DATA_DIR: join(root, "data") };
    const roles = ["openai", "anthropic", "google", "mistral"];
    expect(
      await Promise.all(roles.map((role) => runChild([script, workspace, role], env))),
    ).toEqual([0, 0, 0, 0]);
    const previous = process.env.UBUME_DATA_DIR;
    process.env.UBUME_DATA_DIR = env.UBUME_DATA_DIR;
    try {
      const saved = JSON.parse(readFileSync(getProviderWorkspaceConfigFile(workspace), "utf8"));
      // One writer wins as a whole; the file is never a mix of two writes.
      expect(roles).toContain(saved.workspaceDefaultProviderId);
      expect(saved.legacyProviderData.writer).toBe(saved.workspaceDefaultProviderId);
    } finally {
      if (previous === undefined) delete process.env.UBUME_DATA_DIR;
      else process.env.UBUME_DATA_DIR = previous;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
