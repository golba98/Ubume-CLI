# Provider setup and compatibility

Provider-specific behavior that goes beyond the provider table in the main
[README](../../README.md#providers).

CLI credentials remain with the provider CLI. Direct API keys are read from the environment
or Ubume's private provider configuration.

## Anthropic / Claude

The direct Anthropic API route returns text only (no tool loop) and needs no Claude CLI. Each
request has a 120-second deadline covering connection and the full response; set
`providers.anthropic.apiTimeoutMs` (or `api_timeout_ms`) in the workspace's `providers.json` (kept in
Ubume's app data) to change it (integer milliseconds from 1 to 2,147,483,647; invalid values use the default). A timed-out request fails as a network timeout and is not retried automatically.

## Google (Antigravity)

Google runs the Antigravity CLI (`agy`), never Gemini CLI. Models come from `agy models`; native model identifiers are passed unchanged to `agy -p ... --model ...`. Set `AGY_EXECUTABLE` or `providers.google.antigravity_command_path` for a custom executable. Authentication and native tool permissions remain managed by AGY.

Saved `antigravity` selections and native sessions remain available as Google. Proven Antigravity settings take precedence; removed Google CLI settings are retained as inactive migration data. Ambiguous old Google routes require explicit Google/model selection. Credentials and native session stores are not rewritten.

The recovered adapter buffers responses until AGY completes and supplies saved Ubume history in the prompt. It does not expose structured tool events, token streaming, or image input. Native conversations can be resumed through AGY’s `--conversation` handoff. Discovery failures retain a clearly unverified AGY cache for display, but execution requires live validation and never substitutes another model.

## Mistral Vibe

Mistral's picker separates configured Vibe models from API-discovered custom models. Configured routes retain their model settings and provider; API custom routes require a verified catalogue refresh and say "Custom via Vibe (request unverified)." "Vibe current/default" follows Vibe's saved active/default selection and inherited environment overrides. Catalogue availability does not prove successful inference; Mistral Large 4 execution remains unverified.

### Model discovery

Ubume reads the installed Vibe effective configuration, including its built-in models, configured aliases and cached model-routing assignments. The picker retains Vibe’s labels and current Default entry. API-only model inventories are not added to the native picker. The reader skips Vibe configuration migrations and emits only model settings, never credentials. If the installed Vibe configuration API cannot be read, Ubume shows configured models with an unverified discovery notice. Remote routing changes appear when Vibe updates its own assignment cache.
