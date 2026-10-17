/**
 * Atomic "chip" tokens for large pastes and attachments in the composer.
 *
 * Large pastes, images and files are not inserted into the composer text
 * verbatim. Instead a readable label (`[Pasted Content 1,234 chars]`,
 * `[Image: name]`, `[File: name]`) is inserted, followed by an invisible id
 * wrapped in U+2063 (INVISIBLE SEPARATOR) and encoded as variation selectors
 * U+FE00..U+FE09 (one per decimal digit). The id makes two identical labels
 * distinct registry keys while rendering as just the label.
 *
 * The real content lives in caller-owned registries (`PastedContentRegistry`,
 * `ImageAttachmentRegistry`, a file map) held by `src/app`; this module only
 * creates, locates, deletes and expands tokens. Cursor movement and deletion
 * treat a whole token as one unit (`moveAcrossPastedContent`,
 * `deleteAdjacentPastedContent`), used by `inputBuffer.ts` and the composer.
 *
 * Module state: `nextPasteId`, a process-wide counter seeded from
 * `Date.now() * 1000`. Otherwise pure.
 *
 * Constraint: the global regexes are shared; functions that iterate them with
 * `matchAll` reset `lastIndex` first (or build a fresh RegExp).
 */
import type { ProviderImageAttachment } from "../../core/providerRuntime/types.js";

/** Pastes at or above this many code points become a chip instead of inline text. */
const LARGE_PASTE_THRESHOLD = 1_000;

const PASTED_CONTENT_PATTERN =
  /\[Pasted Content ([\d,]+) chars\](?:\u2063[\uFE00-\uFE09]+\u2063)?/g;
/** Matches an image chip; the full match (label + optional invisible id) is the registry key. */
export const IMAGE_ATTACHMENT_PATTERN = /\[Image: ([^\]\n]+)\](?:\u2063[\uFE00-\uFE09]+\u2063)?/g;
/** Any chip kind (paste, image, file) — used for cursor/deletion atomicity and validation. */
const ATOMIC_CONTENT_PATTERN =
  /(?:\[Pasted Content [\d,]+ chars\]|\[(?:Image|File): [^\]\n]+\])(?:\u2063[\uFE00-\uFE09]+\u2063)?/g;

let nextPasteId = Date.now() * 1000;

// Counts code points rather than UTF-16 units, so emoji/astral text is not over-counted.
function countCharacters(value: string): number {
  return Array.from(value).length;
}

/** Visible label for a pasted value, e.g. `[Pasted Content 1,234 chars]` (en-US grouping). */
export function createPastedContentLabel(value: string): string {
  return `[Pasted Content ${countCharacters(value).toLocaleString("en-US")} chars]`;
}

/** Encode each decimal digit of `value` as variation selector U+FE00 + digit. */
function encodeInvisibleId(value: number): string {
  return String(value)
    .split("")
    .map((digit) => String.fromCharCode(0xfe00 + Number(digit)))
    .join("");
}

/**
 * Append a fresh invisible id to `label`, producing a unique chip token.
 * Side effect: advances the module-level id counter.
 */
export function createAtomicContentToken(label: string): string {
  const id = encodeInvisibleId(nextPasteId++);
  return `${label}\u2063${id}\u2063`;
}

/** Create a unique chip token for a pasted value (label + invisible id). */
export function createPastedContentToken(value: string): string {
  return createAtomicContentToken(createPastedContentLabel(value));
}

/** True when a paste should be collapsed into a chip (see `LARGE_PASTE_THRESHOLD`). */
export function isLargePaste(value: string): boolean {
  return countCharacters(value) >= LARGE_PASTE_THRESHOLD;
}

/**
 * Chip token -> pasted values. A list rather than a single value because the
 * same token can appear more than once (the invisible id is optional in the
 * pattern, so bare labels can repeat); the Nth occurrence expands to the Nth
 * entry.
 */
export type PastedContentRegistry = Map<string, string[]>;

/**
 * Replace every paste chip in `value` with its registered content, by
 * occurrence order per token. Unregistered chips are left as their literal
 * text. Image/file chips are not touched.
 */
