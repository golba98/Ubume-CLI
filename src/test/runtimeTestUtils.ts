/** Runtime fixtures use production policy normalization without loading user config. */
import {
  DEFAULT_RUNTIME_CONFIG,
  type PartialRuntimeConfig,
  type ResolvedRuntimeConfig,
  resolveRuntimeConfig,
} from "../config/runtimeConfig.js";

/**
 * Resolves defaults plus partial policy overrides into an independently mutable fixture.
 * Neither the overrides nor the shared defaults are mutated.
 */
export function createTestRuntime(overrides: PartialRuntimeConfig = {}): ResolvedRuntimeConfig {
  return resolveRuntimeConfig({
    ...DEFAULT_RUNTIME_CONFIG,
    ...overrides,
    policy: {
      ...DEFAULT_RUNTIME_CONFIG.policy,
      ...overrides.policy,
    },
  });
}

/** Shared baseline for read-only consumers. Use createTestRuntime when mutating state. */
export const TEST_RUNTIME = createTestRuntime();
