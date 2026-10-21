/** SVG rasterization is optional; solid terminals never load Sharp. */
import { useEffect, useMemo, useState } from "react";
import type { StartupLogoRendering } from "../../config/settings.js";
import * as renderDebug from "../../core/perf/renderDebug.js";
import {
  type LogoCellSize,
  STARTUP_LOGO_BASE_SIZE,
} from "../../core/shared/startupLogoDimensions.js";
import { effectiveLogoRenderer } from "../../core/terminal/startupGraphics.js";
import { useTheme } from "../theme.js";
import {
  FINAL_STARTUP_LOGO_FRAME,
  STARTUP_LOGO_FRAMES,
  type StartupLogoAnimationFrame,
} from "./startupAnimation.js";
import { isSvgLogoColor, startupLogoSvg } from "./startupLogoAsset.js";
import { rasterizeStartupLogo } from "./startupLogoRaster.js";
import { useStartupGraphicsCapabilities } from "./useStartupGraphicsCapabilities.js";

export function useStartupLogoGraphic(
  frame: StartupLogoAnimationFrame,
  requested: StartupLogoRendering,
  enabled: boolean,
  rasterizer = rasterizeStartupLogo,
  size: LogoCellSize = STARTUP_LOGO_BASE_SIZE,
  paused = false,
) {
  const { channel, capabilities: caps, trueColor } = useStartupGraphicsCapabilities();
  const theme = useTheme();
  const svg = useMemo(
    () =>
      startupLogoSvg(
        frame.pose,
        { primary: theme.logoPrimary, secondary: theme.logoSecondary, highlight: theme.text },
        frame.impact,
      ),
    [frame, theme.logoPrimary, theme.logoSecondary, theme.text],
  );
  const backend = effectiveLogoRenderer(requested, caps);
  const { columns, rows } = size;
  const options = useMemo(
    () => ({
      backend: backend === "solid" ? ("kitty" as const) : backend,
      cellWidth: caps.cellWidth ?? 10,
      cellHeight: caps.cellHeight ?? 24,
      background: caps.background ?? theme.bg,
      size: { columns, rows },
    }),
    [backend, caps.cellWidth, caps.cellHeight, caps.background, theme.bg, columns, rows],
  );
  // Pixel metrics and the cell region both identify an asset: a stale size
  // must never be placed into a differently sized region.
  const geometry = `${options.cellWidth}x${options.cellHeight}:${columns}x${rows}`;
  const [asset, setAsset] = useState<{ backend: string; geometry: string; id: number } | null>(
    null,
  );
  // RGB foreground encodes the Kitty image ID; quantizing it would address a
  // different image. Reduced-color terminals keep the theme-colored solid mark.
  const graphical =
    enabled &&
    trueColor &&
    [theme.logoPrimary, theme.logoSecondary, theme.text].every(isSvgLogoColor) &&
    backend !== "solid";
  useEffect(() => {
    if (enabled && requested !== "solid") channel?.probe();
  }, [channel, enabled, requested]);
  useEffect(() => {
    if (!graphical || !channel || paused) return;
    let cancelled = false;
    void rasterizer(svg, options)
      .then((result) => {
        if (cancelled) return;
        channel.stage(result.id, result.png, result.tiles, options.size);
        setAsset({ backend, geometry, id: result.id });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Preparing a fixed vector is deterministic: a failure (missing native
        // module, decoder error, oversized region) would repeat on every resize.
        // Latch the solid fallback; the Logo Rendering panel shows the reason.
        renderDebug.traceEvent("terminal", "startupLogoRasterFailed", {
          backend,
          geometry,
          message: error instanceof Error ? error.message : String(error),
        });
        channel.reportRasterFailure();
        setAsset(null);
      });
    return () => {
      cancelled = true;
    };
  }, [channel, graphical, rasterizer, svg, options, backend, geometry, paused]);
  // Warm the remaining animation frames only while the animation is running;
  // afterwards a resize needs just the final frame at its new size.
  const animating = frame !== FINAL_STARTUP_LOGO_FRAME;
  useEffect(() => {
    if (!graphical || !animating || paused || rasterizer !== rasterizeStartupLogo) return;
    let cancelled = false;
    // Prepare sequentially to bound CPU/memory pressure. No rendering or terminal
    // transmissions occur here; the current frame always has priority.
    void (async () => {
      for (const next of STARTUP_LOGO_FRAMES) {
        if (cancelled) break;
        await rasterizer(
          startupLogoSvg(
            next.pose,
            {
              primary: theme.logoPrimary,
              secondary: theme.logoSecondary,
              highlight: theme.text,
            },
            next.impact,
          ),
          options,
        );
      }
    })().catch((error: unknown) => {
      if (cancelled) return;
      // Warming is optional; only a failed current frame selects the fallback.
      renderDebug.traceEvent("terminal", "startupLogoWarmFailed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    graphical,
    paused,
    animating,
    rasterizer,
    options,
    theme.logoPrimary,
    theme.logoSecondary,
    theme.text,
  ]);
  // Keep the previous graphical frame during asynchronous rasterization. Falling
  // back to blocks between every SVG frame made animation/theme changes flicker.
  return graphical && asset?.backend === backend && asset.geometry === geometry ? asset.id : null;
}
