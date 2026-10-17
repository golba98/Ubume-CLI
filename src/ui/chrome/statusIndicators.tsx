/**
 * Small animated status primitives used by the composer status line:
 * `Spinner`, `AnimatedStatusText`, and the busy-frame helpers.
 *
 * Consumers: `chrome/BottomComposer.tsx` and `chrome/composer/composerModel.ts`.
 * Each animated component owns a local `setInterval` that is cleared on
 * unmount (and, for the status text, whenever it goes inactive), so animation
 * re-renders stay inside this leaf instead of re-rendering the composer or
 * shell. No stdin or focus handling.
 *
 * Environment: `UBUME_DEBUG_STATIC_STATUS=1` freezes the dots on their last
 * frame (deterministic output for debugging); `NO_COLOR` disables the `flow`
 * highlight animation.
 */
import { Text } from "ink";
import { startTransition, useEffect, useState } from "react";
import * as renderDebug from "../../core/perf/renderDebug.js";
import { sanitizeTerminalOutput } from "../../core/terminal/terminalSanitize.js";
import { useTheme } from "../theme.js";

/** Braille spinner frames, advanced every 80 ms. */
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Braille spinner with its own 80 ms timer; defaults to `theme.textDim`. */
export function Spinner({ color }: { color?: string }) {
  const theme = useTheme();
  const [frame, setFrame] = useState(0);
  const activeColor = color ?? theme.textDim;

  useEffect(() => {
    const timer = setInterval(() => {
      // startTransition marks this as low-priority so React can coalesce or
      // defer it when a higher-priority streaming render is already pending.
      startTransition(() => {
        setFrame((f) => (f + 1) % frames.length);
      });
    }, 80);

    return () => clearInterval(timer);
  }, []);

  return <Text color={activeColor}>{frames[frame]}</Text>;
}

/** Interval for the trailing-dots animation (the `flow` style ticks every 120 ms instead). */
export const BUSY_STATUS_FRAME_MS = 900;
export const BUSY_STATUS_FRAMES = [" .  ", " .. ", " ..."] as const;

/** Dots frame for a tick count; negative/fractional indices are clamped and floored. */
export function getBusyStatusFrame(frameIndex: number): string {
  const safeIndex = Math.max(0, Math.floor(frameIndex));
  return BUSY_STATUS_FRAMES[safeIndex % BUSY_STATUS_FRAMES.length]!;
}

/** True for `UIState` kinds that should show an animated status. */
export function isAnimatedBusyState(kind: string): boolean {
  return kind === "THINKING" || kind === "RESPONDING" || kind === "SHELL_RUNNING";
}

interface AnimatedStatusTextProps {
  /** Label text; sanitized before rendering. */
  baseText: string;
  /** Whether to animate at all. */
  isActive: boolean;
  /** Render in the error color instead of `info`. */
  isError?: boolean;
  /**
   * Externally driven dots frame. When provided, the local timer is not started
   * and this string is used as the suffix.
   */
  animationFrame?: string;
  /** `dots`: trailing dots suffix. `flow`: a 3-character highlight sweeping across the label. */
  animationStyle?: "dots" | "flow";
}

/**
 * Local tick counter for `AnimatedStatusText`. Restarts from 0 when the label,
 * style or active flag changes. The interval is `unref`'d so it never keeps the
 * process alive on its own.
 */
function useLocalBusyStatusFrame(isActive: boolean, label: string, flow: boolean): number {
  const [frameIndex, setFrameIndex] = useState(0);
  const staticStatus = process.env.UBUME_DEBUG_STATIC_STATUS === "1";

  useEffect(() => {
    if (!isActive || staticStatus) {
      setFrameIndex(0);
      return;
    }

    setFrameIndex(0);
    const timer = setInterval(
      () => {
        setFrameIndex((current) => {
          const next = current + 1;
          renderDebug.traceStatusTick({ owner: "Status", label, frameIndex: next });
          return next;
        });
      },
      flow ? 120 : BUSY_STATUS_FRAME_MS,
    );
    timer.unref?.();

    return () => {
      clearInterval(timer);
    };
  }, [isActive, label, staticStatus, flow]);

  if (isActive && staticStatus) {
    return BUSY_STATUS_FRAMES.length - 1;
  }
  return frameIndex;
}

/** Status label with a dots suffix or a sweeping highlight, animated by a local timer. */
export function AnimatedStatusText({
  baseText,
  isActive,
  isError = false,
  animationFrame,
  animationStyle = "dots",
}: AnimatedStatusTextProps) {
  const flow = animationStyle === "flow";
  const animate = isActive && (!flow || !process.env.NO_COLOR);
  const frameIndex = useLocalBusyStatusFrame(
    animate && animationFrame === undefined,
    baseText,
    flow,
  );
  const localFrame = getBusyStatusFrame(frameIndex);
  renderDebug.useRenderDebug("Status", {
    baseText,
    isActive,
    isError,
    animationFrame: animationFrame ?? localFrame,
  });
  renderDebug.useLifecycleDebug("Status", {
    baseText,
    isActive,
    isError,
  });

  const theme = useTheme();
  const renderedText = sanitizeTerminalOutput(baseText);
  const suffix = animate && !flow ? (animationFrame ?? localFrame) : "";
  const characters = Array.from(renderedText);
  const highlight = frameIndex % (characters.length + 3);

  return (
    <Text color={isError ? theme.error : theme.info} wrap="truncate">
      {flow && animate
        ? characters.map((character, index) => (
            <Text
              key={index}
              color={index >= highlight - 2 && index <= highlight ? theme.accent : theme.info}
              bold={index >= highlight - 2 && index <= highlight}
            >
              {character}
            </Text>
          ))
        : renderedText}
      {suffix}
    </Text>
  );
}
