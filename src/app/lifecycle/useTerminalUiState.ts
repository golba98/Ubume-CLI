/**
 * Publishes the UI state machine's current state to the terminal layer.
 *
 * The terminal controller and the terminal-title lifecycle use it to decide,
 * for example, whether a title or mouse-mode change is safe right now. This is
 * functional state, not debug output, so it lives apart from
 * `useAppDebugTracing`.
 */

import { useEffect } from "react";
import { setTerminalControlUIState } from "../../core/terminal/terminalControl.js";
import { setTerminalTitleLifecycleState } from "../../core/terminal/terminalTitle.js";
import type { UIState } from "../../session/types.js";

export function useTerminalUiState(uiStateKind: UIState["kind"], busy: boolean) {
  useEffect(() => {
    setTerminalControlUIState(uiStateKind);
    setTerminalTitleLifecycleState(`${uiStateKind}${busy ? ":busy" : ":idle"}`);
  }, [busy, uiStateKind]);
}
