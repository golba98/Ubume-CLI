/** Existing selection/focus conventions, with a real renderer preview of runtime metadata. */
import { Box, Text, useFocus, useInput } from "ink";
import { useState } from "react";
import { STARTUP_LOGO_RENDERERS, type StartupLogoRendering } from "../../config/settings.js";
import { logoRendererStatus } from "../../core/terminal/startupGraphics.js";
import { PanelLayoutContext, usePanelLayout } from "../layout.js";
import { StartupGraphicRow } from "../render/StartupGraphicRow.js";
import { useStartupGraphicsCapabilities } from "../render/useStartupGraphicsCapabilities.js";
import { useStartupLogoAnimation } from "../render/useStartupLogoAnimation.js";
import { useStartupLogoGraphic } from "../render/useStartupLogoGraphic.js";
import { useTheme } from "../theme.js";
import { buildCompactStartupRows } from "../timeline/measure/startupBrandingRows.js";
import type { IntroRenderTimelineItem } from "../timeline/measure/types.js";
import { TimelineRowView } from "../timeline/TimelineRows.js";
import { SelectionPanel } from "./SelectionPanel.js";

interface Props {
  focusId: string;
  value: StartupLogoRendering;
  item: IntroRenderTimelineItem;
  animation: boolean;
  onSelect(value: StartupLogoRendering): void;
  onCancel(): void;
}
function Preview({
  item,
  renderer,
  animate,
  width,
}: {
  item: IntroRenderTimelineItem;
  renderer: StartupLogoRendering;
  animate: boolean;
  width: number;
}) {
  const frame = useStartupLogoAnimation(animate);
  const id = useStartupLogoGraphic(frame, renderer, width >= 40);
  const rows = buildCompactStartupRows(item, width, frame)!;
  return (
    <Box flexDirection="column" height={3} flexShrink={0} overflow="hidden">
      {rows.map((row, index) =>
        id === null ? (
          <TimelineRowView key={row.key} row={row} />
        ) : (
          <StartupGraphicRow key={row.key} row={row} imageId={id} index={index} padding={0} />
        ),
      )}
    </Box>
  );
}
function PreviewKeys({ focusId, replay, back }: { focusId: string; replay(): void; back(): void }) {
  const { isFocused } = useFocus({ id: focusId, autoFocus: true });
  useInput(
    (input, key) => {
      if (key.escape || key.return) back();
      else if (input === "r") replay();
    },
    { isActive: isFocused },
  );
  return null;
}
export function LogoRenderingPanel({ focusId, value, item, animation, onSelect, onCancel }: Props) {
  const layout = usePanelLayout() ?? {
    mode: "regular" as const,
    availableRows: 16,
    availableCols: 80,
  };
  const theme = useTheme();
  const { capabilities, trueColor } = useStartupGraphicsCapabilities();
  const [selected, setSelected] = useState(value);
  const [generation, setGeneration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewOnly, setPreviewOnly] = useState(false);
  const showStatus = layout.availableRows >= 4;
  const inline = layout.availableRows >= 13;
  const replay = () => {
    setGeneration((v) => v + 1);
    setPlaying(true);
    if (!inline) setPreviewOnly(true);
  };
  const status = logoRendererStatus(selected, capabilities, trueColor);
  const preview = (
    <Preview
      key={generation}
      item={item}
      renderer={selected}
      animate={playing && animation && process.env.UBUME_NO_STARTUP_ANIMATION !== "1"}
      width={layout.availableCols}
    />
  );
  if (previewOnly)
    return (
      <Box flexDirection="column" height={Math.min(5, layout.availableRows)} overflow="hidden">
        <PreviewKeys
          focusId={focusId}
          replay={replay}
          back={() => {
            setPreviewOnly(false);
            setPlaying(false);
          }}
        />
        {preview}
        {layout.availableRows >= 5 && (
          <Text color={theme.textMuted} wrap="truncate">
            {status}
          </Text>
        )}
        {layout.availableRows >= 4 && <Text color={theme.textMuted}>r replay · Esc back</Text>}
      </Box>
    );
  return (
    <Box flexDirection="column">
      {inline && preview}
      {showStatus && (
        <Text color={theme.textMuted} wrap="truncate">
          {status}
        </Text>
      )}
      <PanelLayoutContext.Provider
        value={{
          ...layout,
          availableRows: Math.max(1, layout.availableRows - (inline ? 4 : showStatus ? 1 : 0)),
        }}
      >
        <SelectionPanel
          focusId={focusId}
          title="Logo Rendering"
          subtitle="Preview uses the actual terminal renderer"
          items={[
            ...STARTUP_LOGO_RENDERERS.map((entry) => ({
              label: entry.label + (entry.id === value ? "  ✓" : ""),
              value: entry.id,
            })),
            { label: "Preview / Replay", value: "preview" },
          ]}
          initialValue={selected}
          onHighlight={(next) => {
            if (next !== "preview") {
              setSelected(next as StartupLogoRendering);
              setPlaying(false);
            }
          }}
          onSelect={(next) =>
            next === "preview" ? replay() : onSelect(next as StartupLogoRendering)
          }
          onReplay={replay}
          onCancel={onCancel}
        />
      </PanelLayoutContext.Provider>
    </Box>
  );
}
