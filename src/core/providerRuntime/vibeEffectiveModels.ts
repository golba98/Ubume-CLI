import { readFileSync } from "node:fs";
import { runCommand } from "../process/commandRunner.js";

// Use Vibe's own layered config and cached routing assignments. Never run config migrations.
export const VIBE_MODEL_PROBE = `
import asyncio, json
import vibe.core.config.default_orchestrator as loader
from vibe.core.config import load_dotenv_values
from vibe.core.config.harness_files import init_harness_files_manager
from vibe.core.config.layers.growthbook import GrowthbookLayer
from vibe.core.experiments.cache import load_cached_eval_response
from vibe.core.experiments.manager import config_variants_from_response
async def readonly(*args, **kwargs): pass
loader.migrate_config_layers = readonly
init_harness_files_manager("user", "project")
load_dotenv_values()
async def main():
    orchestrator = await loader.build_default_orchestrator()
    cached = load_cached_eval_response(orchestrator.config)
    if cached is not None:
        orchestrator.get_layer(GrowthbookLayer.NAME).set_variants(config_variants_from_response(cached))
        await orchestrator.reload()
    config = orchestrator.config
    fields = {"name", "alias", "provider", "display_name", "thinking", "thinking_levels", "supports_images", "max_context_length", "temperature"}
    print(json.dumps({"models": [m.model_dump(mode="json", include=fields) for m in config.available_models().values()], "active_model": config.active_model, "default_label": (config.models[config.resolve_default_model_alias()].display_name or config.resolve_default_model_alias())}))
asyncio.run(main())
`;

/**
 * Reads Vibe's effective model configuration through its installed Python interpreter, with
 * timeout/abort and subprocess cleanup. Unsupported installations or malformed output reject.
 */
export async function probeVibeEffectiveModels(options: {
  executable: string;
  cwd: string;
  signal?: AbortSignal;
  runCommandImpl?: typeof runCommand;
}): Promise<unknown> {
  const firstLine = readFileSync(options.executable, "utf8").split("\n")[0] ?? "";
  const interpreter = firstLine.match(/^#!(\/[^\r\n]+)\r?$/)?.[1];
  if (!interpreter)
    throw new Error("Installed Vibe does not expose a Python configuration reader.");
  const child = (options.runCommandImpl ?? runCommand)({
    executable: interpreter,
    args: ["-c", VIBE_MODEL_PROBE],
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: 10_000,
  });
  const result = await child.result;
  await child.stopped;
  if (result.status !== "completed" || result.exitCode !== 0)
    throw new Error("Unable to read the installed Vibe effective model configuration.");
  return JSON.parse(result.stdout);
}
