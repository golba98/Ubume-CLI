import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeExecutable, FAKE_STDIO_READER } from "./fakeExecutable.js";

function execute(path: string) {
  return spawnSync("node", [path], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    timeout: 5000,
  });
}

test("fake executable embeds scenario data and records JSON lines", () => {
  const fixture = createFakeExecutable("record", "log(scenario); log({done:true});", {
    input: 'quoted " value',
  });
  try {
    const result = execute(fixture.path);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fixture.readLog()).toEqual([{ input: 'quoted " value' }, { done: true }]);
  } finally {
    fixture.cleanup();
    fixture.cleanup();
  }
  expect(existsSync(fixture.dir)).toBe(false);
});

test("stdio reader retains fragmented lines and processes multiple messages", () => {
  const fixture = createFakeExecutable(
    "stdio",
    `${FAKE_STDIO_READER}
onLine((message) => { log(message); send(message); });
process.stdin.emit("data", Buffer.from('{"first":'));
process.stdin.emit("data", Buffer.from('1}\\n\\n{"second":2}\\n{"third"'));
process.stdin.emit("data", Buffer.from(':3}\\n'));
process.stdin.destroy();`,
  );
  try {
    const result = execute(fixture.path);
    expect(result.status).toBe(0);
    expect(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([{ first: 1 }, { second: 2 }, { third: 3 }]);
    expect(fixture.readLog()).toEqual([{ first: 1 }, { second: 2 }, { third: 3 }]);
  } finally {
    fixture.cleanup();
  }
});

test("malformed fixture log reports its file and physical line", () => {
  const fixture = createFakeExecutable("malformed", "");
  try {
    appendFileSync(join(fixture.dir, "log.jsonl"), '\n{"valid":true}\nnot-json\n');
    expect(() => fixture.readLog()).toThrow(`${join(fixture.dir, "log.jsonl")}:3`);
  } finally {
    fixture.cleanup();
  }
});

test("unserializable scenarios and failed script writes leave no temporary directories", () => {
  const name = `circular-${randomUUID()}`;
  const relevantDirectories = () =>
    readdirSync(tmpdir()).filter(
      (entry) => entry.startsWith(`ubume-fake-${name}-`) || entry.startsWith("ubume-fake-.-"),
    );
  const before = relevantDirectories();
  const circular: { self?: unknown } = {};
  circular.self = circular;
  expect(() => createFakeExecutable(name, "", circular)).toThrow();
  // The generated executable path points at its own directory, forcing writeFile to fail.
  expect(() => createFakeExecutable(".", "")).toThrow();
  const after = relevantDirectories();
  expect(after).toEqual(before);
});

test("stdio reader surfaces malformed protocol messages instead of swallowing them", () => {
  const fixture = createFakeExecutable(
    "invalid-stdio",
    `${FAKE_STDIO_READER}
onLine(log);
process.stdin.emit("data", Buffer.from('not-json\\n'));`,
  );
  try {
    const result = execute(fixture.path);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SyntaxError");
    expect(fixture.readLog()).toEqual([]);
  } finally {
    fixture.cleanup();
  }
});

test("stdio reader preserves UTF-8 characters split across separate stdin reads", () => {
  const fixture = createFakeExecutable(
    "unicode-stdio",
    `${FAKE_STDIO_READER}
onLine((message) => { log(message); send(message); });
process.stdin.on("data", () => process.stdout.write("ACK\\n"));`,
  );
  // Wait for a child acknowledgement before writing the remaining bytes. This
  // guarantees separate reads without relying on OS buffering or timing sleeps.
  const driver = `
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const child = spawn(process.execPath, [process.argv[1]], {
  env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "inherit"],
});
process.on("SIGTERM", () => { child.kill(); process.exit(1); });
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("close", (code) => { process.exitCode = code ?? 1; });
const input = Buffer.from(JSON.stringify({ message: "A界🙂B" }) + "\\n");
const split = input.indexOf(Buffer.from("界")) + 1;
let acknowledged = false;
createInterface({ input: child.stdout }).on("line", (line) => {
  if (line === "ACK") {
    if (!acknowledged) {
      acknowledged = true;
      child.stdin.end(input.subarray(split));
    }
  } else {
    process.stdout.write(line + "\\n");
  }
});
child.stdin.write(input.subarray(0, split));
`;
  try {
    const result = spawnSync("node", ["-e", driver, fixture.path], {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ message: "A界🙂B" });
    expect(fixture.readLog()).toEqual([{ message: "A界🙂B" }]);
  } finally {
    fixture.cleanup();
  }
});
