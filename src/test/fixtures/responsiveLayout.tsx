/** Provider-free reference screen: real shell/composer, fixed labels and no timers. */

import chalk from "chalk";
import type { StartupLogoStyle } from "../../config/settings.js";
import { resolveInkRenderInstance } from "../../core/terminal/inkRenderReset.js";
import { BottomComposer } from "../../ui/chrome/BottomComposer.js";
import { measureBottomComposerRows } from "../../ui/chrome/composer/composerModel.js";
import { createLayoutSnapshot, type TerminalViewport } from "../../ui/layout.js";
import { ThemeProvider } from "../../ui/theme.js";
import { TranscriptShell } from "../../ui/timeline/TranscriptShell.js";
import { createTestTerminal } from "../terminal.js";

export function ReferenceScreen({
  style,
  theme,
  layout,
  value = "",
  onChangeInput = () => {},
}: {
  style: StartupLogoStyle;
  theme: string;
  layout: TerminalViewport;
  value?: string;
  onChangeInput?: (value: string, cursor: number) => void;
}) {
  const noop = () => {};
  return (
    <ThemeProvider theme={theme}>
      <TranscriptShell
        layout={layout}
        authState="authenticated"
        workspaceLabel="/workspace/ubume"
        workspaceRoot="/workspace/ubume"
        runtimeSummary={{
          providerLabel: "Local",
          model: "fixture-model",
          modelLabel: "fixture-model",
          reasoningLabel: "High",
          contextLabel: "0 / 200K",
          modeLabel: "Full Access",
          sandboxLabel: "Workspace Write",
          approvalLabel: "Never",
          networkLabel: "Enabled",
          writableRootsLabel: "none",
        }}
        logoStyle={style}
        startupAnimation={false}
        startupLogoRendering="solid"
        staticEvents={[]}
        activeEvents={[]}
        uiState={{ kind: "IDLE" }}
        composerRows={measureBottomComposerRows({
          layout,
          uiState: { kind: "IDLE" },
          value,
          cursor: value.length,
        })}
        composer={
          <BottomComposer
            layout={layout}
            uiState={{ kind: "IDLE" }}
            themeName={theme}
            model="Local / fixture-model"
            footerModelDisplay="Local / fixture-model (High)"
            value={value}
            cursor={value.length}
            onChangeInput={onChangeInput}
            onSubmit={noop}
            onCancel={noop}
            onHistoryUp={noop}
            onHistoryDown={noop}
            onOpenModelPicker={noop}
            onCycleMode={noop}
            onQuit={noop}
          />
        }
      />
    </ThemeProvider>
  );
}

export async function captureReferenceScreen(
  style: StartupLogoStyle,
  theme: string,
  columns = 100,
  rows = 22,
  value = "",
  screenOnly = false,
) {
  const layout = createLayoutSnapshot(columns, rows);
  const previousColorLevel = chalk.level;
  chalk.level = 3;
  const terminal = createTestTerminal(
    <ReferenceScreen style={style} theme={theme} layout={layout} value={value} />,
    { columns, rows },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const ink = resolveInkRenderInstance(terminal.stdout);
    const output = screenOnly
      ? `${ink?.fullStaticOutput ?? ""}${ink?.lastOutput ?? terminal.lastFrame()}`
      : terminal.output();
    return output.replace(/v\d+\.\d+\.\d+(?:-[\w.-]+)?/g, "vREFERENCE");
  } finally {
    try {
      await terminal.dispose();
    } finally {
      chalk.level = previousColorLevel;
    }
  }
}
