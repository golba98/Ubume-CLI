import { DEFAULT_BACKEND } from "../../config/settings.js";
import { codexSubprocessProvider } from "./codexSubprocess.js";
import type { BackendProvider } from "./types.js";

const BACKEND_PROVIDERS: BackendProvider[] = [codexSubprocessProvider];

/** Returns a registered low-level backend, then the configured default, then Codex. */
export function getBackendProvider(id: string): BackendProvider {
  return (
    BACKEND_PROVIDERS.find((provider) => provider.id === id) ??
    BACKEND_PROVIDERS.find((provider) => provider.id === DEFAULT_BACKEND) ??
    codexSubprocessProvider
  );
}
