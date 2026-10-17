/**
 * Pure row builders and formatters for `UsagePanel`: turns a `UsageViewState`
 * (from `core/usage/usageService.ts`) into width-bounded text rows with a
 * semantic tone, plus the pinned footer.
 *
 * Every row is clamped to the given width in terminal cells, so the panel can
 * render each as a single truncated `<Text>` line and scroll by row index.
 * Time-dependent output takes `now` (and an optional IANA `timeZone`) as
 * inputs, keeping the module deterministic for tests. No state, no side
 * effects.
 */
import { clampVisualText, getTextWidth, wrapPlainText } from "../../core/shared/text.js";
import type {
  ProviderUsageSnapshot,
  UsageBillingMode,
  UsageFact,
  UsageLimit,
} from "../../core/usage/types.js";
import type { UsageViewState } from "../../core/usage/usageService.js";

/** Semantic color for a row; mapped to theme colors by the panel. */
export type UsageRowTone = "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error";

/** One rendered line. `key` is stable within a single build (sequence-based). */
export interface UsageRow {
  key: string;
  text: string;
  tone: UsageRowTone;
  bold?: boolean;
}

export interface UsageRowOptions {
  width: number;
  now: number;
  compact?: boolean;
  /** IANA zone for absolute times; defaults to the user's local zone. */
  timeZone?: string;
}

const BAR_FILLED = "█";
const BAR_EMPTY = "░";

/** Rounds for display without inventing precision at the extremes. */
export function formatPercent(value: number | undefined): string {
  if (value === undefined) return "Unavailable";
  if (value <= 0) return "0%";
  if (value >= 100) return "100%";
  if (value < 1) return "<1%";
  if (value > 99) return ">99%";
  return `${Math.round(value)}%`;
}

/** Fixed-width bar of filled/empty block cells for a 0–100 percentage (at least 1 cell). */
export function renderUsageBar(usedPercent: number, width: number): string {
  const cells = Math.max(1, width);
  const filled = Math.min(cells, Math.max(0, Math.round((usedPercent / 100) * cells)));
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(cells - filled);
}

/** Compact duration rounded to minutes: `<1m`, `42m`, `3h 5m`, `2d 4h`. Negative input counts as 0. */
export function formatDurationShort(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Absolute time label: `HH:MM` for the same calendar day, `Wed HH:MM` within
 * six days, otherwise `Mar 4 HH:MM`. Same-day is compared in `timeZone`.
 */
function formatClock(ms: number, now: number, timeZone?: string): string {
  const date = new Date(ms);
  const sameDay =
    new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(date) ===
    new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(new Date(now));
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  if (sameDay) return time;
  const withinWeek = Math.abs(ms - now) < 6 * 24 * 60 * 60 * 1000;
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    ...(withinWeek ? { weekday: "short" } : { month: "short", day: "numeric" }),
  }).format(date);
  return `${day} ${time}`;
}

/** "Resets in 3h 5m (14:15)", "Reset due now" once past, or undefined when unknown. */
export function formatResetTime(
  resetsAt: number | undefined,
  now: number,
  timeZone?: string,
): string | undefined {
  if (resetsAt === undefined) return undefined;
  if (resetsAt <= now) return "Reset due now";
  return `Resets in ${formatDurationShort(resetsAt - now)} (${formatClock(resetsAt, now, timeZone)})`;
}

