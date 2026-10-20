/** Pure graphics transport, attached to the Ink frame writer; never owns stdout. */

import { type LogoCellSize, STARTUP_LOGO_BASE_SIZE } from "../shared/startupLogoDimensions.js";

export const KITTY_PLACEHOLDER = "\u{10eeee}";
// The first 48 entries of Kitty's row/column diacritics (gen/rowcolumn-diacritics.txt).
// A placeholder's row and column are encoded by index into this table.
const DIACRITICS = [
  0x305, 0x30d, 0x30e, 0x310, 0x312, 0x33d, 0x33e, 0x33f, 0x346, 0x34a, 0x34b, 0x34c, 0x350, 0x351,
  0x352, 0x357, 0x35b, 0x363, 0x364, 0x365, 0x366, 0x367, 0x368, 0x369, 0x36a, 0x36b, 0x36c, 0x36d,
  0x36e, 0x36f, 0x483, 0x484, 0x485, 0x486, 0x487, 0x592, 0x593, 0x594, 0x595, 0x597, 0x598, 0x599,
  0x59c, 0x59d, 0x59e, 0x59f, 0x5a0, 0x5a1,
];
/** Largest placeholder row or column index this encoder can address. */
export const KITTY_MAX_PLACEHOLDER_CELLS = DIACRITICS.length;

import { type GraphicsCapabilities, NO_GRAPHICS } from "./logoRenderer.js";

export {
  effectiveLogoRenderer,
  type GraphicsCapabilities,
  logoRendererStatus,
  NO_GRAPHICS,
  resolveLogoRenderer,
} from "./logoRenderer.js";
export function kittyPlaceholderRow(
  _id: number,
  row: number,
  columns = STARTUP_LOGO_BASE_SIZE.columns,
): string {
  // Layout caps logo sizes to the table; exceeding it is a programming error.
  if (row < 0 || row >= DIACRITICS.length || columns < 0 || columns > DIACRITICS.length)
    throw new RangeError(`Kitty placeholder ${columns}x${row} exceeds the diacritic table`);
  return Array.from(
    { length: columns },
    (_, col) => KITTY_PLACEHOLDER + String.fromCodePoint(DIACRITICS[row]!, DIACRITICS[col]!),
  ).join("");
}
export function kittyImageCommands(
  id: number,
  png: Uint8Array,
  size: LogoCellSize = STARTUP_LOGO_BASE_SIZE,
): string {
  const data = Buffer.from(png).toString("base64");
  let result = "";
  for (let offset = 0; offset < data.length; offset += 4096) {
    const more = offset + 4096 < data.length ? 1 : 0;
    const fields = offset === 0 ? `a=t,t=d,f=100,i=${id},q=2,m=${more}` : `m=${more}`;
    result += `\x1b_G${fields};${data.slice(offset, offset + 4096)}\x1b\\`;
  }
  return result + kittyPlacementCommand(id, size);
}
/**
 * A virtual placement for Unicode placeholders. The explicit placement id makes
 * a repeated command replace the placement instead of adding another one.
 */
export function kittyPlacementCommand(
  id: number,
  size: LogoCellSize = STARTUP_LOGO_BASE_SIZE,
): string {
  return `\x1b_Ga=p,U=1,i=${id},p=1,c=${size.columns},r=${size.rows},q=2\x1b\\`;
}
export function graphicsPassthrough(data: string, tmux: boolean): string {
  return tmux && data ? `\x1bPtmux;${data.replaceAll("\x1b", "\x1b\x1b")}\x1b\\` : data;
}

export interface StartupGraphicsChannel {
  capabilities: GraphicsCapabilities;
  probe(refresh?: boolean): void;
  transformFrame(frame: string): string;
  subscribe(listener: () => void): () => void;
  /** Size is per image: one channel serves every responsive logo size. */
  stage(id: number, png: Uint8Array, tiles?: readonly string[], size?: LogoCellSize): void;
  prepareFrame(frame: string): string;
  /**
   * Data-free placement commands for the Kitty images in the latest frame.
   * Kitty can leave an image unpainted when it arrives while an OS-window
   * resize is still settling; re-placing it afterwards forces the repaint.
   */
  refreshPlacements(): string;
  /** Latch the solid fallback after an image could not be prepared. */
  reportRasterFailure(): void;
  dispose(): string;
}
const channels = new WeakMap<object, StartupGraphicsChannel>();
export const getStartupGraphicsChannel = (stdout: object) => channels.get(stdout);
export function registerStartupGraphicsChannel(
  stdout: object,
  channel: StartupGraphicsChannel,
): () => void {
  channels.set(stdout, channel);
  return () => {
    channels.delete(stdout);
  };
}

