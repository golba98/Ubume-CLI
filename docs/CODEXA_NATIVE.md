# Codexa Native in Ubume Dev

Codexa Native runs the existing local PyTorch model. It has no cloud transport, shell tools, repository editing, or artificial answer correction. The five 934M candidates are experimental; availability is not a conversational-quality endorsement.

## Start

From this development checkout:

```sh
node scripts/configure-codexa-native.mjs --help
node scripts/configure-codexa-native.mjs
bun run dev:run
```

The configuration command reads the existing frozen checkpoint inventory and creates an ignored, machine-local registry in the Codexa integration root. It copies no weights. On this machine that registry has already been created. The `ubume-dev` shim also launches this checkout. The published `ubume` command is unchanged. Do not use `ubume-dev native` for this TUI integration: that separate legacy direct-chat shortcut retains its old configuration.

Open `/providers`, select **Codexa Native**, then **Codexa PyTorch**; use **Select model** or `/model` to choose Base, Repair, Balanced, Original 2H, or END3. No checkpoint is implicitly preferred. Type a question. The first message loads and hashes the selected checkpoint; subsequent turns reuse it. The active label and completion record identify the model. Unsupported/missing variants remain visible with an explanation.

`/codexa settings` opens generation controls. The default evaluation preset is greedy, maximum 128 new tokens, penalty 1, seed 42. The conversation preset uses native temperature 0.7/top-p 0.9 sampling. Choose **custom** to apply individual controls, including maximum output length, sampling, temperature, top-p, top-k, penalty, and seed. Sampling controls have no effect in greedy mode. This interactive preset is not the frozen formal benchmark.

Use the ordinary generation-cancel shortcut to terminate the owned Python process, `/codexa unload` to release it while retaining selection, and `/codexa replay` to replay the latest submitted prompt using its original preceding history after switching models. Provider/model changes and exit unload the process. No unrelated GPU process is stopped.

## Configuration

The provider workspace configuration supports a `codexaNative` object with `modelRoot`, `python`, `registry`, `device`, optional `systemPrompt`, `generation`, `startupTimeoutMs`, and `generationTimeoutMs`. Timeouts are 1–180 seconds, default 180 seconds. Environment alternatives are `CODEXA_NATIVE_MODEL_ROOT`, `CODEXA_NATIVE_PYTHON`, `CODEXA_NATIVE_REGISTRY`, and `CODEXA_NATIVE_DEVICE`.

Default model root is the current user's `Development/3-Python/37-LLM From Scratch (PyTorch Codexa v1)/LLM-From-Scratch`; Python is its `.venv/bin/python`. Checkpoint paths are read from `artifacts.codexa-native.local.json`, not embedded in distributable source. The registry must declare `codexa-native-registry-v1`, the verified tokenizer identity, and all five model path/hash entries. Each startup compares full checkpoint SHA256 against both the selected identity and existing sidecar before mapping weights. No format conversion or wheel installation is required; the existing script wrapper selects sibling source packages.

CUDA preflight requires at least 16 GiB available host RAM and 8 GiB free GPU memory. This conservative inference policy does not lower training or formal-diagnostic gates. The separate 180 GiB disk reserve applies to those write-producing/approved workflows, not ordinary chat, which saves no model checkpoints. Explicit `device: "cpu"` is supported but much slower. Swap pressure and desktop occupancy can make the RAM gate fail even after a prior successful chat.

## Transport and context

A single managed child process uses `codexa-native-jsonl-v2` over stdin/stdout; diagnostics never enter protocol stdout. Events are ready/status/context/delta/done/error with request identity and ordered sequences. Requests contain structured system/user/assistant history. Native tokenizer serialization, assistant prefix, END/EOS handling, KV cache, and generation implementation are reused. UTF-8 decoding is incremental and final text must equal the streamed text. Maximum protocol message size is 2 MiB.

The real context limit is 2048 tokens including the generation reservation. The native tokenizer counts the exact prompt. Old complete turns are dropped by the existing context policy and a visible notice records how many were omitted. System instructions and the latest user request cannot be silently truncated; an oversized remaining prompt fails. Each generation rebuilds its context; KV caches do not cross models or requests. Unanswered or empty turns are retained locally but omitted from native prompt history with a visible notice, so a failed request cannot poison the next turn. An empty generated answer is reported explicitly and its raw metadata is retained.

Displayed terminal text is escaped/sanitized for terminal safety; original decoded output and generation provenance are persisted in conversation metadata without answer correction. Local diagnostics record identities, errors, and timings, not prompt/response content. No model text is interpreted as an action request.

## Troubleshooting and testing

Missing Python/tokenizer/checkpoints, identity mismatch, insufficient resources, startup/generation timeout, broken protocol, process crash, context overflow, and nonfinite logits fail visibly without provider substitution. Cancellation stops loading/generation by terminating only the managed worker; a new request starts a fresh process. Local diagnostics reside under Ubume's data directory at `diagnostics/codexa-native.jsonl`, capped at 1 MiB of appends.

```sh
bun run typecheck
bun test src/core/providerRuntime/codexaNative.test.ts src/core/providerLauncher/workspaceConfig.test.ts src/ui/render/runtimeDisplay.test.ts --max-concurrency=1
```

The optional real-model smoke script requires a fresh output directory and passing resource checks; it has a ten-minute aggregate ceiling and saves only small JSON evidence. It generates a short Balanced response, cancels a reused Balanced process, then switches to END3. It does not train or write checkpoints. Do not mistake a successful integration smoke for model-quality qualification.
