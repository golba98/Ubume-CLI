import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestEnvironment } from "../../../test/environment.js";
import { workspaceStorageKey } from "../../workspace/appData.js";

for (const backend of ["lm-studio", "unsloth"] as const)
  test(`${backend} resumes durable harness context and chat identity across complete Ubume process restarts`, {
    timeout: 30000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "ubume-process-resume-"));
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const server = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url?.endsWith("/models")) {
        response.end(
          JSON.stringify({
            data: [{ id: "fixture", loaded: true }],
            models: [
              {
                key: "fixture",
                type: "llm",
                loaded_instances: [{ id: "fixture" }],
                capabilities: { trained_for_tool_use: true },
                context_length: 8192,
              },
            ],
          }),
        );
        return;
      }
      if (request.url === "/api/inference/status") {
        response.end(
          JSON.stringify({ active_model: "fixture", supports_tools: true, context_length: 8192 }),
        );
        return;
      }
      if (request.url === "/v1/chat/completions") {
        let text = "";
        for await (const chunk of request) text += chunk.toString();
        bodies.push(JSON.parse(text));
        response.setHeader("Content-Type", "text/event-stream");
        response.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: `saved answer ${bodies.length}` }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const fixture = fileURLToPath(
      new URL("../../../test/fixtures/localResume.ts", import.meta.url),
    );
    const run = (turn: number) =>
      new Promise<{
        id: string;
        harness: { sessionId: string; throughMessageCount: number };
        answer: string;
      }>((resolve, reject) => {
        const child = spawn(process.execPath, [fixture, backend, String(turn)], {
          cwd: root,
          env: createTestEnvironment(root, {
            UBUME_DATA_DIR: join(root, "data"),
            CODEXA_DATA_DIR: join(root, "data"),
            UBUME_LOCAL_BASE_URL: `${endpoint}/v1`,
            UBUME_LOCAL_MODEL: "fixture",
            UNSLOTH_STUDIO_URL: endpoint,
            UNSLOTH_API_KEY: "fixture",
          }),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`fixture timed out: ${stderr}`));
        }, 20000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error(stderr));
          else {
            try {
              resolve(JSON.parse(stdout.trim()));
            } catch {
              reject(new Error(stdout + stderr));
            }
          }
        });
      });
    try {
      const first = await run(1);
      const second = await run(2);
      assert.equal(second.id, first.id);
      assert.equal(second.harness.sessionId, first.harness.sessionId);
      assert.equal(first.harness.throughMessageCount, 2);
      assert.equal(second.harness.throughMessageCount, 4);
      assert.equal(bodies.length, 2);
      assert(
        bodies[1]?.messages.some(
          (message) =>
            message.role === "assistant" &&
            JSON.stringify(message.content).includes("saved answer 1"),
        ),
        "second process receives durable assistant history",
      );
      assert(existsSync(join(root, "data", "chats", workspaceStorageKey(root), "workspace.json")));
      assert.equal(existsSync(join(root, ".ubume", "chats")), false);
      const snapshotPath = join(
        root,
        "data",
        "chats",
        workspaceStorageKey(root),
        "conversations",
        first.id,
        "snapshot.json",
      );
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
      snapshot.metadata.localHarnessSession.sessionId = "missing-saved-session";
      writeFileSync(snapshotPath, JSON.stringify(snapshot));
      const recovered = await run(3);
      assert.equal(recovered.id, first.id);
      assert.notEqual(recovered.harness.sessionId, "missing-saved-session");
      assert.equal(recovered.harness.throughMessageCount, 6);
      assert.match(JSON.stringify(bodies[2]?.messages), /saved answer 1/);
      const oldHome = join(root, "data", "chats", workspaceStorageKey(root), "local-harness");
      assert(existsSync(oldHome), "recovery retains existing harness artifacts");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
