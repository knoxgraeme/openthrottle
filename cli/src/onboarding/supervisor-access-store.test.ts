import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalSupervisorAccessStore,
  SUPERVISOR_ACCESS_SCHEMA,
} from "./supervisor-access-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-access-test-"));
  directories.push(directory);
  return directory;
}

describe("local supervisor access store", () => {
  it("round-trips a profile-scoped access pair in an owner-only document", async () => {
    const store = new LocalSupervisorAccessStore(temporaryDirectory());

    await store.save("prod", {
      supervisorUrl: "https://supervisor.example.com",
      statusToken: "operator-token",
    });

    expect(JSON.parse(readFileSync(store.pathFor("prod"), "utf8"))).toEqual({
      schema: SUPERVISOR_ACCESS_SCHEMA,
      profile: "prod",
      supervisor_url: "https://supervisor.example.com",
      status_token: "operator-token",
    });
    expect(statSync(store.pathFor("prod")).mode & 0o777).toBe(0o600);
    await expect(store.load("prod")).resolves.toEqual({
      supervisorUrl: "https://supervisor.example.com",
      statusToken: "operator-token",
    });
  });

  it("refuses permissive files and non-origin supervisor URLs", async () => {
    const store = new LocalSupervisorAccessStore(temporaryDirectory());
    await expect(store.save("default", {
      supervisorUrl: "https://supervisor.example.com/path",
      statusToken: "operator-token",
    })).rejects.toThrow(/HTTPS origin/);

    await store.save("default", {
      supervisorUrl: "https://supervisor.example.com",
      statusToken: "operator-token",
    });
    chmodSync(store.pathFor("default"), 0o644);
    await expect(store.load("default")).rejects.toThrow(
      /supervisor access document.*default\.json.*permissions 644/
    );
  });

  it("rejects a truncated access document", async () => {
    const store = new LocalSupervisorAccessStore(temporaryDirectory());
    await store.save("default", {
      supervisorUrl: "https://supervisor.example.com",
      statusToken: "operator-token",
    });
    writeFileSync(store.pathFor("default"), "{");

    await expect(store.load("default")).rejects.toThrow(/JSON/);
  });
});
