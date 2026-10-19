"""Validate delivery and saved stream order independently of live-viewport replay timing."""
import re

TOKEN_TEXT = re.compile(r"⟦(\d+)⟧")


def tokens(text):
    return [int(token) for token in TOKEN_TEXT.findall(text)]


def validate_delivery(records, total):
    expected = list(range(1, total + 1))
    return [f"{stage}: missing, duplicated or reordered delivery tokens"
            for stage in ("emit", "handler", "normalize", "schedule")
            if [row["seq"] for row in records if row.get("stage") == stage and "seq" in row] != expected]


def validate_canonical(snapshot, expected_text, expected_tools, total):
    errors = []
    if sorted(expected_text + expected_tools) != list(range(1, total + 1)):
        return ["fixture emission manifest is incomplete or duplicated"]
    if snapshot.get("version") != 2:
        return ["missing canonical conversation snapshot"]
    runs = [event for event in snapshot.get("session", {}).get("events", [])
            if event.get("type") == "run"]
    if not runs or runs[-1].get("status") != "completed":
        return ["measured run did not complete in the saved workbench"]
    run = runs[-1]
    segments = {segment["id"]: segment for segment in run.get("responseSegments", [])}
    activities = {activity["id"]: activity for activity in run.get("toolActivities", [])}
    ordered = []
    for item in run.get("streamItems", []):
        if item.get("kind") == "response":
            segment = segments.get(item.get("refId"))
            if segment is None:
                errors.append("missing response segment reference")
            else:
                ordered.extend(tokens("".join(segment.get("chunks", []))))
        elif item.get("kind") == "action":
            activity = activities.get(item.get("refId"))
            if activity is None:
                errors.append("missing tool activity reference")
            else:
                ordered.extend(tokens(activity.get("command", "")))
    if ordered != list(range(1, total + 1)):
        errors.append("saved workbench stream: missing, duplicated or reordered tokens")
    response = [token for segment in run.get("responseSegments", [])
                for token in tokens("".join(segment.get("chunks", [])))]
    messages = [token for message in snapshot.get("messages", [])
                if message.get("role") == "assistant" for token in tokens(message.get("content", ""))]
    tools = [token for activity in run.get("toolActivities", [])
             for token in tokens(activity.get("command", ""))]
    for name, actual, expected in [("saved response segments", response, expected_text),
                                   ("saved tool sequence", tools, expected_tools)]:
        if actual != expected:
            errors.append(f"{name}: missing, duplicated or reordered tokens")
    if expected_text:
        if messages != expected_text:
            errors.append("canonical assistant messages: missing, duplicated or reordered tokens")
    elif messages != expected_tools[:len(messages)]:
        # Tool-only runs persist a compact activity summary instead of an empty reply.
        errors.append("tool-only activity summary contains unknown or reordered tokens")
    return errors
