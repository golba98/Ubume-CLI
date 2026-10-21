/** Bounded asynchronous image preparation; encoders return bytes, never write stdout. */
import { randomInt } from "node:crypto";
import {
  type LogoCellSize,
  STARTUP_LOGO_BASE_SIZE,
} from "../../core/shared/startupLogoDimensions.js";
import type { LogoBackend } from "../../core/terminal/logoRenderer.js";
export interface LogoRasterOptions {
  backend: Exclude<LogoBackend, "solid">;
  cellWidth: number;
  cellHeight: number;
  background: string;
  /** Cell region to fill; defaults to the base 12×3 size. */
  size?: LogoCellSize;
}
/** Rejects implausible regions (bad cell metrics) before allocating pixel buffers. */
const MAX_RASTER_PIXELS = 4096 * 2048;
export interface LogoRaster {
  id: number;
  png: Uint8Array;
  tiles?: readonly string[];
}
const cache = new Map<string, Promise<LogoRaster>>();
export const MAX_LOGO_CACHE_BYTES = 16 * 1024 * 1024;
const cacheBytes = new Map<string, number>();
function evict(key: string) {
  cache.delete(key);
  cacheBytes.delete(key);
}
let nextId = randomInt(1, 0xffff00);
export function rasterizeStartupLogo(svg: string, options: LogoRasterOptions): Promise<LogoRaster> {
  const key = JSON.stringify([svg, options]);
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = prepare(svg, options);
  cache.set(key, pending);
  if (cache.size > 48) evict(cache.keys().next().value!);
  void pending.then(
    (asset) => {
      if (cache.get(key) !== pending) return;
      cacheBytes.set(
        key,
        asset.png.byteLength +
          (asset.tiles ?? []).reduce((sum, tile) => sum + Buffer.byteLength(tile), 0),
      );
      while ([...cacheBytes.values()].reduce((sum, bytes) => sum + bytes, 0) > MAX_LOGO_CACHE_BYTES)
        evict(cache.keys().next().value!);
    },
    () => {
      if (cache.get(key) === pending) evict(key);
    },
  );
  return pending;
}
async function prepare(svg: string, options: LogoRasterOptions): Promise<LogoRaster> {
  const size = options.size ?? STARTUP_LOGO_BASE_SIZE;
  const width = options.cellWidth * size.columns;
  const height = options.cellHeight * size.rows;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_RASTER_PIXELS
  )
    throw new RangeError(`Invalid startup logo raster region ${width}x${height}`);
  const { default: sharp } = await import("sharp");
  // Contain, never stretch: font/cell aspect ratios differ between emulators.
  const png = await sharp(Buffer.from(svg), { density: 288 })
    .resize(width, height, { fit: "contain", background: "#00000000" })
    .png()
    .toBuffer();
  const id = (nextId = (nextId % 0xffffff) + 1);
  if (options.backend === "kitty") return { id, png };
  const tiles: string[] = [];
  for (let row = 0; row < size.rows; row++) {
    const tile = sharp(png).extract({
      left: 0,
      top: row * options.cellHeight,
      width,
      height: options.cellHeight,
    });
    if (options.backend === "iterm2") {
      const bytes = await tile.png().toBuffer();
      tiles.push(
        `\x1b]1337;File=inline=1;width=${size.columns};height=1;preserveAspectRatio=0;doNotMoveCursor=1:${bytes.toString("base64")}\x07`,
      );
    } else {
      const { image2sixel } = await import("sixel");
      const rgba = await tile
        .flatten({ background: options.background })
        .ensureAlpha()
        .raw()
        .toBuffer();
      // sixel reads data.buffer directly, ignoring Buffer.byteOffset. Own the
      // exact pixel allocation so pooled Sharp buffers cannot corrupt the image.
      tiles.push(image2sixel(Uint8Array.from(rgba), width, options.cellHeight, 32, 1));
    }
  }
  return { id, png, tiles };
}
