#!/usr/bin/env node
/**
 * Credential-free AGY executable for headless and usage regression tests.
 * UBUME_TEST_AGY_USAGE selects protocol failures; prompt markers exercise auth
 * and interruption paths. The caller owns process termination and fixture files.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  const result = index === -1 ? undefined : args[index + 1];
  if (result === undefined) throw new Error(`AGY fixture requires a value for ${flag}`);
  return result;
};
if (args.includes("--help")) {
  console.error("Usage of agy: --model --conversation --print --effort");
} else if (args[0] === "models") {
  console.log(
    "gemini-fixture-high\tGemini Fixture (High)\ngemini-fixture-low\tGemini Fixture (Low)\nclaude-fixture\tClaude Fixture",
  );
} else if (args.includes("-p") && ["/usage", "/credits"].includes(value("-p"))) {
  // Print-mode local commands. UBUME_TEST_AGY_USAGE selects the failure being simulated.
  const mode = process.env.UBUME_TEST_AGY_USAGE ?? "ok";
  const command = value("-p").slice(1);
  if (process.env.UBUME_TEST_AGY_LOG)
    appendFileSync(process.env.UBUME_TEST_AGY_LOG, `${JSON.stringify({ args })}\n`);
  const reply = (body) =>
    console.log(
      JSON.stringify({
        conversation_id: "",
        status: "SUCCESS",
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        ...body,
      }),
    );
  if (mode === "auth") {
    console.error("Error: authentication failed: please sign in");
    process.exitCode = 1;
  } else if (mode === "no-quota") {
    console.error("retrieving quota summary: no quota summary is available for this account");
    process.exitCode = 1;
  } else if (mode === "garbage") {
    console.log("Gemini Models\tWeekly Limit Remaining\t89%");
  } else if (mode === "turns") {
    reply({ num_turns: 1, response: "I can't check usage." });
  } else if (mode === "credits-fail" && command === "credits") {
    console.error("credits service unavailable");
    process.exitCode = 1;
  } else if (command === "credits") {
    reply({
      command: {
        name: "credits",
        data: { remaining_credits: 250, upgrade_uri: "https://antigravity.google/g1-upgrade" },
      },
    });
  } else {
    reply({
      command: {
        name: "usage",
        data: {
          description: "Within each group, models share a weekly limit and a 5-hour limit.",
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                {
                  id: "gemini-weekly",
                  name: "Weekly Limit Remaining",
                  window: "weekly",
                  remaining_fraction: 0.75,
                  reset_time: "2026-10-16T08:00:00Z",
                },
                {
                  id: "gemini-5h",
                  name: "Five Hour Limit Remaining",
                  window: "5h",
                  remaining_fraction: 0,
                  reset_time: "2026-10-09T14:00:00Z",
                },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [{ id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly" }],
            },
          ],
        },
      },
    });
  }
} else if (args.includes("-p") && value("-p") === "/effort") {
  console.log(JSON.stringify({ command: { name: "effort", data: { adjustable: false } } }));
} else if (args.includes("-p")) {
  const prompt = value("-p");
  appendFileSync(
    process.env.UBUME_TEST_AGY_LOG,
    `${JSON.stringify({ args, cwd: process.cwd() })}\n`,
  );
  if (prompt.includes("WAIT_FOR_INTERRUPT")) {
    writeFileSync(process.env.UBUME_TEST_PID_FILE, `${process.pid}`);
    setInterval(() => {}, 1000);
  } else if (prompt.includes("AUTH_FAILURE")) {
    console.error("Antigravity authentication expired; sign in with agy.");
    process.exitCode = 1;
  } else {
    console.log(`AGY_REPLY:${value("--model")}`);
  }
} else {
  console.error(`Unexpected AGY fixture arguments: ${JSON.stringify(args)}`);
  process.exitCode = 2;
}
