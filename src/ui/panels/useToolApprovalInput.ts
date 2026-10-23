/** Input ownership for the mounted permission screen; global interruption remains with App. */
import { useInput } from "ink";
import { useRef } from "react";
import type { ToolApprovalAction, ToolApprovalSelection } from "../../core/providers/types.js";

export function useToolApprovalInput({
  requestId,
  options,
  selected,
  onNavigate,
  details,
  onSelect,
}: {
  requestId: string;
  options: readonly ToolApprovalAction[];
  selected: number;
  onNavigate: (index: number) => void;
  details: { offset: number; maxOffset: number; rows: number; onScroll: (offset: number) => void };
  onSelect: (selection: ToolApprovalSelection) => void;
}) {
  const submitted = useRef<string | null>(null);
  const send = (actionId: string | null) => {
    if (submitted.current === requestId) return;
    submitted.current = requestId;
    onSelect({ requestId, actionId });
  };
  // Mounting on the approval screen grants modal ownership. Delayed composer focus
  // effects must not disable approval keys or allow them through to the draft.
  useInput(
    (input, key) => {
      if (submitted.current === requestId || key.ctrl || key.meta) return;
      if (key.escape) return send(null);
      if (key.pageUp || key.pageDown || key.home || key.end) {
        const next = key.home
          ? 0
          : key.end
            ? details.maxOffset
            : details.offset + (key.pageUp ? -1 : 1) * Math.max(1, details.rows - 1);
        return details.onScroll(Math.max(0, Math.min(details.maxOffset, next)));
      }
      if (key.upArrow || input === "k" || key.downArrow || key.tab || input === "j") {
        return onNavigate(
          Math.max(
            0,
            Math.min(options.length - 1, selected + (key.upArrow || input === "k" ? -1 : 1)),
          ),
        );
      }
      // Ink can deliver repeated Return bytes together. One burst authorizes at most once.
      if (key.return || /^[\r\n]+$/.test(input)) return send(options[selected]?.id ?? null);
      const picked = /^[1-9]$/.test(input) ? options[Number(input) - 1] : undefined;
      if (picked) send(picked.id);
    },
    { isActive: true },
  );
}
