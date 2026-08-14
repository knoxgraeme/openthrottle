import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileProfileStore,
  createProfile,
  validateProfile,
  withResources,
  type OnboardingProfile,
} from "./profile-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-profile-test-"));
  directories.push(directory);
  return directory;
}

describe("onboarding profile store", () => {
  it("persists versioned non-secret provider state with owner-only permissions", async () => {
    const root = temporaryDirectory();
    const store = new FileProfileStore(root);
    const profile = createProfile({
      name: "default",
      hostingProvider: "fake-host",
      runtimeProvider: "fake-runtime",
      now: new Date("2026-07-28T00:00:00Z"),
    });
    profile.resources.hostingApp = "app-1";
    profile.release = { releaseId: "v2.0.0", cliVersion: "2.0.0" };
    profile.evidence.hosting = {
      status: "ready",
      owner: "hosting_provider",
      summary: "app exists",
      resourceRef: "app-1",
      observedAt: "2026-07-28T00:00:00.000Z",
    };

    await store.save(profile);

    const savedPath = join(root, "default.json");
    expect(statSync(savedPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(savedPath, "utf8")).not.toContain("secret");
    await expect(store.load("default")).resolves.toEqual(profile);
  });

  it("rejects unknown schema versions, unknown fields, and mismatched names", async () => {
    const root = temporaryDirectory();
    const store = new FileProfileStore(root);
    writeFileSync(
      join(root, "default.json"),
      JSON.stringify({
        schema: "openthrottle.profile/v2",
        name: "default",
        providers: { hosting: "fake-host", runtime: "fake-runtime" },
        resources: {},
        evidence: {},
        updatedAt: "2026-07-28T00:00:00.000Z",
      })
    );
    chmodSync(join(root, "default.json"), 0o600);
    await expect(store.load("default")).rejects.toThrow("unsupported profile schema");

    expect(() =>
      validateProfile({
        schema: "openthrottle.profile/v1",
        name: "default",
        providers: { hosting: "fake-host", runtime: "fake-runtime" },
        resources: {},
        evidence: {},
        updatedAt: "2026-07-28T00:00:00.000Z",
        extra: true,
      })
    ).toThrow("unknown field");

    writeFileSync(
      join(root, "default.json"),
      JSON.stringify({
        schema: "openthrottle.profile/v1",
        name: "other",
        providers: { hosting: "fake-host", runtime: "fake-runtime" },
        resources: {},
        evidence: {},
        updatedAt: "2026-07-28T00:00:00.000Z",
      })
    );
    chmodSync(join(root, "default.json"), 0o600);
    await expect(store.load("default")).rejects.toThrow("profile file name does not match");
  });

  it("pins provider resources through withResources without mutating the input profile", () => {
    const profile = createProfile({
      name: "default",
      hostingProvider: "fake-host",
      runtimeProvider: "fake-runtime",
      now: new Date("2026-07-28T00:00:00Z"),
    });

    const updated = withResources(
      profile,
      { fly_app: "ot-supervisor", fly_org: "acme", fly_region: "iad", daytona_snapshot: "openthrottle-v13" },
      new Date("2026-07-29T00:00:00Z")
    );

    expect(updated.resources).toEqual({
      fly_app: "ot-supervisor",
      fly_org: "acme",
      fly_region: "iad",
      daytona_snapshot: "openthrottle-v13",
    });
    expect(updated.updatedAt).toBe("2026-07-29T00:00:00.000Z");
    expect(profile.resources).toEqual({});
    expect(profile.updatedAt).toBe("2026-07-28T00:00:00.000Z");

    const repinned = withResources(updated, { fly_region: "lhr" }, new Date("2026-07-30T00:00:00Z"));
    expect(repinned.resources.fly_region).toBe("lhr");
    expect(repinned.resources.fly_app).toBe("ot-supervisor");

    expect(() => withResources(profile, { fly_org: " " })).toThrow("non-empty");
  });

  it("does not accept invalid provider IDs in profiles", () => {
    const profile: OnboardingProfile = {
      schema: "openthrottle.profile/v1",
      name: "default",
      providers: { hosting: "Fly", runtime: "fake-runtime" },
      resources: {},
      evidence: {},
      updatedAt: "2026-07-28T00:00:00.000Z",
    };

    expect(() => validateProfile(profile)).toThrow("provider ID");
  });
});
