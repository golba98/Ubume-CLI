#!/usr/bin/env node
/**
 * Deterministic output producer for the stream benchmark. It never contacts a
 * provider. Mode and size come from the environment so the same script can act
 * as a plain subprocess or as a fake `codex` executable (any argv is accepted).
 *
 *   BENCH_MODE=lines     BENCH_BYTES ascii lines on stdout, honoring backpressure
 *   BENCH_MODE=paced     BENCH_RECORDS timestamped lines, one every BENCH_INTERVAL_MS
 *   BENCH_MODE=utf8      multibyte text written in pieces that split code points
 *   BENCH_MODE=codex     Codex JSONL: tool outputs totalling BENCH_BYTES, then an answer
 *   BENCH_MODE=answer    Codex JSONL: BENCH_BYTES of assistant text in 64 KiB messages
 */
const mode = process.env.BENCH_MODE ?? "lines";
const bytes = Number(process.env.BENCH_BYTES ?? 1024 * 1024);
const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("codex-cli 0.200.0");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log("Usage: codex exec [--json] [--experimental-json]");
  process.exit(0);
}

const now = () => performance.timeOrigin + performance.now();
const write = (text) =>
  new Promise((resolve) => {
    if (process.stdout.write(text)) resolve();
    else process.stdout.once("drain", resolve);
  });

async function drainStdin() {
  if (mode !== "codex" && mode !== "answer") return;
  for await (const _ of process.stdin);
}

/** UTF-8 samples covering 2-, 3- and 4-byte sequences and a ZWJ emoji cluster. */
export const UTF8_SAMPLE = "é漢字👩🏽‍💻ñ€";

async function main() {
  await drainStdin();
  if (mode === "lines") {
    const line = `${"x".repeat(99)}\n`;
    const block = line.repeat(640); // 64,000 bytes
    let written = 0;
    while (written < bytes) {
      await write(block);
      written += block.length;
    }
  } else if (mode === "paced") {
    const records = Number(process.env.BENCH_RECORDS ?? 300);
    const interval = Number(process.env.BENCH_INTERVAL_MS ?? 5);
    for (let i = 0; i < records; i += 1) {
      await write(`T ${now().toFixed(3)}\n`);
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  } else if (mode === "utf8") {
    const encoded = Buffer.from(UTF8_SAMPLE.repeat(Number(process.env.BENCH_REPEAT ?? 400)));
    // Odd piece sizes split most multibyte sequences; the pause forces separate reads.
    for (let offset = 0; offset < encoded.length; offset += 7) {
      await write(encoded.subarray(offset, offset + 7));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } else if (mode === "codex") {
    const event = (type, item) => write(`${JSON.stringify({ type, item })}\n`);
    await write(`${JSON.stringify({ type: "thread.started", thread_id: "bench-thread" })}\n`);
    const output = "o".repeat(32 * 1024);
    let written = 0;
    for (let i = 0; written < bytes; i += 1) {
      await event("item.completed", {
        id: `tool-${i}`,
        type: "command_execution",
        command: "cat fixture",
        status: "completed",
        aggregated_output: output,
        exit_code: 0,
      });
      written += output.length + 120;
    }
    await event("item.completed", { id: "answer", type: "agent_message", text: "bench answer" });
    await write(`${JSON.stringify({ type: "turn.completed" })}\n`);
  } else if (mode === "answer") {
    const event = (type, item) => write(`${JSON.stringify({ type, item })}\n`);
    await write(`${JSON.stringify({ type: "thread.started", thread_id: "bench-thread" })}\n`);
    const text = `${"a".repeat(64 * 1024 - 1)}\n`;
    let written = 0;
    for (let i = 0; written < bytes; i += 1) {
      await event("item.completed", { id: `answer-${i}`, type: "agent_message", text });
      written += text.length;
    }
    await write(`${JSON.stringify({ type: "turn.completed" })}\n`);
  }
}

await main();
