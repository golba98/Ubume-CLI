/** Temporary provider CLI doubles. Callers own child processes and fixture-directory cleanup. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeExecutable {
  path: string;
  dir: string;
  readLog(): unknown[];
  cleanup(): void;
}

/**
 * Writes a throwaway Node script that stands in for a provider CLI. `scenario`
 * is embedded as JSON so the script needs no environment, and `logPath`
 * collects whatever the script chooses to record for assertions. The caller owns
 * child termination and must call cleanup after the child exits. Cleanup is idempotent.
 * Construction removes its directory if writing fails; unserializable scenarios fail
 * before creating filesystem resources.
 */
export function createFakeExecutable(
  name: string,
  body: string,
  scenario: unknown = {},
): FakeExecutable {
  const serializedScenario = JSON.stringify(scenario);
  const dir = mkdtempSync(join(tmpdir(), `ubume-fake-${name}-`));
  const path = join(dir, name);
  const logPath = join(dir, "log.jsonl");
  try {
    writeFileSync(logPath, "");
    writeFileSync(
      path,
      [
        "#!/usr/bin/env node",
        `const scenario = ${serializedScenario};`,
        `const logPath = ${JSON.stringify(logPath)};`,
        'const log = (entry) => require("node:fs").appendFileSync(logPath, JSON.stringify(entry) + "\\n");',
        body,
      ].join("\n"),
      { mode: 0o700 },
    );
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    dir,
    readLog(): unknown[] {
      return readFileSync(logPath, "utf8")
        .split("\n")
        .flatMap((line, index) => {
          if (!line) return [];
          try {
            return [JSON.parse(line) as unknown];
          } catch (cause) {
            throw new Error(`Invalid JSON in fake executable log ${logPath}:${index + 1}`, {
              cause,
            });
          }
        });
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Script source for fake CLIs using newline-delimited JSON. Retains partial UTF-8 chunks,
 * ignores empty lines, and intentionally surfaces malformed JSON as a script failure.
 */
export const FAKE_STDIO_READER = `
let buffer = "";
const onLine = (handler) => {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) handler(JSON.parse(line));
    }
  });
};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
`;
