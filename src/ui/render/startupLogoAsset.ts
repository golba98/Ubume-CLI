/** Original vector geometry, shared by the SVG and solid half-cell fallback. */
import {
  type LogoCellSize,
  STARTUP_LOGO_BASE_SIZE,
} from "../../core/shared/startupLogoDimensions.js";

export const LOGO_VIEWBOX = { width: 120, height: 72 } as const;
export const LOGO_STROKE = 6;
/** Hinting radius as a share of the column pitch (4 units at the 12-column base). */
const MINIMUM_COVERAGE_PER_PITCH = 0.4;
export const LOGO_PATHS = {
  left: [
    [27, 12],
    [9, 36],
    [27, 60],
  ],
  slash: [
    [72, 9],
    [48, 63],
  ],
  right: [
    [93, 12],
    [111, 36],
    [93, 60],
  ],
} as const;
export type LogoPart = keyof typeof LOGO_PATHS;
export interface LogoPose {
  left: number | null;
  right: number | null;
}
export interface LogoColors {
  primary: string;
  secondary: string;
  highlight: string;
}

/** Accept resolved theme hex colors only: SVG never interpolates arbitrary terminal input. */
export function isSvgLogoColor(color: string): boolean {
  return /^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(color);
}
function svgColor(color: string): string {
  return isSvgLogoColor(color) ? color : "none";
}
export function startupLogoSvg(pose: LogoPose, colors: LogoColors, impact = false): string {
  const paths = (["left", "slash", "right"] as const).flatMap((part) => {
    const offset = part === "slash" ? 0 : pose[part];
    if (offset === null) return [];
    const dx = part === "left" ? -offset : part === "right" ? offset : 0;
    const points = LOGO_PATHS[part].map(([x, y]) => `${x + dx},${y}`).join(" ");
    const color = impact
      ? colors.highlight
      : part === "slash"
        ? colors.highlight
        : part === "left"
          ? colors.primary
          : colors.secondary;
    return [`<polyline id="${part}" points="${points}" stroke="${svgColor(color)}"/>`];
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LOGO_VIEWBOX.width}" height="${LOGO_VIEWBOX.height}" viewBox="0 0 ${LOGO_VIEWBOX.width} ${LOGO_VIEWBOX.height}"><g fill="none" stroke-width="${LOGO_STROKE}" stroke-linecap="square" stroke-linejoin="miter">${paths.join("")}</g></svg>`;
}

function distanceToSegment(
  x: number,
  y: number,
  a: readonly number[],
  b: readonly number[],
): number {
  const dx = b[0]! - a[0]!;
  const dy = b[1]! - a[1]!;
  const t = Math.max(0, Math.min(1, ((x - a[0]!) * dx + (y - a[1]!) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - a[0]! - t * dx, y - a[1]! - t * dy);
}
/** Snap a vertex to its cell center, mirrored about the vertical axis so both
 * brackets hint identically at every grid size. */
function snapX(x: number, pitch: number): number {
  const fromEdge = (edgeDistance: number) => Math.floor(edgeDistance / pitch) * pitch + pitch / 2;
  return x <= LOGO_VIEWBOX.width / 2
    ? fromEdge(x)
    : LOGO_VIEWBOX.width - fromEdge(LOGO_VIEWBOX.width - x);
}
/** Sample half-cell centers with a small minimum coverage radius (pixel hinting).
 * Four-corner sampling inflated diagonal strokes into adjacent cells. Center
 * sampling keeps them one cell thick at the base size; the radius preserves
 * connected corners. Pitches and radius scale with the grid, so larger marks
 * keep the vector's proportions instead of stretching the base bitmap.
 */
export function logoHalfCell(
  part: LogoPart,
  column: number,
  halfRow: number,
  offset: number,
  size: LogoCellSize = STARTUP_LOGO_BASE_SIZE,
): boolean {
  const pitchX = LOGO_VIEWBOX.width / size.columns;
  const pitchY = LOGO_VIEWBOX.height / (size.rows * 2);
  const middle = LOGO_VIEWBOX.height / 2;
  const points = LOGO_PATHS[part].map(([x, y]) => [
    snapX(x, pitchX),
    y < middle ? pitchY / 2 : y > middle ? LOGO_VIEWBOX.height - pitchY / 2 : middle,
  ]);
  const dx = part === "left" ? -offset : part === "right" ? offset : 0;
  const minimumCoverageRadius = MINIMUM_COVERAGE_PER_PITCH * pitchX;
  for (let i = 1; i < points.length; i++) {
    if (
      distanceToSegment(
        column * pitchX + pitchX / 2 - dx,
        halfRow * pitchY + pitchY / 2,
        points[i - 1]!,
        points[i]!,
      ) <= Math.max(LOGO_STROKE / 2, minimumCoverageRadius)
    )
      return true;
  }
  return false;
}
