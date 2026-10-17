/**
 * Browser worker contracts shared with the Local Harness. Requests carry session/call ownership
 * and policy separately; browser state and element references are ephemeral, not conversation
 * persistence.
 */

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { BrowserToolName } from "../../../bin/ubume-local-browser-tools.js";

export interface ComputerUseRequest {
  sessionId: string;
  callId: string;
  tool: BrowserToolName;
  arguments: Record<string, unknown>;
}
export interface ComputerUsePolicy {
  networkAccess: boolean;
  dshHome: string;
  signal: AbortSignal;
}
export interface BrowserPageInfo {
  url: string;
  title: string;
  loadState: string;
}
export interface BrowserElement {
  element?: string;
  role: string;
  name?: string;
  text?: string;
  checked?: boolean | "mixed";
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  level?: number;
  url?: string;
}
export interface ComputerUseValue {
  summary: string;
  page?: BrowserPageInfo;
  elements?: BrowserElement[];
  visibleText?: string;
  truncated?: boolean;
  image?: Extract<ContentBlock, { type: "image" }>["attachment"];
  artifactPath?: string;
}
export type ComputerUseResult =
  | { ok: true; value: ComputerUseValue }
  | { ok: false; error: { code: string; message: string } };
export interface ComputerUseBackend {
  execute(request: ComputerUseRequest, policy: ComputerUsePolicy): Promise<ComputerUseResult>;
  closeSession(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
  terminate(): void;
}
