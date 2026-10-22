import { spawn } from "node:child_process";
import type { WorkspaceRelaunchPlan } from "./launchContext.js";

export interface WorkspaceHandoff {
  kind: "workspace-relaunch";
  plan: WorkspaceRelaunchPlan;
  returnResumeId?: string;
}

export function isWorkspaceHandoff(value: unknown): value is WorkspaceHandoff {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "workspace-relaunch" &&
    "plan" in value
  );
}

/** Called only after the old renderer and terminal input have been disposed. */
export async function runWorkspaceHandoff(plan: WorkspaceRelaunchPlan): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: "inherit",
      shell: false,
    });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const release = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", (error) => {
      release();
      reject(error);
    });
    child.once("close", (code, signal) => {
      release();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
