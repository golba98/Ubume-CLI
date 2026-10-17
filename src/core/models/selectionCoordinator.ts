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

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
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
  navigate(providerId?: ProviderId): void {
    this.navigation++;
    if (providerId) this.selectedProviderId = providerId;
  }
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
  isCurrent(transition: SelectionTransition): boolean {
    return transition.id === this.generation && !transition.signal.aborted;
  }
  ownsNavigation(transition: SelectionTransition): boolean {
    return this.isCurrent(transition) && transition.navigation === this.navigation;
  }
  finish(transition: SelectionTransition): void {
    if (this.isCurrent(transition)) this.candidate = null;
  }
  commit(transition: SelectionTransition): boolean {
    if (!this.isCurrent(transition)) return false;
    this.models.set(this.key(transition.connection, transition.route.modelId), {
      status: "provisional",
    });
    this.interactiveSelection = true;
    this.emit();
    return true;
  }
  state(connection: string, model: string): SelectedModelState | undefined {
    return this.models.get(this.key(connection, model));
  }
  revision(connection: string, model: string): number {
    return this.revisions.get(this.key(connection, model)) ?? 0;
  }
  retryDelay(connection: string, model: string, now = Date.now()): number {
    return Math.max(0, (this.retryAt.get(this.key(connection, model)) ?? 0) - now);
  }
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
  cancel(): void {
    this.controller?.abort();
    this.generation++;
    this.candidate = null;
  }
}
