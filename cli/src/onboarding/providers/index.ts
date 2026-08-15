// Default provider registry for `openthrottle setup`.
//
// This module lives inside the providers/ subtree, so naming the concrete
// Fly hosting and Daytona runtime adapters here is allowed; everything above
// it in cli/src/onboarding/ stays provider-neutral and receives only the
// ProviderCatalogs contract.

import type { ProfileSecretStore } from "../contracts.js";
import { createProviderCatalogs, type ProviderCatalogs } from "../provider-catalog.js";
import { createDaytonaRuntimeAdapter } from "./daytona/runtime-adapter.js";
import { createFlyHostingAdapter, createProfileSecretsPort } from "./fly/hosting-adapter.js";

export const DEFAULT_HOSTING_PROVIDER_ID = "fly";
export const DEFAULT_RUNTIME_PROVIDER_ID = "daytona";

/** Provider-neutral dependencies threaded into the default adapters. */
export interface DefaultCatalogDeps {
  /** Profile whose local secret store scope backs generated supervisor secrets. */
  profileName: string;
  secretStore: ProfileSecretStore;
  env?: Record<string, string | undefined>;
  /** Hosting resource pins resolved by the caller (profile, env, defaults). */
  hosting?: { app?: string; org?: string; region?: string };
  log?: (message: string) => void;
}

export function createDefaultCatalogs(deps: DefaultCatalogDeps): ProviderCatalogs {
  return createProviderCatalogs({
    hosting: [
      createFlyHostingAdapter({
        secrets: createProfileSecretsPort(deps.secretStore, deps.profileName),
        env: deps.env,
        app: deps.hosting?.app,
        org: deps.hosting?.org,
        region: deps.hosting?.region,
        log: deps.log,
      }),
    ],
    runtime: [createDaytonaRuntimeAdapter({ env: deps.env, log: deps.log })],
  });
}
