/** Shared authorization validation. Presentation indexes never cross this boundary. */
import { randomUUID } from "node:crypto";
import type { ToolApprovalAction, ToolApprovalRequest } from "./types.js";

const identities = new WeakMap<ToolApprovalRequest, string>();

export function toolApprovalRequestId(request: ToolApprovalRequest): string {
  if (request.requestId) return request.requestId;
  let id = identities.get(request);
  if (!id) {
    id = randomUUID();
    identities.set(request, id);
  }
  return id;
}

/** Claude/Local's established host decisions; native option menus must be explicit. */
export function toolApprovalActions(request: ToolApprovalRequest): readonly ToolApprovalAction[] {
  if (
    typeof request.tool !== "string" ||
    !request.tool.trim() ||
    typeof request.signature !== "string" ||
    !request.signature.trim() ||
    !Array.isArray(request.paths) ||
    request.paths.some((path) => typeof path !== "string") ||
    (request.command !== undefined && typeof request.command !== "string") ||
    (request.actions !== undefined && !Array.isArray(request.actions))
  )
    return [];
  const actions = request.actions ?? [
    { id: "allow-once", label: "Allow once", decision: "allow-once" },
    ...(request.allowForRun !== false && !request.outsideWorkspace
      ? [
          {
            id: "allow-for-run",
            label: "Allow this exact action for this run",
            decision: "allow-for-run",
          },
        ]
      : []),
    { id: "deny", label: "Deny", decision: "deny" },
  ];
  const ids = new Set<string>();
  for (const action of actions) {
    if (
      !action ||
      typeof action.id !== "string" ||
      !action.id.trim() ||
      typeof action.label !== "string" ||
      !action.label.trim() ||
      !["allow-once", "allow-for-run", "deny"].includes(action.decision) ||
      ids.has(action.id) ||
      (action.decision === "allow-for-run" &&
        (request.allowForRun === false || request.outsideWorkspace))
    )
      return [];
    ids.add(action.id);
  }
  return actions as readonly ToolApprovalAction[];
}

/** Unknown, ambiguous, forbidden and stale decisions all fail closed. */
export function selectedToolApprovalAction(
  request: ToolApprovalRequest,
  result: unknown,
): ToolApprovalAction | null {
  const actions = toolApprovalActions(request);
  if (typeof result === "string") {
    const matches = actions.filter((action) => action.decision === result);
    return matches.length === 1 ? matches[0]! : null;
  }
  if (!result || typeof result !== "object" || !("requestId" in result) || !("actionId" in result))
    return null;
  if (result.requestId !== toolApprovalRequestId(request)) return null;
  return actions.find((action) => action.id === result.actionId) ?? null;
}
