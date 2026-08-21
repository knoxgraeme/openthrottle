// Fly provider boundary: the only place the CLI shells out to `flyctl`.
// Commands are always spawned as argv arrays via execFile — never a shell
// string — with bounded output capture and a hard timeout. The typed helpers
// below parse `--json` output defensively: unknown fields are ignored, field
// casing follows the same fallback chain `.github/workflows/deploy.yml` uses
// against real Fly output, and malformed JSON raises a typed error instead of
// leaking raw exceptions.

import { execFile } from "node:child_process";

export interface FlyctlResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface FlyctlRunner {
  run(args: string[]): Promise<FlyctlResult>;
}

export interface FlyctlRunnerOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export const FLYCTL_TIMEOUT_MS = 120_000;
export const FLYCTL_MAX_BUFFER_BYTES = 1_048_576;

/** The flyctl binary could not be spawned at all (not installed / not on PATH). */
export class FlyctlNotFoundError extends Error {
  constructor(message = "flyctl was not found on PATH") {
    super(message);
    this.name = "FlyctlNotFoundError";
  }
}

/**
 * A flyctl command exited non-zero. `command` is a short safe label (for
 * example "secrets set"), never the full argv, so messages can be surfaced
 * without re-checking for secret values; callers of value-carrying commands
 * simply omit `detail`.
 */
