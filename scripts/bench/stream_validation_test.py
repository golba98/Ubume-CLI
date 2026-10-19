"""Stream checks detect real loss/reordering without mistaking viewport backfill for it."""
import unittest
from stream_validation import validate_canonical, validate_delivery


def snapshot(segments=((1, (1, 2)), (4, (4,))), tools=((3, 3),)):
    content = " ".join(f"⟦{token}⟧" for _, values in segments for token in values)
    response_segments = [{"id": f"s{position}", "chunks": [" ".join(f"⟦{t}⟧" for t in values)]}
                         for position, values in segments]
    activities = [{"id": f"t{position}", "command": f"step ⟦{token}⟧"} for position, token in tools]
    items = sorted([{"streamSeq": position, "kind": "response", "refId": f"s{position}"}
                    for position, _ in segments] +
                   [{"streamSeq": position, "kind": "action", "refId": f"t{position}"}
                    for position, _ in tools], key=lambda item: item["streamSeq"])
    return {"version": 2, "messages": [{"role": "assistant", "content": content}],
            "session": {"events": [{"type": "run", "status": "completed", "responseSegments": response_segments,
                                     "toolActivities": activities, "streamItems": items}]}}


class CanonicalStreamTest(unittest.TestCase):
    def test_late_viewport_backfill_does_not_mean_canonical_content_was_reordered(self):
        observed = {1: 1, 2: 10, 3: 3, 4: 4}
        self.assertGreater(observed[2], observed[3])
        self.assertEqual(validate_canonical(snapshot(), [1, 2, 4], [3], 4), [])

    def test_reordered_missing_and_duplicate_response_tokens_fail(self):
        for values in [(2, 1), (1,), (1, 2, 2)]:
            self.assertTrue(validate_canonical(snapshot(((1, values), (4, (4,)))), [1, 2, 4], [3], 4))

    def test_saved_message_disagreement_and_reordered_tools_fail(self):
        value = snapshot()
        value["messages"][0]["content"] = "⟦1⟧ ⟦4⟧"
        self.assertTrue(validate_canonical(value, [1, 2, 4], [3], 4))
        self.assertTrue(validate_canonical(snapshot(((1, (1,)), (4, (4,))), ((2, 3), (3, 2))), [1, 4], [2, 3], 4))

    def test_incomplete_snapshot_or_invalid_emission_manifest_fail(self):
        value = snapshot()
        value["session"]["events"][0]["status"] = "running"
        self.assertTrue(validate_canonical(value, [1, 2, 4], [3], 4))
        self.assertTrue(validate_canonical({}, [1, 2, 4], [3], 4))
        self.assertTrue(validate_canonical(snapshot(), [1, 2], [3], 4))

    def test_delivery_requires_every_stage_in_emission_order(self):
        records = [{"stage": stage, "seq": seq} for seq in (1, 2)
                   for stage in ("emit", "handler", "normalize", "schedule")]
        self.assertEqual(validate_delivery(records, 2), [])
        for altered in [[row for row in records if row != {"stage": "handler", "seq": 1}],
                        records + [{"stage": "normalize", "seq": 2}],
                        [dict(row, seq=3-row["seq"]) if row["stage"] == "schedule" else row for row in records]]:
            self.assertTrue(validate_delivery(altered, 2))

    def test_global_workbench_order_and_references_are_checked(self):
        value = snapshot()
        value["session"]["events"][0]["streamItems"].reverse()
        self.assertTrue(validate_canonical(value, [1, 2, 4], [3], 4))
        value = snapshot()
        value["session"]["events"][0]["streamItems"][0]["refId"] = "missing"
        self.assertTrue(validate_canonical(value, [1, 2, 4], [3], 4))


if __name__ == "__main__":
    unittest.main()
