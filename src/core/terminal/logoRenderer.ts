/** Protocol policy. A choice never authorizes an unconfirmed terminal capability. */
import type { StartupLogoRendering } from "../../config/settings.js";
export type LogoBackend = "kitty" | "iterm2" | "sixel" | "solid";
export interface GraphicsCapabilities {
  kitty: boolean;
  unicodePlacement: boolean;
  iterm2: boolean;
  sixel: boolean;
  cellWidth?: number;
  cellHeight?: number;
  background?: string;
  identity?: string;
  multiplexed?: boolean;
  /** Set after an image could not be prepared; images stay off for the session. */
  rasterFailed?: boolean;
}
export const NO_GRAPHICS: GraphicsCapabilities = Object.freeze({
  kitty: false,
  unicodePlacement: false,
  iterm2: false,
  sixel: false,
});
export function effectiveLogoRenderer(
  requested: StartupLogoRendering,
  caps: GraphicsCapabilities,
): LogoBackend {
  if (requested === "solid" || caps.rasterFailed) return "solid";
  const sized = Boolean(caps.cellWidth && caps.cellHeight);
  // Protocol support alone does not establish that text erasure removes images.
  // WezTerm was exercised end-to-end; iTerm2 uses its native inline-cell contract
  // (native macOS verification is tracked separately). Unknown hosts stay safe.
  const rowPlacement = /^(?:WezTerm|iTerm2)(?:[ (]|$)/i.test(caps.identity ?? "");
  const available = {
    kitty: caps.kitty && caps.unicodePlacement,
    iterm2: caps.iterm2 && rowPlacement && sized && !caps.multiplexed,
    sixel: caps.sixel && rowPlacement && sized && Boolean(caps.background) && !caps.multiplexed,
  };
  if (requested !== "auto" && available[requested]) return requested;
  return (["kitty", "iterm2", "sixel"] as const).find((backend) => available[backend]) ?? "solid";
}
export function resolveLogoRenderer(
  requested: StartupLogoRendering,
  caps: GraphicsCapabilities,
  trueColor: boolean,
) {
  // Ink's RGB marker identifies the asset; color quantization changes its identity.
  const backend = trueColor ? effectiveLogoRenderer(requested, caps) : "solid";
  const fallback = requested !== "auto" && requested !== backend;
  return {
    requested,
    backend,
    motion: backend === "solid" ? "stepped" : "eased",
    reason:
      !trueColor && requested !== "solid"
        ? "Reduced colors"
        : caps.rasterFailed && requested !== "solid"
          ? "Image rendering failed"
          : fallback
            ? "Selected protocol unavailable"
            : backend === "solid" && requested !== "solid"
              ? "Graphics unconfirmed"
              : null,
  } as const;
}
export function logoRendererStatus(
  requested: StartupLogoRendering,
  caps: GraphicsCapabilities,
  trueColor: boolean,
): string {
  const result = resolveLogoRenderer(requested, caps, trueColor);
  const labels = {
    kitty: "Kitty Graphics",
    iterm2: "iTerm2 Images",
    sixel: "Sixel",
    solid: "Solid Text",
  };
  return labels[result.backend] + (result.reason ? ` — ${result.reason}` : "");
}
