import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTestEnvironment, withEnvironment } from "./environment.js";

test("subprocess environments isolate homes and remove inherited provider settings", () => {
  const inherited = {
    PATH: "/runtime/bin",
    PATHEXT: ".EXE",
    TERM: "xterm",
    HOME: "/real/home",
    USERPROFILE: "/real/profile",
    XDG_CONFIG_HOME: "/real/config",
    OPENAI_API_KEY: "private",
    ANTHROPIC_AUTH_TOKEN: "private",
    GOOGLE_APPLICATION_CREDENTIALS: "/real/credentials",
    UNSLOTH_STUDIO_URL: "https://real.service",
    CODEX_EXECUTABLE: "/real/codex",
    UBUME_PROVIDER: "real-provider",
    CODEXA_DEBUG: "1",
    CUSTOM_API_KEY: "private",
    HF_TOKEN: "private",
    NODE_OPTIONS: "--require=/real/hook.cjs",
    BUN_OPTIONS: "--preload=/real/hook.ts",
    NODE_COMPILE_CACHE: "/real/cache",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "/real/cache",
    HTTPS_PROXY: "https://user:password@real.proxy",
  };
  const before = { ...inherited };
  const env = createTestEnvironment("/fixture", {}, inherited);
  expect(inherited).toEqual(before);
  expect(env).toMatchObject({
    PATH: inherited.PATH,
    PATHEXT: inherited.PATHEXT,
    TERM: inherited.TERM,
    HOME: "/fixture",
    USERPROFILE: "/fixture",
    XDG_CONFIG_HOME: join("/fixture", "config"),
    CODEX_HOME: join("/fixture", "codex"),
    UBUME_DATA_DIR: join("/fixture", "data"),
    CODEXA_DATA_DIR: join("/fixture", "legacy"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    CODEX_EXECUTABLE: join("/fixture", "missing-codex"),
  });
  for (const name of [
    "OPENAI_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "UNSLOTH_STUDIO_URL",
    "UBUME_PROVIDER",
    "CODEXA_DEBUG",
    "CUSTOM_API_KEY",
    "HF_TOKEN",
    "NODE_OPTIONS",
    "BUN_OPTIONS",
    "NODE_COMPILE_CACHE",
    "HTTPS_PROXY",
  ]) {
    expect(env[name]).toBeUndefined();
  }
});

test("explicit fixture overrides win without mutating their inputs", () => {
  const overrides = {
    CODEX_EXECUTABLE: "/fixture/provider",
    OPENAI_API_KEY: "fixture-only",
    HOME: "/other-fixture",
    TERM: undefined,
  };
  const env = createTestEnvironment("/fixture", overrides, { TERM: "xterm" });
  expect(env).toMatchObject(overrides);
  expect(env).not.toBe(overrides);
  expect(overrides.HOME).toBe("/other-fixture");
});

test("environment patches restore absent, empty, and populated keys after async success", async () => {
  await withEnvironment(
    { UBUME_TEST_ABSENT: undefined, UBUME_TEST_EMPTY: "", UBUME_TEST_VALUE: "before" },
    async () => {
      const result = await withEnvironment(
        { UBUME_TEST_ABSENT: "created", UBUME_TEST_EMPTY: undefined, UBUME_TEST_VALUE: "during" },
        async () => {
          await Promise.resolve();
          expect(process.env.UBUME_TEST_ABSENT).toBe("created");
          expect(process.env.UBUME_TEST_EMPTY).toBeUndefined();
          expect(process.env.UBUME_TEST_VALUE).toBe("during");
          return 42;
        },
      );
      expect(result).toBe(42);
      expect(Object.hasOwn(process.env, "UBUME_TEST_ABSENT")).toBe(false);
      expect(process.env.UBUME_TEST_EMPTY).toBe("");
      expect(process.env.UBUME_TEST_VALUE).toBe("before");
    },
  );
});

test("environment patches restore values when callbacks reject or throw", async () => {
  await withEnvironment({ UBUME_TEST_RESTORE: "before" }, async () => {
    for (const asynchronous of [false, true]) {
      const failure = new Error("fixture failure");
      await expect(
        withEnvironment({ UBUME_TEST_RESTORE: "during" }, () => {
          if (asynchronous) return Promise.reject(failure);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(process.env.UBUME_TEST_RESTORE).toBe("before");
    }
  });
});
