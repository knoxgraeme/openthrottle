import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCodexAuthFile } from "./loop-agent-environment.mjs";

describe("Codex auth.json materialization", () => {
  const directories = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function tempCodexHome() {
    const directory = mkdtempSync(join(tmpdir(), "ot-codex-home-"));
    directories.push(directory);
    return directory;
  }

  // Exercises writeCodexAuthFile directly rather than through the full
  // prepareActionHomeEnvironment/runLoopAgentInPreparedRepository pipeline:
  // the full pipeline additionally calls materializeCodexProfileBaseline,
  // which copies from a root-owned trusted baseline and so cannot run in a
  // non-root test/CI environment. writeCodexAuthFile itself has no such
  // dependency -- it only writes to the codexHome directory it is given.
  it("writes the exact supplied credential content to auth.json with mode 0600", () => {
    const codexHome = tempCodexHome();
    writeCodexAuthFile(codexHome, '{"token":"codex-secret-value"}');
    const authPath = join(codexHome, "auth.json");
    expect(existsSync(authPath)).toBe(true);
    expect(readFileSync(authPath, "utf8")).toBe('{"token":"codex-secret-value"}');
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  });

  it("overwrites a previously rotated auth.json with fresh content", () => {
    const codexHome = tempCodexHome();
    writeCodexAuthFile(codexHome, '{"token":"first"}');
    writeCodexAuthFile(codexHome, '{"token":"rotated"}');
    expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toBe('{"token":"rotated"}');
  });

  it("writes the destination file at exactly codexHome/auth.json regardless of content", () => {
    // The destination path is always the fixed literal "auth.json" resolved
    // under the given codexHome -- the credential content itself never
    // influences the write location, so adversarial-looking content cannot
    // cause a path escape.
    const codexHome = tempCodexHome();
    writeCodexAuthFile(codexHome, "not json, just a plain string value");
    expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toBe("not json, just a plain string value");
  });
});