export function expandPastedContent(value: string, registry: PastedContentRegistry): string {
  const offsets = new Map<string, number>();
  return value.replace(PASTED_CONTENT_PATTERN, (label) => {
    const values = registry.get(label);
    const offset = offsets.get(label) ?? 0;
    offsets.set(label, offset + 1);
    return values?.[offset] ?? label;
  });
}

/**
 * Return the `[start, end)` span of the chip (any kind) containing `cursor`,
 * with both edges inclusive of the cursor position, or null.
 */
export function findPastedContentSpan(value: string, cursor: number) {
  ATOMIC_CONTENT_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(ATOMIC_CONTENT_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (cursor >= start && cursor <= end) return { start, end };
  }
  return null;
}

/**
 * When the cursor is on or inside a chip, return the chip edge it should jump
 * to for a left/right move; null means "move normally".
 */
export function moveAcrossPastedContent(
  value: string,
  cursor: number,
  direction: "left" | "right",
): number | null {
  const span = findPastedContentSpan(value, cursor);
  if (!span) return null;
  if (direction === "left" && cursor > span.start) return span.start;
  if (direction === "right" && cursor < span.end) return span.end;
  return null;
}

/**
 * Delete a whole chip when Backspace (`backward`, cursor at its end) or Delete
 * (`forward`, cursor at its start) touches it, or when the cursor is strictly
 * inside one. Returns the new value and the cursor position (chip start), or
 * null when no chip is affected.
 */
export function deleteAdjacentPastedContent(
  value: string,
  cursor: number,
  direction: "backward" | "forward",
) {
  ATOMIC_CONTENT_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(ATOMIC_CONTENT_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const adjacent = direction === "backward" ? cursor === end : cursor === start;
    if (adjacent || (cursor > start && cursor < end)) {
      return { value: value.slice(0, start) + value.slice(end), cursorOffset: start };
    }
  }
  return null;
}

/**
 * Validate chips before expansion, so literal chip-like text inside files is safe.
 *
 * Throws a user-facing Error when any image, file or paste chip in `value` has
 * no registered content (e.g. a chip restored from history after its data was
 * lost). Paste chips are checked per occurrence, mirroring `expandPastedContent`.
 */
export function assertAttachedContent(
  value: string,
  pastes: PastedContentRegistry,
  images: ReadonlyMap<string, unknown>,
  files: ReadonlyMap<string, unknown>,
): void {
  const counts = new Map<string, number>();
  for (const match of value.matchAll(new RegExp(ATOMIC_CONTENT_PATTERN.source, "g"))) {
    const token = match[0];
    if (token.startsWith("[Image:")) {
      if (!images.has(token))
        throw new Error("An image attachment is unresolved. Reattach it before sending.");
    } else if (token.startsWith("[File:")) {
      if (!files.has(token))
        throw new Error("A file attachment is unresolved. Reattach it before sending.");
    } else {
      const count = counts.get(token) ?? 0;
      if (pastes.get(token)?.[count] === undefined)
        throw new Error("Pasted content is unresolved. Paste it again before sending.");
      counts.set(token, count + 1);
    }
  }
}

/** Image chip token -> attachment payload sent to the provider. */
export type ImageAttachmentRegistry = Map<string, ProviderImageAttachment>;

/** Create a unique `[Image: name]` chip token for an attachment. */
export function createImageAttachmentToken(attachment: ProviderImageAttachment): string {
  return createAtomicContentToken(`[Image: ${attachment.name}]`);
}

/**
 * Collect the attachments whose image chips still appear in `value`, in text
 * order. Chips removed from the composer are thereby dropped from the request.
 */
export function selectImageAttachments(
  value: string,
  registry: ImageAttachmentRegistry,
): ProviderImageAttachment[] {
  IMAGE_ATTACHMENT_PATTERN.lastIndex = 0;
  const attachments: ProviderImageAttachment[] = [];
  for (const match of value.matchAll(IMAGE_ATTACHMENT_PATTERN)) {
    const attachment = registry.get(match[0]);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}
