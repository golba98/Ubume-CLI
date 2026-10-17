import { Text } from "ink";
import type { SettingDefinition } from "../../config/settings.js";
import {
  type CodexaNativeOptions,
  codexaPreset,
  validateCodexaGeneration,
} from "../../core/providerRuntime/codexaNativeConfig.js";
import { FOCUS_IDS } from "../input/focus.js";
import { SettingsPanel } from "./SettingsPanel.js";

export function CodexaSettingsPanel({
  options,
  onSave,
  onCancel,
}: {
  options?: CodexaNativeOptions;
  onSave: (options: CodexaNativeOptions) => void;
  onCancel: () => void;
}) {
  let generation;
  try {
    generation = validateCodexaGeneration(options?.generation);
  } catch {
    return (
      <Text>
        Invalid Codexa generation settings. Correct the codexaNative configuration before opening
        settings.
      </Text>
    );
  }
  const values = Object.fromEntries(
    Object.entries(generation).map(([key, value]) => [key, value === null ? "off" : String(value)]),
  );
  const choices: Record<string, string[]> = {
    preset: ["evaluation", "conversation", "custom"],
    max_new_tokens: ["64", "128", "256", "512", "1024"],
    do_sample: ["false", "true"],
    temperature: ["0.2", "0.5", "0.7", "1"],
    top_p: ["0.8", "0.9", "0.95", "1"],
    top_k: ["off", "20", "40", "100"],
    repetition_penalty: ["1", "1.05", "1.1", "1.2"],
    seed: ["0", "42", "1234"],
  };
  const settings: SettingDefinition<string, string>[] = Object.entries(choices).map(
    ([key, items]) => ({
      key,
      label: key.replaceAll("_", " "),
      description:
        key === "preset"
          ? "Evaluation: greedy / 128 / penalty 1 / seed 42. Conversation: native sampling defaults. Choose custom to apply individual controls."
          : "Individual controls apply only with preset=custom. Temperature, top-p and top-k affect sampling only. Context: 2048 tokens; no tools.",
      options: [...new Set([...items, values[key]!])].map((value) => ({ label: value, value })),
    }),
  );
  return (
    <SettingsPanel
      focusId={FOCUS_IDS.settingsPanel}
      title="Codexa Native generation"
      settings={settings}
      values={values}
      onCancel={onCancel}
      onSave={(draft) => {
        const next =
          draft.preset === "evaluation" || draft.preset === "conversation"
            ? codexaPreset(draft.preset)
            : validateCodexaGeneration({
                preset: "custom",
                max_new_tokens: Number(draft.max_new_tokens),
                do_sample: draft.do_sample === "true",
                temperature: Number(draft.temperature),
                top_p: Number(draft.top_p),
                top_k: draft.top_k === "off" ? null : Number(draft.top_k),
                repetition_penalty: Number(draft.repetition_penalty),
                seed: Number(draft.seed),
              });
        onSave({ ...options, generation: next });
      }}
    />
  );
}
