import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOOP_CREDENTIAL_ENV_NAMES, readLoopActionCredentialEnv } from "./loop-credentials.mjs";

describe("loop action credential envelope", () => {
  const directories = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function tempPath(name) {
    const directory = mkdtempSync(join(tmpdir(), "ot-loop-credentials-"));
    directories.push(directory);
    return join(directory, name);
  }

  it("reports the envelope as absent rather than silently yielding no credentials", () => {
    expect(readLoopActionCredentialEnv(tempPath("missing.json"))).toBeNull();
  });

  it("reads, validates, and deletes the sealed envelope", () => {
    const path = tempPath("credentials.json");
    writeFileSync(path, JSON.stringify({ env: { GITHUB_TOKEN: "secret-token" } }));
    expect(readLoopActionCredentialEnv(path)).toEqual({ GITHUB_TOKEN: "secret-token" });
    expect(existsSync(path)).toBe(false);
  });

  it("is idempotent after a restart: a second read of an already-consumed envelope reports absent", () => {
    const path = tempPath("credentials.json");
    writeFileSync(path, JSON.stringify({ env: { GITHUB_TOKEN: "secret-token" } }));
    readLoopActionCredentialEnv(path);
    expect(readLoopActionCredentialEnv(path)).toBeNull();
  });

  it("deletes the envelope even when its content is invalid", () => {
    const path = tempPath("credentials.json");
    writeFileSync(path, JSON.stringify({ env: { DAYTONA_API_KEY: "forbidden" } }));
    expect(() => readLoopActionCredentialEnv(path)).toThrow(/forbidden variable DAYTONA_API_KEY/);
    expect(existsSync(path)).toBe(false);
  });

  it("rejects a credential envelope naming a variable outside the sandbox allowlist", () => {
    const path = tempPath("credentials.json");
    writeFileSync(path, JSON.stringify({ env: { FLY_API_TOKEN: "forbidden" } }));
    expect(() => readLoopActionCredentialEnv(path)).toThrow(/forbidden variable FLY_API_TOKEN/);
  });

  it("rejects an envelope with an unknown top-level field", () => {
    const path = tempPath("credentials.json");
    writeFileSync(path, JSON.stringify({ env: {}, unset: [] }));
    expect(() => readLoopActionCredentialEnv(path)).toThrow(/unknown field unset/);
  });

  it("rejects an oversized envelope", () => {
    const path = tempPath("credentials.json");
    writeFileSync(path, JSON.stringify({ env: { GITHUB_TOKEN: "x".repeat(70_000) } }));
    expect(() => readLoopActionCredentialEnv(path)).toThrow(/exceeds 64 KiB/);
  });

  it("exposes exactly the four sandbox-eligible credential env names", () => {
    expect([...LOOP_CREDENTIAL_ENV_NAMES].sort()).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CODEX_AUTH_JSON",
      "GITHUB_TOKEN",
      "KIMI_CODE_API_KEY",
    ]);
  });

  it("surfaces the original read error rather than a masking delete error", () => {
    const path = tempPath("credentials.json");
    // A directory at the credentials path makes both readFileSync (EISDIR)
    // and a non-recursive rmSync (also EISDIR) fail; the read error must be
    // the one that surfaces, not whichever the cleanup attempt raises.
    mkdirSync(path);
    expect(() => readLoopActionCredentialEnv(path)).toThrow(/EISDIR/);
  });

  it("reads a CODEX_AUTH_JSON credential without altering its content", () => {
    const path = tempPath("credentials.json");
    writeFileSync(path, JSON.stringify({ env: { CODEX_AUTH_JSON: '{"token":"abc"}' } }));
    expect(readLoopActionCredentialEnv(path)).toEqual({ CODEX_AUTH_JSON: '{"token":"abc"}' });
  });

  it("keeps the sandbox-side credential env allowlist aligned with the Daytona adapter's STAGE_CREDENTIAL_ENV", () => {
    // The adapter (supervisor/src/providers/daytona/adapter.ts) decides which
    // credential env names may ever be uploaded to the sandbox; this file
    // decides which ones the sandbox will accept. Cross-check the two source
    // texts so a future change to one allowlist is caught if the other isn't
    // updated to match -- an undetected drift here either silently drops a
    // credential the adapter now permits, or hard-fails every loop action
    // that declares it.
    const sandboxSource = readFileSync(new URL("./loop-credentials.mjs", import.meta.url), "utf8");
    const sandboxMatch = sandboxSource.match(/export const LOOP_CREDENTIAL_ENV_NAMES = new Set\(\[([\s\S]*?)\]\);/);
    expect(sandboxMatch).not.toBeNull();
    const sandboxNames = JSON.parse(`[${sandboxMatch[1].replace(/,\s*$/, "")}]`).sort();

    const adapterSource = readFileSync(new URL("../../supervisor/src/providers/daytona/adapter.ts", import.meta.url), "utf8");
    const adapterMatch = adapterSource.match(/const STAGE_CREDENTIAL_ENV = new Set\(\[([\s\S]*?)\]\);/);
    expect(adapterMatch).not.toBeNull();
    const adapterNames = JSON.parse(`[${adapterMatch[1].replace(/,\s*$/, "")}]`).sort();

    expect(sandboxNames).toEqual(adapterNames);
  });
});
