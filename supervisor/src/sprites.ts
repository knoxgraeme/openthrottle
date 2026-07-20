// Fly Sprites client + the sandbox-facing surface the supervisor drives.
//
// Replaces daytona.ts as a complete switchover. A Sprite is a persistent,
// name-addressed microVM: create is idempotent by name, the filesystem
// persists across pauses, and the platform idle-pauses/wakes on its own — so
// there is no autostop to manage (the daytona.ts active/idle helpers are gone).
//
// The wire protocol is pinned from the superfly/sprites-js source; see
// spike/PROTOCOL.md. Only ~10 endpoints are needed, so this is a thin typed
// fetch client with no dependency on @fly/sprites (which requires Node 24).

import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";
import type { Agent, TaskType } from "./db.js";

const DEFAULT_BASE_URL = "https://api.sprites.dev";
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 4;

// ---------------------------------------------------------------------------
// Sandbox env contract (moved from daytona.ts; adds SUPERVISOR_URL for push
// callbacks — a public URL, not a secret).
// ---------------------------------------------------------------------------

export interface SandboxEnvContract {
  TASK_TYPE: TaskType;
  AGENT: Agent;
  GITHUB_REPO: string;
  GITHUB_TOKEN: string;
  BASE_BRANCH: string;
  BRANCH_NAME: string;
  LINEAR_ISSUE_ID: string;
  LINEAR_ISSUE_IDENTIFIER: string;
  RUN_ID: string;
  RUN_CALLBACK_TOKEN: string;
  SUPERVISOR_URL: string;
  RESUME_MESSAGE?: string;
  PR_NUMBER?: string;
  REVIEW_ROUND?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  CODEX_AUTH_JSON?: string;
  KIMI_CODE_API_KEY?: string;
  OT_GIT_AUTHOR_NAME?: string;
  OT_GIT_AUTHOR_EMAIL?: string;
  MAX_TURNS: string;
  TASK_TIMEOUT: string;
  DEV_PORT: string;
}

export function toEnvVars(env: SandboxEnvContract): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lightweight handle. Sprites are addressed by name; `url` is the org-private preview URL. */
export interface SpriteHandle {
  name: string;
  url?: string;
  updatedAt?: string;
}

