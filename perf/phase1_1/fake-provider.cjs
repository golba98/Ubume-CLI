// Local protocol fixture. It never opens a network connection or performs inference.
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  "/bench/fake-invocations.jsonl",
  JSON.stringify({ exe: fs.realpathSync(process.argv[1]), args }) + "\n",
);
if (args[0] === "app-server") {
  require("node:readline")
    .createInterface({ input: process.stdin })
    .on("line", (line) => {
      const request = JSON.parse(line);
      if (request.id == null) return;
      const result =
        request.method === "model/list"
          ? {
              data: [
                {
                  id: "gpt-5.4",
                  model: "gpt-5.4",
                  displayName: "gpt-5.4",
                  isDefault: true,
                  supportedReasoningEfforts: [],
                  defaultReasoningEffort: "medium",
                },
              ],
              nextCursor: null,
            }
          : {};
      console.log(JSON.stringify({ id: request.id, result }));
    });
} else if (args[0] === "model") {
  console.log(JSON.stringify({ models: [] }));
} else if (args[0] === "login" || args[0] === "auth") {
  console.log("Logged in using ChatGPT");
} else if (args.includes("--version")) {
  console.log("offline-fake 0.0.0");
} else if (args.includes("exec")) {
  process.stdin.resume();
  process.stdin.on("end", async () => {
    const size = Number(process.env.HEADLESS_BYTES || 0);
    const parts = size ? Math.ceil(size / 65536) : 1;
    for (let i = 0; i < parts; i++) {
      const text = size ? "x".repeat(Math.min(65536, size - i * 65536)) : "offline fake answer";
      const event =
        JSON.stringify({
          type: "item.completed",
          item: { id: `answer-${i}`, type: "agent_message", text },
        }) + "\n";
      if (!process.stdout.write(event))
        await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
    console.log(JSON.stringify({ type: "turn.completed" }));
  });
} else {
  console.error("unsupported offline invocation");
  process.exitCode = 97;
}
