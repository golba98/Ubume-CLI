/** Shared read-only view of the launcher's positively probed terminal capabilities. */
import { useStdout } from "ink";
import { useSyncExternalStore } from "react";
import { getStartupGraphicsChannel, NO_GRAPHICS } from "../../core/terminal/startupGraphics.js";

const noSubscribe = () => () => {};
const noGraphics = () => NO_GRAPHICS;
export function useStartupGraphicsCapabilities() {
  const { stdout } = useStdout();
  const channel = getStartupGraphicsChannel(stdout);
  const capabilities = useSyncExternalStore(
    channel?.subscribe ?? noSubscribe,
    channel ? () => channel.capabilities : noGraphics,
    noGraphics,
  );
  const trueColor = typeof stdout.getColorDepth === "function" && stdout.getColorDepth() >= 24;
  return { channel, capabilities, trueColor };
}