export interface SpriteInfo {
  id?: string;
  name: string;
  organization?: string;
  url?: string;
  url_settings?: { auth?: string };
  status?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ExecResult {
  exitCode: number;
  /** Best-effort combined output. Exec framing is byte-multiplexed; for exact
   *  file content use `fsRead` instead. */
  output: string;
}

export interface NetworkPolicy {
  rules: Array<{ include?: string; domain?: string; action?: "allow" | "deny" }>;
}

export class SpriteApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "SpriteApiError";
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number;
  buf: Buffer;
  text(): string;
  json(): unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class SpritesClient {
  private readonly baseURL: string;

  constructor(
    private readonly token: string,
    options: { baseURL?: string; timeoutMs?: number } = {}
  ) {
    this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private readonly timeoutMs: number;

  private async req(
    method: string,
    path: string,
    opts: {
      query?: Array<[string, string]>;
      jsonBody?: unknown;
      rawBody?: Buffer;
      timeoutMs?: number;
      retryOnError?: boolean;
    } = {}
  ): Promise<RawResponse> {
    const url = new URL(this.baseURL + path);
    for (const [k, v] of opts.query ?? []) url.searchParams.append(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    let body: Buffer | string | undefined;
    if (opts.rawBody !== undefined) {
      headers["content-type"] = "application/octet-stream";
      body = opts.rawBody;
    } else if (opts.jsonBody !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.jsonBody);
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const res = await fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
        });
        const buf = Buffer.from(await res.arrayBuffer());
        const wrapped: RawResponse = {
          status: res.status,
          buf,
          text: () => buf.toString("utf8"),
          json: () => JSON.parse(buf.toString("utf8")),
        };
        // Retry transient rate-limit / server errors, honoring Retry-After.
        if (opts.retryOnError !== false && (res.status === 429 || res.status >= 500)) {
          if (attempt < MAX_RETRIES) {
            const retryAfter = parseRetryAfter(wrapped);
            await sleep(retryAfter ?? backoffMs(attempt));
            continue;
          }
        }
        return wrapped;
      } catch (err) {
        // Network/timeout — retry with backoff.
        lastErr = err;
        if (attempt < MAX_RETRIES) {
          await sleep(backoffMs(attempt));
          continue;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`sprites request failed: ${method} ${path}`);
  }

  private throwFor(res: RawResponse, context: string): never {
    let code: string | undefined;
    let message = res.text().slice(0, 300);
    try {
      const body = res.json() as { error?: string; message?: string; retry_after_seconds?: number };
      code = body.error;
      if (body.message) message = body.message;
    } catch {
      /* non-JSON body */
    }
    throw new SpriteApiError(res.status, code, `${context}: HTTP ${res.status} ${code ?? ""} ${message}`.trim());
  }

  async createSprite(
    name: string,
    opts: { waitForCapacity?: boolean; urlAuth?: "sprite" | "public" } = {}
  ): Promise<SpriteInfo> {
    const res = await this.req("POST", "/v1/sprites", {
      jsonBody: {
        name,
        wait_for_capacity: opts.waitForCapacity ?? true,
        ...(opts.urlAuth ? { url_settings: { auth: opts.urlAuth } } : {}),
      },
    });
    // 409 = already exists → reuse (idempotent by name).
    if (res.status === 409) return { name };
    if (res.status >= 300) this.throwFor(res, `create sprite ${name}`);
    return res.json() as SpriteInfo;
  }

  async getSprite(name: string): Promise<SpriteInfo | undefined> {
    const res = await this.req("GET", `/v1/sprites/${name}`, { retryOnError: true });
    if (res.status === 404) return undefined;
    if (res.status >= 300) this.throwFor(res, `get sprite ${name}`);
    return res.json() as SpriteInfo;
  }

  async listSprites(prefix?: string): Promise<SpriteInfo[]> {
    const sprites: SpriteInfo[] = [];
    let continuationToken: string | undefined;
    do {
      const query: Array<[string, string]> = [["max_results", "50"]];
      if (prefix) query.push(["prefix", prefix]);
      if (continuationToken) query.push(["continuation_token", continuationToken]);
      const res = await this.req("GET", "/v1/sprites", { query });
      if (res.status >= 300) this.throwFor(res, "list sprites");
      const body = res.json() as {
        sprites?: SpriteInfo[];
        has_more?: boolean;
        next_continuation_token?: string | null;
      };
      sprites.push(...(body.sprites ?? []));
      continuationToken = body.has_more ? body.next_continuation_token ?? undefined : undefined;
    } while (continuationToken);
    return sprites;
  }

  async deleteSprite(name: string): Promise<void> {
    const res = await this.req("DELETE", `/v1/sprites/${name}`);
    if (res.status === 404 || res.status === 200 || res.status === 204) return;
    if (res.status >= 300) this.throwFor(res, `delete sprite ${name}`);
  }

  /** Liveness/authorization probe used by /repositories/register. */
  async ping(): Promise<void> {
    const res = await this.req("GET", "/v1/sprites", { query: [["max_results", "1"]] });
    if (res.status >= 300) this.throwFor(res, "sprites org liveness");
  }

  async fsWrite(name: string, path: string, content: Buffer, mode = "0644"): Promise<void> {
    const res = await this.req("PUT", `/v1/sprites/${name}/fs/write`, {
      query: [
        ["path", path],
        ["workingDir", "/"],
        ["mkdirParents", "true"],
        ["mode", mode],
      ],
      rawBody: content,
    });
    if (res.status >= 300) this.throwFor(res, `fs/write ${path}`);
  }

  async fsRead(name: string, path: string): Promise<string | undefined> {
    const res = await this.req("GET", `/v1/sprites/${name}/fs/read`, {
      query: [
        ["path", path],
        ["workingDir", "/"],
      ],
    });
    if (res.status === 404) return undefined;
    if (res.status >= 300) this.throwFor(res, `fs/read ${path}`);
    return res.text();
  }

  /** Run a shell command over the HTTP exec transport; returns exit code + best-effort output. */
  async exec(name: string, script: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const res = await this.req("POST", `/v1/sprites/${name}/exec`, {
      query: [
        ["cmd", "bash"],
        ["cmd", "-lc"],
        ["cmd", script],
      ],
      timeoutMs: opts.timeoutMs,
      retryOnError: false,
    });
    if (res.status >= 300) this.throwFor(res, "exec");
    return parseExecFrames(res.buf);
  }

  /** Create/update a runtime-managed service (NDJSON progress stream buffered). */
  async putService(
    name: string,
    service: string,
    def: { cmd: string; args?: string[]; needs?: string[]; httpPort?: number },
    opts: { durationSeconds?: number } = {}
  ): Promise<void> {
    const query: Array<[string, string]> = [];
    if (opts.durationSeconds !== undefined) query.push(["duration", `${opts.durationSeconds}s`]);
    const res = await this.req("PUT", `/v1/sprites/${name}/services/${service}`, {
      query,
      jsonBody: {
        cmd: def.cmd,
        args: def.args ?? [],
        needs: def.needs ?? [],
        // send both spellings — SDK types say httpPort, one example uses http_port
        ...(def.httpPort !== undefined ? { httpPort: def.httpPort, http_port: def.httpPort } : {}),
      },
    });
    if (res.status >= 300) this.throwFor(res, `put service ${service}`);
  }

  async stopService(name: string, service: string): Promise<void> {
    const res = await this.req("POST", `/v1/sprites/${name}/services/${service}/stop`);
    // 404 = no such service, 409 = not running — both fine for best-effort stop.
    if (res.status === 404 || res.status === 409 || res.status < 300) return;
    this.throwFor(res, `stop service ${service}`);
  }

  async setNetworkPolicy(name: string, policy: NetworkPolicy): Promise<void> {
    const res = await this.req("POST", `/v1/sprites/${name}/policy/network`, { jsonBody: policy });
    if (res.status >= 300) this.throwFor(res, "set network policy");
  }
}

function backoffMs(attempt: number): number {
  return Math.min(16_000, 1_000 * 2 ** attempt);
}

function parseRetryAfter(res: RawResponse): number | undefined {
  try {
    const body = res.json() as { retry_after_seconds?: number };
    if (typeof body.retry_after_seconds === "number") return body.retry_after_seconds * 1000;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Exec wire framing: `[streamID byte][payload]…` ending in a `0x03`+exit-code
 *  frame. Exit code is authoritative; output is best-effort (stream-ID bytes may
 *  interleave). Validated against a live org in spike/sprites-spike.mjs. */
export function parseExecFrames(buf: Buffer): ExecResult {
  let exitCode = 0;
  let end = buf.length;
  if (buf.length >= 2 && buf[buf.length - 2] === 0x03) {
    exitCode = buf[buf.length - 1];
    end = buf.length - 2;
  }
  // Strip a single leading stream-ID marker if present (common case).
  let start = 0;
  if (end > 0 && buf[0] <= 0x02) start = 1;
  return { exitCode, output: buf.subarray(start, end).toString("utf8") };
}

// ---------------------------------------------------------------------------
// Sprite naming — RFC-1123-label-like rules confirmed by the live spike:
// lowercase alphanumeric + hyphen, no leading/trailing hyphen, length-capped.
// ---------------------------------------------------------------------------

const MAX_SPRITE_NAME_LENGTH = 40;

export function spriteName(issueIdentifier: string): string {
  const name = `ot-${issueIdentifier}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SPRITE_NAME_LENGTH)
    .replace(/-+$/g, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new Error(`cannot derive a valid sprite name from issue identifier: ${issueIdentifier}`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Provisioning + task launch (the daytona.ts surface, name-based)
// ---------------------------------------------------------------------------

const PROVISION_TAR_PATH = "/tmp/ot-payload.tar.gz";
const RUN_ENV_PATH = "/home/agent/.ot/run.env";
const LINEAR_CONTEXT_PATH = "/home/agent/.ot/linear-context.md";
const ENTRYPOINT = "/opt/openthrottle/entrypoint.sh";
const TASK_LOG_PATH = "/home/agent/.ot/task.log";
const RUN_SERVICE = "run";
const OUTBOX_DIR = "/home/agent/.ot/outbox";

/** DNS egress allowlist applied to every ticket sprite: dev/model defaults plus
 *  the supervisor callback host so push events (and only those) can leave. */
function egressPolicy(cfg: Config): NetworkPolicy {
  const rules: NetworkPolicy["rules"] = [{ include: "defaults" }];
  try {
    const host = new URL(cfg.supervisorUrl).hostname;
    if (host) rules.push({ domain: host, action: "allow" });
  } catch {
    /* supervisorUrl is validated at config load; ignore here */
  }
  return { rules };
}

/** Upload the sandbox payload tarball and run provision.sh (idempotent). */
async function provisionSprite(client: SpritesClient, cfg: Config, name: string): Promise<void> {
  const tar = await readFile(cfg.payloadTarPath);
  await client.fsWrite(name, PROVISION_TAR_PATH, tar, "0600");
  const result = await client.exec(
    name,
    `sudo mkdir -p /opt/openthrottle && sudo tar -xzf ${PROVISION_TAR_PATH} -C / && sudo bash /opt/openthrottle/provision.sh`
  );
  if (result.exitCode !== 0) {
    throw new Error(`sprite ${name}: provisioning failed (exit ${result.exitCode}): ${result.output.slice(-500)}`);
  }
}

export async function createForTicket(
  client: SpritesClient,
  cfg: Config,
  params: { issueIdentifier: string; env: SandboxEnvContract }
): Promise<SpriteHandle> {
  const name = spriteName(params.issueIdentifier);
  const info = await client.createSprite(name, { waitForCapacity: true, urlAuth: "sprite" });
  await client.setNetworkPolicy(name, egressPolicy(cfg));
  await provisionSprite(client, cfg, name);
  return { name, url: info.url };
}

export async function findSandboxForTicket(
  client: SpritesClient,
  issueIdentifier: string
): Promise<SpriteHandle | undefined> {
  const info = await client.getSprite(spriteName(issueIdentifier));
  return info ? { name: info.name, url: info.url, updatedAt: info.updated_at } : undefined;
}

/** The run service: heartbeats a Task to hold the sprite active while the agent
 *  works, runs the entrypoint as root (the entrypoint sources+deletes the
 *  per-run env file itself, then gosu-drops to `agent`), then releases the hold
 *  and self-stops. Secrets live only in the 0600 env file, never in the service
 *  definition or process args. */
function runServiceCommand(taskTimeoutSeconds: number): string {
  return [
    "set -uo pipefail",
    // Hold the sprite active; heartbeat refreshes a 5m task every 60s.
    `sprite-env curl -X POST /v1/tasks -d '{"name":"${RUN_SERVICE}","expire":"5m"}' >/dev/null 2>&1 || true`,
    `( while true; do sprite-env curl -X PUT /v1/tasks/${RUN_SERVICE} -d '{"expire":"5m"}' >/dev/null 2>&1; sleep 60; done ) & HB=$!`,
    `sudo timeout ${taskTimeoutSeconds + 60} ${ENTRYPOINT} || true`,
    'kill "$HB" 2>/dev/null || true',
    `sprite-env curl -X DELETE /v1/tasks/${RUN_SERVICE} >/dev/null 2>&1 || true`,
    `sprite-env services stop ${RUN_SERVICE} >/dev/null 2>&1 || true`,
  ].join("; ");
}

export async function startTask(
  client: SpritesClient,
  name: string,
  params: { env: SandboxEnvContract; linearContext: string; taskTimeoutSeconds: number }
): Promise<void> {
  const envVars = toEnvVars(params.env);
  const envFile = Object.entries(envVars)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join("\n");
  await client.fsWrite(name, RUN_ENV_PATH, Buffer.from(`${envFile}\n`), "0600");
  await client.fsWrite(name, LINEAR_CONTEXT_PATH, Buffer.from(params.linearContext), "0600");
  await client.putService(name, RUN_SERVICE, {
    cmd: "bash",
    args: ["-lc", runServiceCommand(params.taskTimeoutSeconds)],
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function stopSandbox(client: SpritesClient, name: string): Promise<void> {
  await client.stopService(name, RUN_SERVICE);
}

export async function deleteSandbox(client: SpritesClient, name: string): Promise<void> {
  await client.deleteSprite(name);
}

/** Org-private sprite URL (wakes on request; D7). Preview is deferred, so this
 *  simply returns the URL an org member reaches after a Fly login. */
export async function getSignedPreviewUrl(
  client: SpritesClient,
  name: string,
  _port: number
): Promise<string> {
  const info = await client.getSprite(name);
  if (!info?.url) throw new Error(`sprite ${name} has no URL`);
  return info.url;
}

export async function getSandboxLogs(client: SpritesClient, name: string): Promise<string> {
  const log = await client.fsRead(name, TASK_LOG_PATH);
  return log ?? "";
}

export async function listLabeledSandboxes(client: SpritesClient): Promise<SpriteHandle[]> {
  const sprites = await client.listSprites("ot-");
  return sprites.map((s) => ({ name: s.name, url: s.url, updatedAt: s.updated_at }));
}

/** Drain any events the sandbox spooled to disk (push-failure fallback), read by
 *  the sweep for overdue runs. Returns raw JSON strings of outbox files. */
export async function readSpooledEvents(client: SpritesClient, name: string): Promise<string[]> {
  const listing = await client.exec(name, `cat ${OUTBOX_DIR}/*.json 2>/dev/null || true`);
  return listing.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
}
