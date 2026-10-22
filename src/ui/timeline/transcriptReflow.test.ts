import { expect, test } from "bun:test";
import type { RenderTimelineItem } from "./measure/types.js";
import { prepareTranscriptReflow } from "./transcriptReflow.js";

const options = { totalWidth: 100, verboseMode: false, workspaceRoot: null };
test("historical reflow yields to input and preserves every prepared item", async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ key: String(i) }) as RenderTimelineItem);
  let yielded = false;
  setTimeout(() => {
    yielded = true;
  }, 0);
  const parts = await new Promise<Map<string, unknown>>((resolve) =>
    prepareTranscriptReflow(items, options, resolve, {
      sliceMs: 0,
      build: () => ({ staticItems: [], liveRows: [] }),
    }),
  );
  expect(yielded).toBe(true);
  expect([...parts.keys()]).toEqual(items.map((item) => item.key));
});
test("canceled historical preparation cannot publish or retain stale parts", async () => {
  let committed = false,
    built = 0;
  const cancel = prepareTranscriptReflow(
    [{} as RenderTimelineItem],
    options,
    () => {
      committed = true;
    },
    {
      build: () => {
        built++;
        return { staticItems: [], liveRows: [] };
      },
    },
  );
  cancel();
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(committed).toBe(false);
  expect(built).toBe(0);
});
