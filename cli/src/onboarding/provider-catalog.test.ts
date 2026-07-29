import { describe, expect, it } from "vitest";
import type { HostingSetupAdapter, RuntimeSetupAdapter } from "./contracts.js";
import { createProviderCatalogs } from "./provider-catalog.js";

const runtime = { id: "fake-runtime" } as RuntimeSetupAdapter;
const hosting = { id: "fake-host" } as HostingSetupAdapter;

describe("provider catalogs", () => {
  it("registers hosting and runtime providers independently", () => {
    const catalogs = createProviderCatalogs({ hosting: [hosting], runtime: [runtime] });

    expect(catalogs.hosting.get("fake-host")).toBe(hosting);
    expect(catalogs.runtime.get("fake-runtime")).toBe(runtime);
    expect(catalogs.hosting.list()).toEqual(["fake-host"]);
    expect(catalogs.runtime.list()).toEqual(["fake-runtime"]);
  });

  it("fails closed for unknown, duplicate, or invalid provider IDs", () => {
    expect(() => createProviderCatalogs({ hosting: [hosting, hosting] })).toThrow("already registered");
    expect(() => createProviderCatalogs({ runtime: [{ id: "Fake" } as RuntimeSetupAdapter] })).toThrow("provider ID");
    const catalogs = createProviderCatalogs({ hosting: [hosting], runtime: [runtime] });
    expect(() => catalogs.hosting.get("missing")).toThrow("unknown hosting provider");
  });
});
