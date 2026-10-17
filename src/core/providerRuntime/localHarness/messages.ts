import { isRecord } from "../../shared/values.js";
import type { ProviderChatRequest } from "../types.js";
import { LOCAL_STREAM_IDLE_TIMEOUT_MS, sanitizedEndpoint } from "./config.js";

export const MAX_DISPLAY_REASONING_CHARS = 32_768;

export const REASONING_TRUNCATED_PREFIX = "… Earlier reasoning omitted for memory safety.\n";

/** Returns recovery guidance for a Harness memory safety stop. */
export function harnessMemoryLimitMessage(): string {
  return "Local Harness hit a RAM safety limit (1 GiB process RAM or 768 MiB Node heap). The turn was stopped to protect your system. The partial response remains visible; your next prompt will start a fresh Harness session.";
}

/** Collects text from supported nested content blocks, ignoring malformed/non-text blocks. */
export function textFromContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((block) => {
      if (!isRecord(block)) return [];
      if ((block.type === "text" || block.type === "output_text") && typeof block.text === "string")
        return [block.text];
      if (Array.isArray(block.content)) return [textFromContent(block.content)];
      return [];
    })
    .join("");
}

/** Formats a nonnegative rounded token count for diagnostics. */
export function formatTokens(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

/** Creates the Local cancellation error recognized by callers. */
export function abortError(): DOMException {
  return new DOMException("Local request cancelled.", "AbortError");
}

/**
 * Replaces known concrete secrets in diagnostic stderr; callers supply the active connection
 * secrets.
 */
export function redactStderr(stderr: string, secrets: readonly string[]): string {
  return secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), stderr).trim();
}

/** Builds backend/model/endpoint diagnostics with URL credentials removed. */
export function describeLocalRoute(request: ProviderChatRequest): string[] {
  return [
    `Backend: ${request.resolvedLocalAgentConfig?.localBackend ?? request.route.localBackend ?? "local"}`,
    `Model: ${request.route.modelId}`,
    `Endpoint: ${sanitizedEndpoint(request.resolvedLocalAgentConfig?.baseUrl ?? request.localConfig?.baseUrl ?? "")}`,
  ];
}

/** Adds route-specific streaming/tool or idle-timeout recovery guidance to a model failure. */
export function formatModelRequestFailure(
  message: string,
  code: unknown,
  request: ProviderChatRequest,
): string {
  return [
    `Local agent request failed: ${message}`,
    "",
    `Backend: ${request.resolvedLocalAgentConfig?.localBackend ?? request.route.localBackend ?? "local"}`,
    `Model: ${request.route.modelId}`,
    `Endpoint: ${sanitizedEndpoint(request.resolvedLocalAgentConfig?.baseUrl ?? request.localConfig?.baseUrl ?? "")}`,
    "",
    code === "TIMEOUT"
      ? `The Local server sent no output for ${LOCAL_STREAM_IDLE_TIMEOUT_MS / 60_000} minutes. This usually means it is overloaded: system RAM is exhausted so model weights page from disk, or a very large uncached prompt (context compaction, restored history) is still being processed. Check the server's memory use; for llama.cpp, a smaller --cache-ram or --parallel 1 reduces RAM pressure.`
      : "Verify that the server supports OpenAI-compatible streaming and native tool/function calling, and that the model's chat template has tool support enabled.",
  ].join("\n");
}