/** Relative freshness: "just now" (< 5 s), "Ns ago", then `formatDurationShort` + " ago". */
export function formatCheckedAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${formatDurationShort(now - at)} ago`;
}

const BILLING_LABELS: Record<UsageBillingMode, string> = {
  subscription: "Subscription",
  api: "API billing",
  local: "Local inference",
  unknown: "Billing unknown",
};

const STATUS_LINES: Partial<
  Record<ProviderUsageSnapshot["status"], { text: string; tone: UsageRowTone }>
> = {
  partial: { text: "Some usage metrics are unavailable.", tone: "warning" },
  unsupported: { text: "Usage reporting is not supported for this provider.", tone: "warning" },
  authentication_required: { text: "Sign-in required.", tone: "error" },
  temporarily_unavailable: { text: "Usage could not be retrieved.", tone: "error" },
};

// Below this width a limit takes two rows (label + numbers, then bar + reset).
const SINGLE_ROW_MIN_WIDTH = 60;
const MAX_LABEL_WIDTH = 28;

/** Facts may carry their own tone; default to plain text. */
function factTone(fact: UsageFact): UsageRowTone {
  return fact.tone === "muted" ? "muted" : (fact.tone ?? "text");
}

/** Exhausted -> error, at least 90% used -> warning, otherwise accent. */
function limitTone(limit: UsageLimit): UsageRowTone {
  if (limit.state === "exhausted") return "error";
  if (limit.usedPercent !== undefined && limit.usedPercent >= 90) return "warning";
  return "accent";
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** The numbers for one limit, without the bar or reset time. */
function limitSummary(limit: UsageLimit): string {
  if (limit.unit !== "percent" && limit.total !== undefined) {
    const used =
      limit.used ?? (limit.remaining !== undefined ? limit.total - limit.remaining : undefined);
    const unit = limit.unit === "tokens" ? "tokens" : "requests";
    return used !== undefined
      ? `${formatCount(used)} / ${formatCount(limit.total)} ${unit}`
      : `${formatCount(limit.total)} ${unit} limit`;
  }
  if (limit.unit !== "percent" && limit.used !== undefined) {
    return `${formatCount(limit.used)} ${limit.unit}`;
  }
  if (limit.usedPercent === undefined) return "Unavailable";
  return `${formatPercent(limit.usedPercent)} used`;
}

/** Clamp then right-pad with spaces to exactly `width` cells (for aligned label columns). */
function padToWidth(text: string, width: number): string {
  const clamped = clampVisualText(text, width);
  return clamped + " ".repeat(Math.max(0, width - getTextWidth(clamped)));
}

/**
 * Turns a usage view into width-bounded body rows, data first: status, limits,
 * facts, account, then background text. The panel pins its own footer.
 */
export function buildUsagePanelRows(view: UsageViewState, options: UsageRowOptions): UsageRow[] {
  const width = Math.max(12, options.width);
  const rows: UsageRow[] = [];
  let seq = 0;
  const push = (text: string, tone: UsageRowTone, bold?: boolean) => {
    rows.push({ key: `r${seq++}`, text: clampVisualText(text, width), tone, bold });
  };
  const pushWrapped = (text: string, tone: UsageRowTone, indent = "", maxLines = Infinity) => {
    const lines = wrapPlainText(text, Math.max(4, width - indent.length));
    lines.slice(0, maxLines).forEach((line, index) => {
      const truncated = index === maxLines - 1 && lines.length > maxLines;
      push(
        `${indent}${truncated ? `${line.slice(0, Math.max(0, line.length - 1))}…` : line}`,
        tone,
      );
    });
  };
  const blank = () => {
    if (rows.length > 0 && rows[rows.length - 1]!.text !== "") push("", "text");
  };

  const snapshot = view.snapshot;
  if (!snapshot) {
    push(view.inFlight ? "Checking usage…" : "No usage data yet.", "muted");
    return rows;
  }

  const statusLine = STATUS_LINES[snapshot.status];
  if (statusLine && !(snapshot.status === "partial" && snapshot.message)) {
    push(statusLine.text, statusLine.tone, true);
  }
  if (snapshot.message) {
    pushWrapped(
      snapshot.message,
      statusLine?.tone === "error" ? "error" : statusLine ? "muted" : "warning",
      "",
      options.compact ? 2 : 4,
    );
  }

  const singleRow = width >= SINGLE_ROW_MIN_WIDTH;
  // Labels get at most about a third of the row so the numbers always fit.
  const labelWidth = Math.min(
    MAX_LABEL_WIDTH,
    Math.floor(width * 0.35),
    Math.max(0, ...snapshot.limits.map((limit) => getTextWidth(limit.label))),
  );
  const specs = snapshot.limits.map((limit) => {
    const indent = limit.group ? "  " : "";
    const summary =
      limit.state === "exhausted" ? `${limitSummary(limit)} · limit reached` : limitSummary(limit);
    const reset = formatResetTime(limit.resetsAt, options.now, options.timeZone);
    const resetFull = reset ? reset[0]!.toLowerCase() + reset.slice(1) : undefined;
    // Without the "(14:15)" clock, for rows that would not otherwise fit.
    const resetShort = resetFull?.replace(/ \([^)]*\)$/, "");
    const withReset = (resetText: string | undefined) =>
      resetText ? `${summary} · ${resetText}` : summary;
    return {
      limit,
      indent,
      summary,
      resetFull,
      resetShort,
      full: withReset(resetFull),
      short: withReset(resetShort),
      hasBar: limit.usedPercent !== undefined,
      fixed: getTextWidth(indent) + labelWidth + 2,
    };
  });
  // One bar width for the whole panel keeps the columns aligned; rows whose
  // full text would not fit next to it drop the reset clock instead.
  const barRows = specs.filter((spec) => spec.hasBar);
  const barWidth = Math.max(
    8,
    Math.min(20, ...barRows.map((spec) => width - spec.fixed - 1 - getTextWidth(spec.full))),
  );

  let group: string | undefined;
  specs.forEach((spec, index) => {
    const { limit, indent, summary, hasBar } = spec;
    if (index === 0 || limit.group !== group) {
      group = limit.group;
      if (index > 0 || rows.length > 0) blank();
      if (group) push(group, "accent", true);
    }
    const tone = hasBar ? limitTone(limit) : summary === "Unavailable" ? "muted" : "text";

    if (singleRow) {
      const label = padToWidth(limit.label, labelWidth);
      const barCells = hasBar ? barWidth + 1 : 0;
      const numbers =
        spec.fixed + barCells + getTextWidth(spec.full) <= width ? spec.full : spec.short;
      const bar = hasBar ? `${renderUsageBar(limit.usedPercent!, barWidth)} ` : "";
      push(`${indent}${label}  ${bar}${numbers}`, tone);
    } else {
      push(`${indent}${limit.label}  ${summary}`, tone, true);
      const lead = `${indent}  `;
      const narrowBar = Math.max(6, Math.min(12, width - getTextWidth(lead)));
      const bar = hasBar ? renderUsageBar(limit.usedPercent!, narrowBar) : undefined;
      const lineFor = (resetText: string | undefined) =>
        `${lead}${[bar, resetText].filter(Boolean).join(" ")}`;
      const line =
        getTextWidth(lineFor(spec.resetFull)) <= width
          ? lineFor(spec.resetFull)
          : lineFor(spec.resetShort);
      if (bar || spec.resetFull) push(line, tone === "error" ? "error" : "muted");
    }
    if (limit.note) pushWrapped(limit.note, "dim", `${indent}  `, 1);
  });

  if (snapshot.facts.length > 0) {
    blank();
    for (const fact of snapshot.facts) pushWrapped(`${fact.label}: ${fact.value}`, factTone(fact));
  }

  const account = [
    snapshot.account?.label,
    snapshot.account?.plan,
    snapshot.account?.authMethod,
    BILLING_LABELS[snapshot.billingMode],
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  if (snapshot.facts.length === 0) blank();
  pushWrapped(`Account: ${snapshot.account ? account : `Unavailable · ${account}`}`, "muted");

  if (!options.compact) {
    if (snapshot.description) {
      blank();
      pushWrapped(snapshot.description, "dim", "", 3);
    }
    if (snapshot.links?.length) {
      blank();
      for (const link of snapshot.links) push(`${link.label}: ${link.url}`, "dim");
    }
    blank();
    push(`Source: ${snapshot.source}`, "dim");
  }
  return rows;
}

/** Inputs for `buildUsageFooterRows`. */
export interface UsageFooterOptions {
  width: number;
  now: number;
  timeZone?: string;
  /** Epoch ms when R contacts the provider again. */
  refreshAvailableAt: number;
  /** Include the scroll hint; the panel reserves space for the scrollable variant. */
  scrollable: boolean;
}

/**
 * The pinned footer: freshness (live, cached, stale or observed) plus keys,
 * on one line when it fits. Stale failures add a warning line.
 */
export function buildUsageFooterRows(
  view: UsageViewState,
  options: UsageFooterOptions,
): UsageRow[] {
  const width = Math.max(12, options.width);
  const rows: UsageRow[] = [];
  const push = (text: string, tone: UsageRowTone) =>
    rows.push({ key: `f${rows.length}`, text: clampVisualText(text, width), tone });
  const snapshot = view.snapshot;

  let freshness: string | undefined;
  if (snapshot) {
    const verb = snapshot.freshness === "observed" ? "Observed" : "Checked";
    freshness =
      snapshot.retrievedAt === undefined
        ? `${verb} never`
        : `${verb} ${formatCheckedAgo(snapshot.retrievedAt, options.now)} (${formatClock(snapshot.retrievedAt, options.now, options.timeZone)})`;
    if (view.origin === "stale") freshness += " · stale";
    else if (view.origin === "cached" && snapshot.freshness === "live") freshness += " · cached";
  }
  const cooldownMs = options.refreshAvailableAt - options.now;
  const refresh = view.inFlight
    ? "Checking…"
    : cooldownMs > 0
      ? `R in ${cooldownMs < 60_000 ? `${Math.ceil(cooldownMs / 1000)}s` : formatDurationShort(cooldownMs)}`
      : "R refresh";
  const keys = [refresh, options.scrollable ? "↑/↓ scroll" : undefined, "Esc close"]
    .filter(Boolean)
    .join(" · ");
  const tone: UsageRowTone = view.origin === "stale" ? "warning" : "dim";
  const combined = freshness ? `${freshness} · ${keys}` : keys;
  if (getTextWidth(combined) <= width) {
    push(combined, tone);
  } else {
    if (freshness) push(freshness, tone);
    push(keys, "dim");
  }
  if (view.origin === "stale" && view.lastError) {
    const lines = wrapPlainText(`Latest attempt failed: ${view.lastError}`, width);
    for (const line of lines.slice(0, 2)) push(line, "warning");
  }
  return rows;
}
