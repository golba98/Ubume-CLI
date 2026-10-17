/**
 * Session-owned model selection ordering and connection-scoped validation/rejection evidence.
 * Navigation ownership is distinct from request generation; neither provider health nor
 * persisted preferences are stored here.
 */

import type { ProviderId } from "../providerLauncher/types.js";
import { isModelFailure, type ProviderFailure } from "../providerRuntime/failures.js";
import type { ProviderRoute } from "../providerRuntime/types.js";

export interface SelectionTransition {
  id: number;
  navigation: number;
  route: ProviderRoute;
  connection: string;
  signal: AbortSignal;
}

export interface SelectedModelState {
  status: "provisional" | "validated" | "unavailable";
  failure?: ProviderFailure;
}

/** Session-owned selection ordering and model evidence, independent of provider health. */
export class SelectionCoordinator {
  private generation = 0;
  private navigation = 0;
  private controller?: AbortController;
  private models = new Map<string, SelectedModelState>();
  private revisions = new Map<string, number>();
  private retryAt = new Map<string, number>();
  private listeners = new Set<() => void>();
  private version = 0;
  selectedProviderId: ProviderId | null = null;
  candidate: SelectionTransition | null = null;
  lastValidatedRoute: ProviderRoute | null = null;
  interactiveSelection = false;

  /** Subscribes to evidence changes; the caller owns the returned unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** Stable revision snapshot for external-store consumers; does not expose mutable maps. */
  getSnapshot = (): number => this.version;
  private emit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }
  private key(connection: string, model: string): string {
    return JSON.stringify([connection, model]);
  }
  get navigationToken(): number {
    return this.navigation;
  }
  /**
   * Advances navigation ownership without canceling model evidence already in flight.
   */
  navigate(providerId?: ProviderId): void {
    this.navigation++;
    if (providerId) this.selectedProviderId = providerId;
  }
  /**
   * Supersedes the previous selection attempt and advances this connection/model revision.
   */
  begin(route: ProviderRoute, connection: string): SelectionTransition {
    this.controller?.abort();
    this.controller = new AbortController();
    const transition = {
      id: ++this.generation,
      navigation: this.navigation,
      route,
      connection,
      signal: this.controller.signal,
    };
    this.selectedProviderId = route.providerId;
    this.candidate = transition;
    const key = this.key(connection, route.modelId);
    this.revisions.set(key, this.revision(connection, route.modelId) + 1);
    return transition;
  }
  /**
   * Checks selection generation and cancellation independently from navigation ownership.
   */
  isCurrent(transition: SelectionTransition): boolean {
    return transition.id === this.generation && !transition.signal.aborted;
  }
  /**
   * Checks whether an attempt still owns the current picker/navigation context.
   */
  ownsNavigation(transition: SelectionTransition): boolean {
    return this.isCurrent(transition) && transition.navigation === this.navigation;
  }
  /**
   * Clears the pending candidate only when the finishing attempt is still current.
   */
  finish(transition: SelectionTransition): void {
    if (this.isCurrent(transition)) this.candidate = null;
  }
  /**
   * Publishes provisional selection evidence for the current attempt; request success
   * validates it separately.
   */
  commit(transition: SelectionTransition): boolean {
    if (!this.isCurrent(transition)) return false;
    this.models.set(this.key(transition.connection, transition.route.modelId), {
      status: "provisional",
    });
    this.interactiveSelection = true;
    this.emit();
    return true;
  }
  /**
   * Reads session-only evidence for one connection/model pair.
   */
  state(connection: string, model: string): SelectedModelState | undefined {
    return this.models.get(this.key(connection, model));
  }
  /**
   * Reads the revision used to ignore outcomes from superseded model attempts.
   */
  revision(connection: string, model: string): number {
    return this.revisions.get(this.key(connection, model)) ?? 0;
  }
  /**
   * Returns the remaining retry delay in milliseconds, clamped at zero.
   */
  retryDelay(connection: string, model: string, now = Date.now()): number {
    return Math.max(0, (this.retryAt.get(this.key(connection, model)) ?? 0) - now);
  }
  /**
   * Records current-revision model failures and retry delays; unrelated failures do not
   * blacklist a model.
   */
  reject(
    connection: string,
    model: string,
    failure: ProviderFailure,
    revision = this.revision(connection, model),
  ): void {
    if (revision !== this.revision(connection, model)) return;
    if (failure.retryAfterMs != null && failure.retryAfterMs > 0)
      this.retryAt.set(this.key(connection, model), Date.now() + failure.retryAfterMs);
    if (!isModelFailure(failure)) return;
    this.models.set(this.key(connection, model), { status: "unavailable", failure });
    this.emit();
  }
  /**
   * Marks only current-revision request evidence validated and remembers the last successful
   * route.
   */
  validate(
    connection: string,
    route: ProviderRoute,
    revision = this.revision(connection, route.modelId),
  ): void {
    if (revision !== this.revision(connection, route.modelId)) return;
    this.models.set(this.key(connection, route.modelId), { status: "validated" });
    this.lastValidatedRoute = route;
    this.emit();
  }
  /**
   * Aborts and invalidates the candidate without clearing existing model evidence or saved
   * preferences.
   */
  cancel(): void {
    this.controller?.abort();
    this.generation++;
    this.candidate = null;
  }
}
