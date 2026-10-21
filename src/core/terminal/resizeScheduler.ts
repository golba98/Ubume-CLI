/** Leading resize updates, then one latest-dimensions update per frame. */
export function createResizeScheduler({
  commit,
  intervalMs = 16,
  schedule = setTimeout,
  cancel = clearTimeout,
}: {
  commit: () => void;
  intervalMs?: number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let disposed = false;
  const tick = () => {
    timer = null;
    if (disposed || !pending) return;
    pending = false;
    commit();
    timer = schedule(tick, intervalMs);
  };
  return {
    request() {
      if (disposed) return;
      if (timer !== null) {
        pending = true;
        return;
      }
      commit();
      timer = schedule(tick, intervalMs);
    },
    dispose() {
      disposed = true;
      pending = false;
      if (timer !== null) cancel(timer);
      timer = null;
    },
  };
}
