import type { HostingSetupAdapter, ProviderId, RuntimeSetupAdapter } from "./contracts.js";
import { assertProviderId } from "./contracts.js";

export class ProviderCatalog<T extends { readonly id: ProviderId }> {
  private readonly entries = new Map<ProviderId, T>();

  constructor(readonly axis: "hosting" | "runtime", adapters: readonly T[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: T): void {
    assertProviderId(adapter.id, `${this.axis} provider ID`);
    if (this.entries.has(adapter.id)) {
      throw new Error(`${this.axis} provider ${adapter.id} is already registered`);
    }
    this.entries.set(adapter.id, adapter);
  }

  get(id: ProviderId): T {
    assertProviderId(id, `${this.axis} provider ID`);
    const adapter = this.entries.get(id);
    if (!adapter) throw new Error(`unknown ${this.axis} provider ${id}`);
    return adapter;
  }

  list(): ProviderId[] {
    return [...this.entries.keys()].sort();
  }
}

export interface ProviderCatalogs {
  hosting: ProviderCatalog<HostingSetupAdapter>;
  runtime: ProviderCatalog<RuntimeSetupAdapter>;
}

export function createProviderCatalogs(input?: {
  hosting?: readonly HostingSetupAdapter[];
  runtime?: readonly RuntimeSetupAdapter[];
}): ProviderCatalogs {
  return {
    hosting: new ProviderCatalog("hosting", input?.hosting ?? []),
    runtime: new ProviderCatalog("runtime", input?.runtime ?? []),
  };
}
