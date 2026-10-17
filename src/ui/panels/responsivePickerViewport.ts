/**
 * Pure scroll-window math shared by the list pickers (SelectionPanel,
 * ResumePicker, ProviderPicker, ModelPickerScreen).
 *
 * Callers keep the returned `start` as their scroll offset and pass it back on
 * the next render. All inputs are sanitized (non-finite values become 0,
 * fractions are floored), so a transient bad layout measurement cannot produce
 * a negative or NaN window. No state, no side effects.
 */
interface ResponsivePickerViewportOptions {
  itemCount: number;
  /** Desired selection; clamped into range and echoed back as `selectedIndex`. */
  selectedIndex: number;
  /** Rows the picker may use in total, including its chrome. */
  availableRows: number;
  /** Rows taken by title/footer/etc.; the list gets the rest (at least 1 row when non-empty). */
  chromeRows: number;
  /** Previous `start`, so the window only moves when the selection leaves it. */
  scrollOffset?: number;
}

/** Visible window `[start, end)` plus overflow counts for "N more" indicators. */
interface ResponsivePickerViewport {
  start: number;
  end: number;
  capacity: number;
  selectedIndex: number;
  hasOverflow: boolean;
  hiddenAbove: number;
  hiddenBelow: number;
}

function safeInteger(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

/**
 * Builds a continuous list viewport from the rows left to the picker body.
 * The previous offset is retained when possible, then moved only far enough to
 * keep the selection visible. This makes keyboard navigation and resizes feel
 * like scrolling one list instead of jumping between pages.
 */
export function calculateResponsivePickerViewport({
  itemCount,
  selectedIndex,
  availableRows,
  chromeRows,
  scrollOffset = 0,
}: ResponsivePickerViewportOptions): ResponsivePickerViewport {
  const count = Math.max(0, safeInteger(itemCount));
  const rows = Math.max(0, safeInteger(availableRows));
  const chrome = Math.max(0, safeInteger(chromeRows));
  const capacity = count === 0 ? 0 : Math.max(1, rows - chrome);
  const clampedSelection =
    count === 0 ? 0 : Math.max(0, Math.min(count - 1, safeInteger(selectedIndex)));
  const maxStart = Math.max(0, count - capacity);
  let start = Math.max(0, Math.min(maxStart, safeInteger(scrollOffset)));

  if (clampedSelection < start) {
    start = clampedSelection;
  } else if (clampedSelection >= start + capacity) {
    start = clampedSelection - capacity + 1;
  }

  start = Math.max(0, Math.min(maxStart, start));
  const end = Math.min(count, start + capacity);

  return {
    start,
    end,
    capacity,
    selectedIndex: clampedSelection,
    hasOverflow: count > capacity,
    hiddenAbove: start,
    hiddenBelow: count - end,
  };
}
