/** A one-shot Ink animation, owned above transcript clear/resize remounts. */
import { useEffect, useRef, useState } from "react";
import { FINAL_STARTUP_LOGO_FRAME, STARTUP_LOGO_FRAMES } from "./startupAnimation.js";

export interface StartupAnimationClock {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
const SYSTEM_CLOCK: StartupAnimationClock = {
  now: () => performance.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function useStartupLogoAnimation(enabled: boolean, clock = SYSTEM_CLOCK) {
  const [index, setIndex] = useState(() => (enabled ? 0 : STARTUP_LOGO_FRAMES.length - 1));
  const position = useRef(index);
  useEffect(() => {
    if (!enabled) {
      position.current = STARTUP_LOGO_FRAMES.length - 1;
      setIndex(position.current);
      return;
    }
    const startedAt = clock.now() - STARTUP_LOGO_FRAMES[position.current]!.atMs;
    let timer: unknown;
    let cancelled = false;
    function scheduleNext() {
      const next = STARTUP_LOGO_FRAMES[position.current + 1];
      if (!next) return;
      const delay = Math.max(0, next.atMs - (clock.now() - startedAt));
      timer = clock.setTimer(() => {
        if (cancelled) return;
        const elapsed = clock.now() - startedAt;
        do {
          position.current += 1;
        } while (
          position.current + 1 < STARTUP_LOGO_FRAMES.length &&
          STARTUP_LOGO_FRAMES[position.current + 1]!.atMs <= elapsed
        );
        setIndex(position.current);
        scheduleNext();
      }, delay);
    }
    scheduleNext();
    return () => {
      cancelled = true;
      if (timer !== undefined) clock.clearTimer(timer);
    };
  }, [clock, enabled]);
  return enabled ? STARTUP_LOGO_FRAMES[index]! : FINAL_STARTUP_LOGO_FRAME;
}
