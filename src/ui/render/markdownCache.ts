/**
 * Small, character-budgeted presentation caches. No conversation state lives here.
 *
 * Used by `markdownParser.ts` (inline parts, streaming parse prefixes) and
 * `timeline/measure/markdownRows.ts` (widths, wrapped cells, code/block rows).
 * Every instance self-registers in a module-level reset set so
 * `resetMarkdownCaches()` — invoked from `resetTimelineMeasureCaches()` at
 * `/clear` and conversation resume — empties all of them at once.
 */
// Module-level registry of every MarkdownCache's clear(); instances are never
// unregistered, which is fine because they are all module-level singletons.
const resets = new Set<() => void>();

/**
 * Substrings can retain a whole response buffer; cache only detached strings.
 * The JSON round-trip forces a fresh, flat string copy so a cached key/value
 * never pins the (potentially huge) parent string it was sliced from.
 */
export function detachMarkdownText(text: string): string {
  return JSON.parse(JSON.stringify(text)) as string;
}

/**
 * Cache bounded both by entry count and by a total "character" cost, with
 * second-chance (CLOCK) eviction approximating LRU.
 *
 * Map insertion order is the eviction order. A hit only marks its entry as
 * referenced: re-inserting on every hit (exact LRU) made Map delete/insert churn
 * the dominant cost of streaming table layout, where a frame performs thousands
 * of width lookups. Eviction gives referenced entries one more pass (moving them
 * to the back) and drops the oldest unreferenced keys until both budgets hold. A
 * single value whose cost exceeds `maxCharacters` is returned but not stored.
 */
export class MarkdownCache<T> {
  private entries = new Map<string, { key: string; value: T; cost: number; referenced: boolean }>();
  private cost = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxCharacters: number,
  ) {
    resets.add(() => this.clear());
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.referenced = true;
    return entry.value;
  }

  /**
   * Store `value` under a detached copy of `key` and return `value` (so callers
   * can write `cache.get(k) ?? cache.set(k, compute())`). `characters` is the
   * entry's budget cost; it defaults to the key length.
   */
  set(key: string, value: T, characters = key.length): T {
    const previous = this.entries.get(key);
    if (previous) this.cost -= previous.cost;
    this.entries.delete(key);
    if (characters > this.maxCharacters) return value;
    const ownedKey = detachMarkdownText(key);
    this.entries.set(ownedKey, { key: ownedKey, value, cost: characters, referenced: false });
    this.cost += characters;
    // Terminates: each pass either evicts or clears a reference bit, and the new
    // entry is unreferenced.
    while (this.entries.size > this.maxEntries || this.cost > this.maxCharacters) {
      const oldest = this.entries.values().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest.key);
      if (oldest.referenced) {
        oldest.referenced = false;
        this.entries.set(oldest.key, oldest);
        continue;
      }
      this.cost -= oldest.cost;
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
    this.cost = 0;
  }
}

/** Clear every `MarkdownCache` instance created in this process. */
export function resetMarkdownCaches(): void {
  for (const reset of resets) reset();
}