export class FlyctlCommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: number,
    detail?: string
  ) {
    super(`flyctl ${command} exited with code ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "FlyctlCommandError";
  }
}

/** flyctl produced output the typed helpers could not interpret. */
export class FlyctlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlyctlParseError";
  }
}

/**
 * Default runner: `execFile("flyctl", args)` with the caller's environment
 * (so FLY_API_TOKEN passes through), a 120s timeout, and ~1 MiB capture.
 * Non-zero exits resolve with their code; only spawn failure rejects.
 */
export function createFlyctlRunner(options: FlyctlRunnerOptions = {}): FlyctlRunner {
  const env = options.env ?? process.env;
  const timeout = options.timeoutMs ?? FLYCTL_TIMEOUT_MS;
  const maxBuffer = options.maxBufferBytes ?? FLYCTL_MAX_BUFFER_BYTES;
  return {
    run(args: string[]): Promise<FlyctlResult> {
      return new Promise((resolve, reject) => {
        execFile(
          "flyctl",
          args,
          { env: env as NodeJS.ProcessEnv, timeout, maxBuffer, encoding: "utf8", windowsHide: true },
          (error, stdout, stderr) => {
            if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
              reject(new FlyctlNotFoundError());
              return;
            }
            const rawCode = (error as NodeJS.ErrnoException | null)?.code;
            const code = error ? (typeof rawCode === "number" ? rawCode : 1) : 0;
            resolve({ stdout, stderr, code });
          }
        );
      });
    },
  };
}

export interface FlyApp {
  name: string;
}

export interface FlyVolume {
  id: string;
  name: string;
  region: string;
  attachedMachineId: string | null;
}

/** flyctl never returns secret values; the list endpoint exposes names + digests only. */
export interface FlySecretName {
  name: string;
  digest?: string;
}

export interface FlyMachine {
  state: string;
  image?: string;
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function pickString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim() !== "") return entry;
  }
  return undefined;
}

function boundedExactString(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  pattern: RegExp,
): string {
  for (const key of keys) {
    if (!(key in value)) continue;
    const entry = value[key];
    if (typeof entry === "string" && pattern.test(entry)) return entry;
    throw new FlyctlParseError(`flyctl volumes list reported an invalid ${label}`);
  }
  throw new FlyctlParseError(`flyctl volumes list omitted ${label}`);
}

function boundedAttachment(value: Record<string, unknown>): string | null {
  for (const key of ["attached_machine_id", "attachedMachineId", "AttachedMachineId"]) {
    if (!(key in value)) continue;
    const entry = value[key];
    if (entry === null || entry === "") return null;
    if (typeof entry === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry)) {
      return entry;
    }
    throw new FlyctlParseError("flyctl volumes list reported an invalid attached Machine ID");
  }
  return null;
}

function parseJson(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new FlyctlParseError(`flyctl ${label} did not return valid JSON`);
  }
}

function parseJsonArray(stdout: string, label: string): Record<string, unknown>[] {
  const parsed = parseJson(stdout, label);
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) throw new FlyctlParseError(`flyctl ${label} did not return a JSON array`);
  return parsed.filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry)
  );
}

function assertAppArgument(app: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(app)) {
    throw new Error("Fly app name must be 1-63 letters, numbers, and dashes");
  }
}

/** Typed JSON helpers over a FlyctlRunner. All commands here are read-only. */
export class FlyctlClient {
  constructor(private readonly runner: FlyctlRunner) {}

  private async runJson(args: string[], label: string): Promise<FlyctlResult> {
    const result = await this.runner.run(args);
    if (result.code !== 0) {
      throw new FlyctlCommandError(label, result.code, excerpt(result.stderr));
    }
    return result;
  }

  async version(): Promise<string> {
    const result = await this.runJson(["version", "--json"], "version");
    const parsed = parseJson(result.stdout, "version");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const version = pickString(parsed as Record<string, unknown>, ["Version", "version"]);
      if (version) return version;
    }
    throw new FlyctlParseError("flyctl version did not report a version field");
  }

  async whoami(): Promise<string> {
    const result = await this.runJson(["auth", "whoami", "--json"], "auth whoami");
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      // Older flyctl releases print the account email as plain text even when
      // --json is passed. Accept a single whitespace-free token as the account.
      const plain = result.stdout.trim();
      if (plain && !/\s/.test(plain)) return plain;
      throw new FlyctlParseError("flyctl auth whoami did not return valid JSON");
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const email = pickString(parsed as Record<string, unknown>, ["email", "Email"]);
      if (email) return email;
    }
    throw new FlyctlParseError("flyctl auth whoami did not report an account email");
  }

  async appsList(): Promise<FlyApp[]> {
    const result = await this.runJson(["apps", "list", "--json"], "apps list");
    const apps: FlyApp[] = [];
    for (const entry of parseJsonArray(result.stdout, "apps list")) {
      const name = pickString(entry, ["name", "Name"]);
      if (name) apps.push({ name });
    }
    return apps;
  }

  async volumesList(app: string): Promise<FlyVolume[]> {
    assertAppArgument(app);
    const result = await this.runJson(["volumes", "list", "--app", app, "--json"], "volumes list");
    const volumes: FlyVolume[] = [];
    for (const entry of parseJsonArray(result.stdout, "volumes list")) {
      volumes.push({
        id: boundedExactString(entry, ["id", "ID"], "volume ID", /^vol_[a-z0-9]{1,64}$/),
        name: boundedExactString(
          entry,
          ["name", "Name"],
          "volume name",
          /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/,
        ),
        region: boundedExactString(entry, ["region", "Region"], "volume region", /^[a-z]{3}$/),
        attachedMachineId: boundedAttachment(entry),
      });
    }
    return volumes;
  }

  async secretsList(app: string): Promise<FlySecretName[]> {
    assertAppArgument(app);
    const result = await this.runJson(["secrets", "list", "--app", app, "--json"], "secrets list");
    const secrets: FlySecretName[] = [];
    for (const entry of parseJsonArray(result.stdout, "secrets list")) {
      const name = pickString(entry, ["Name", "name"]);
      if (!name) continue;
      const digest = pickString(entry, ["Digest", "digest"]);
      secrets.push(digest ? { name, digest } : { name });
    }
    return secrets;
  }

  async machinesList(app: string): Promise<FlyMachine[]> {
    assertAppArgument(app);
    const result = await this.runJson(["machines", "list", "--app", app, "--json"], "machines list");
    const machines: FlyMachine[] = [];
    for (const entry of parseJsonArray(result.stdout, "machines list")) {
      const state = (pickString(entry, ["state", "State"]) ?? "").toLowerCase();
      // Same image fallback chain the deploy workflow's jq uses:
      // .config.image // .Config.Image // .imageRef // .ImageRef // .image // .Image
      let image: string | undefined;
      for (const configKey of ["config", "Config"]) {
        const config = entry[configKey];
        if (config && typeof config === "object" && !Array.isArray(config)) {
          image = pickString(config as Record<string, unknown>, ["image", "Image"]);
          if (image) break;
        }
      }
      image ??= pickString(entry, ["imageRef", "ImageRef", "image", "Image"]);
      machines.push(image ? { state, image } : { state });
    }
    return machines;
  }
}
