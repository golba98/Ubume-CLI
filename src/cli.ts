import { runTerminalCommand } from "./headless/commands.js";

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
    if (process.stdin.readable && !process.stdin.isTTY) process.stdin.destroy();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    process.exitCode = await runTerminalCommand(process.argv.slice(2), undefined, {
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