/** IDs belong to one app channel; only these IDs may be deleted on shutdown. */
export function createStartupGraphicsChannel(options: {
  query: (query: string, onReply: (reply: string) => void) => void;
  tmux?: boolean;
  disabled?: boolean;
}): StartupGraphicsChannel {
  let capabilities: GraphicsCapabilities = { ...NO_GRAPHICS, multiplexed: Boolean(options.tmux) };
  let probed = false;
  let disposed = false;
  let transmitted = new Set<number>();
  const pending = new Map<number, Uint8Array>();
  const retained = new Map<number, Uint8Array>();
  const inline = new Map<number, readonly string[]>();
  const sizes = new Map<number, LogoCellSize>();
  const sizeOf = (id: number) => sizes.get(id) ?? STARTUP_LOGO_BASE_SIZE;
  // Images whose placeholders the latest full logo frame drew.
  let onScreen = new Set<number>();
  const listeners = new Set<() => void>();
  const wrap = (data: string) => graphicsPassthrough(data, Boolean(options.tmux));
  const channel: StartupGraphicsChannel = {
    get capabilities() {
      return capabilities;
    },
    probe(refresh = false) {
      if ((refresh && !probed) || (probed && !refresh) || disposed || options.disabled) return;
      probed = true;
      // Positive replies, not TERM/KITTY_WINDOW_ID, authorize use. XTVERSION
      // confirms placeholder support instead of assuming every KGP terminal has it.
      options.query(
        wrap(
          "\x1b_Ga=q,i=314159,s=1,v=1,f=24,t=d;AAAA\x1b\\\x1b[>q\x1b[c\x1b[16t\x1b]11;?\x07\x1b]1337;ReportCellSize\x07\x1b]1337;Capabilities\x07",
        ),
        (reply) => {
          if (disposed) return;
          if (/\x1b_Gi=314159;OK\x1b\\/.test(reply)) capabilities.kitty = true;
          const version = /kitty\(?([\d.]+)/i.exec(reply)?.[1];
          if (version) {
            const [major = 0, minor = 0] = version.split(".").map(Number);
            capabilities.unicodePlacement = major > 0 || minor >= 28;
          }
          if (/\x1b\[\?[\d;]*;4(?:;|c)/.test(reply)) capabilities.sixel = true;
          const features = /Capabilities=([A-Za-z0-9]+)/
            .exec(reply)?.[1]
            ?.match(/[A-Z][a-z]*[0-9]*/g);
          if (features?.includes("F")) capabilities.iterm2 = true;
          const identity = /\x1bP>\|([^\x1b]+)/.exec(reply)?.[1];
          if (identity) capabilities.identity = identity;
          // Positive identity responses from implementations of the inline protocol.
          if (/iTerm2|WezTerm/i.test(reply)) capabilities.iterm2 = true;
          const cells = /\x1b\[6;(\d+);(\d+)t/.exec(reply);
          const itermCells = /ReportCellSize=([\d.]+);([\d.]+)(?:;([\d.]+))?/.exec(reply);
          const height = cells
            ? Number(cells[1])
            : itermCells
              ? Number(itermCells[1]) * Number(itermCells[3] ?? 1)
              : 0;
          const width = cells
            ? Number(cells[2])
            : itermCells
              ? Number(itermCells[2]) * Number(itermCells[3] ?? 1)
              : 0;
          if (width > 0 && width <= 256 && height > 0 && height <= 512) {
            capabilities.cellWidth = Math.round(width);
            capabilities.cellHeight = Math.round(height);
          }
          const bg = /\x1b\]11;rgb:([a-f\d]{2,4})\/([a-f\d]{2,4})\/([a-f\d]{2,4})/i.exec(reply);
          if (bg)
            capabilities.background =
              "#" +
              bg
                .slice(1)
                .map((v) =>
                  Math.round((Number.parseInt(v, 16) * 255) / (16 ** v.length - 1))
                    .toString(16)
                    .padStart(2, "0"),
                )
                .join("");
          capabilities = { ...capabilities };
          for (const listener of listeners) listener();
        },
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    transformFrame(frame) {
      for (const [id, tiles] of inline) {
        const color = `\x1b[38;2;${id >> 16};${(id >> 8) & 255};${id & 255}m`;
        const { columns } = sizeOf(id);
        for (let row = 0; row < tiles.length; row++) {
          // Ink already placed these measured cells. Replace only this owned run,
          // inside the same write, with a one-row tile and restore its cursor.
          frame = frame.replaceAll(
            color + kittyPlaceholderRow(id, row, columns),
            color + "\x1b7" + tiles[row]! + "\x1b8" + `\x1b[${columns}C`,
          );
        }
      }
      return frame;
    },
    stage(id, png, tiles, size = STARTUP_LOGO_BASE_SIZE) {
      if (!disposed) {
        // Refresh recency: every retained (48) or inline (24) image is among
        // the latest 96 distinct stages, so its size is never evicted first.
        sizes.delete(id);
        sizes.set(id, size);
        if (sizes.size > 96) sizes.delete(sizes.keys().next().value!);
      }
      if (tiles && !disposed) {
        inline.set(id, tiles);
        if (inline.size > 24) inline.delete(inline.keys().next().value!);
        return;
      }
      if (!disposed) {
        retained.delete(id);
        retained.set(id, png);
        if (retained.size > 48) retained.delete(retained.keys().next().value!);
        if (!transmitted.has(id)) pending.set(id, png);
      }
      if (pending.size > 24) pending.delete(pending.keys().next().value!);
    },
    prepareFrame(frame) {
      // Kitty image residency is screen-buffer scoped. Ink overlays and clear
      // frames can discard placements even though React still holds the asset.
      const screenChange = /\x1b\[\?1049[hl]|\x1b\[[23]J/.test(frame);
      if (!disposed && screenChange) {
        for (const [id, png] of retained) pending.set(id, png);
      }
      if (disposed || !frame.includes(KITTY_PLACEHOLDER)) {
        // Ink diffs may omit unchanged logo rows; only a fresh screen hides them.
        if (screenChange) onScreen = new Set();
        return "";
      }
      const colorOf = (id: number) => `\x1b[38;2;${id >> 16};${(id >> 8) & 255};${id & 255}m`;
      onScreen = new Set([...retained.keys()].filter((id) => frame.includes(colorOf(id))));
      let commands = "";
      for (const [id, png] of pending) {
        // An obsolete async raster must not consume terminal storage.
        if (!frame.includes(colorOf(id))) continue;
        commands += kittyImageCommands(id, png, sizeOf(id));
        transmitted.add(id);
        if (transmitted.size > 24) {
          const oldest = transmitted.values().next().value!;
          commands += `\x1b_Ga=d,d=I,i=${oldest},q=2\x1b\\`;
          transmitted.delete(oldest);
        }
        pending.delete(id);
      }
      return wrap(commands);
    },
    refreshPlacements() {
      if (disposed) return "";
      const commands = [...onScreen]
        .filter((id) => transmitted.has(id))
        .map((id) => kittyPlacementCommand(id, sizeOf(id)))
        .join("");
      return wrap(commands);
    },
    reportRasterFailure() {
      if (disposed || capabilities.rasterFailed) return;
      capabilities = { ...capabilities, rasterFailed: true };
      for (const listener of listeners) listener();
    },
    dispose() {
      disposed = true;
      listeners.clear();
      pending.clear();
      inline.clear();
      retained.clear();
      sizes.clear();
      onScreen = new Set();
      const commands = Array.from(transmitted, (id) => `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`).join("");
      transmitted = new Set();
      return wrap(commands);
    },
  };
  return channel;
}
