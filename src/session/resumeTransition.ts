/** One cancellable preparation at a time; only its owner can commit or finish. */
export class ResumeTransition {
  private generation = 0;
  private controller?: AbortController;
  phase: "idle" | "preparing" | "committing" | "handoff" = "idle";

  begin() {
    if (this.phase !== "idle") throw new Error("A session switch is already in progress.");
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    this.phase = "preparing";
    const current = () => this.generation === generation && !controller.signal.aborted;
    return {
      signal: controller.signal,
      current,
      commit: (handoff = false) => {
        if (!current()) throw new Error("Session switch canceled.");
        this.phase = handoff ? "handoff" : "committing";
      },
      finish: () => {
        if (this.generation === generation) {
          this.controller = undefined;
          this.phase = "idle";
        }
      },
    };
  }

  cancel(): boolean {
    if (this.phase !== "preparing") return false;
    this.controller?.abort();
    return true;
  }
}
