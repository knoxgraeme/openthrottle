import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileSecretStore, envNameForSecret } from "./secret-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-secret-test-"));
  directories.push(directory);
  return directory;
}

describe("local file secret store", () => {
  it("stores only allowlisted CLI-reused secrets in owner-only files", async () => {
    const root = temporaryDirectory();
    const store = new LocalFileSecretStore({ root, allowedKeys: ["status_token"] });

    await store.set("default", "status_token", "canary-status");

    const path = join(root, "default.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("status_token");
    await expect(store.get("default", "status_token")).resolves.toBe("canary-status");
    await expect(store.set("default", "install_token", "provision-only")).rejects.toThrow("not allowed");
  });

  it("uses environment overrides before persisted values", async () => {
    const root = temporaryDirectory();
    const env = { [envNameForSecret("prod", "status_token")]: "from-env" };
    const store = new LocalFileSecretStore({ root, allowedKeys: ["status_token"], env });

    await store.set("prod", "status_token", "from-file");

    await expect(store.get("prod", "status_token")).resolves.toBe("from-env");
  });

  it("keeps named-profile environment overrides injective and isolated from default overrides", async () => {
    expect(envNameForSecret("prod.foo", "status_token")).not.toBe(envNameForSecret("prod-foo", "status_token"));
    const root = temporaryDirectory();
    const store = new LocalFileSecretStore({
      root,
      allowedKeys: ["status_token"],
      env: { OT_STATUS_TOKEN: "default-token", [envNameForSecret("prod.foo", "status_token")]: "prod-token" },
    });

    await expect(store.get("prod.foo", "status_token")).resolves.toBe("prod-token");
    await expect(store.get("prod-foo", "status_token")).resolves.toBeUndefined();
    await expect(store.get("default", "status_token")).resolves.toBe("default-token");
  });

  it("refuses to read unsafe existing permissions", async () => {
    const root = temporaryDirectory();
    const path = join(root, "default.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema: "openthrottle.local-secrets/v1",
        profile: "default",
        secrets: { status_token: "unsafe" },
      })
    );
    chmodSync(path, 0o644);
    const store = new LocalFileSecretStore({ root, allowedKeys: ["status_token"] });

    await expect(store.get("default", "status_token")).rejects.toThrow("refusing to read");
  });
});
