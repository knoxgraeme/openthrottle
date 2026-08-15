// `openthrottle setup` — guided one-time platform onboarding.
//
// Wires the provider-neutral onboarding orchestrator (cli/src/onboarding/) to
// the concrete Fly hosting and Daytona runtime adapters registered in
// cli/src/onboarding/providers/. This module lives OUTSIDE cli/src/onboarding/,
// so provider-specific names and commands may appear freely here; the
// onboarding core stays provider-neutral.
//
// Secret VALUES never appear in output. The command prints secret names, the
// local store path, and `fly secrets set NAME="<value>"` templates only.

import * as p from "@clack/prompts";
import type {
  AdapterContext,
  ProfileSecretStore,
  ProviderEvidence,
  ProviderPlan,
  ReleaseManifest,
} from "./onboarding/contracts.js";
import { isReadyEvidence } from "./onboarding/contracts.js";
import { SetupOrchestrator } from "./onboarding/orchestrator.js";
import type { ProviderCatalogs } from "./onboarding/provider-catalog.js";
import { FileProfileStore, withResources, type ProfileStore } from "./onboarding/profile-store.js";
import {
  createDefaultCatalogs,
  DEFAULT_HOSTING_PROVIDER_ID,
  DEFAULT_RUNTIME_PROVIDER_ID,
  type DefaultCatalogDeps,
} from "./onboarding/providers/index.js";
import {
  DEFAULT_FLY_APP,
  DEFAULT_FLY_ORG,
  DEFAULT_FLY_REGION,
} from "./onboarding/providers/fly/hosting-adapter.js";
import { resolveDaytonaSnapshotName } from "./onboarding/providers/daytona/runtime-adapter.js";
import { loadReleaseManifest, type ReleaseManifestLoadResult } from "./onboarding/release-manifest.js";
import { LocalFileSecretStore } from "./onboarding/secret-store.js";
import { getErrorMessage, printTable } from "./util.js";

// Only orchestrator-generated supervisor secrets may land in the local store.
// Operator third-party credentials (GitHub PATs, the Daytona API key, Linear
// OAuth credentials) are NEVER written locally — they are set as Fly secrets
// by the operator and only their names ever appear in evidence.
export const LOCAL_SECRET_KEYS = [
  "status_token",
  "deploy_token",
  "install_secret",
  "linear_webhook_secret",
  "github_webhook_secret",
] as const;

export type ChecklistOwner = "operator" | "generated" | "derived";

export interface ChecklistEntry {
  name: string;
  owner: ChecklistOwner;
  hint: string;
}

// Single source of truth for the supervisor secret checklist. Mirrors the env
// authority in supervisor/src/app/config.ts. PORT and DATABASE_PATH are
// deliberately absent: the deploy's fly.toml [env] owns them and they must not
// be set as Fly secrets.
export const SUPERVISOR_SECRET_CHECKLIST: readonly ChecklistEntry[] = [
  {
    name: "SUPERVISOR_URL",
    owner: "derived",
    hint: "public HTTPS base URL; derivable — `openthrottle setup` derives it from the hosting app name",
  },
  { name: "OT_STATUS_TOKEN", owner: "generated", hint: "random operator bearer token" },
  {
    name: "OT_DEPLOY_TOKEN",
    owner: "generated",
    hint: "random deploy bearer token; must differ from the status token and install secret",
  },
  { name: "OT_INSTALL_SECRET", owner: "generated", hint: "random bearer token for /oauth/install" },
  { name: "LINEAR_WEBHOOK_SECRET", owner: "generated", hint: "Linear webhook signing secret" },
  { name: "LINEAR_CLIENT_ID", owner: "operator", hint: "Linear OAuth agent app (optional until Linear control is used)" },
  { name: "LINEAR_CLIENT_SECRET", owner: "operator", hint: "Linear OAuth agent app (optional until Linear control is used)" },
  { name: "GITHUB_WEBHOOK_SECRET", owner: "generated", hint: "shared GitHub webhook signing secret" },
  { name: "GITHUB_TOKEN", owner: "operator", hint: "fine-grained PAT with target-repository access" },
  { name: "GITHUB_READ_TOKEN", owner: "operator", hint: "fine-grained PAT with contents/PRs/checks/actions read only" },
  { name: "DAYTONA_API_KEY", owner: "operator", hint: "Daytona API key" },
  {
    name: "DAYTONA_SNAPSHOT",
    owner: "derived",
    hint: "derivable — `openthrottle setup` pins the release snapshot name; default: openthrottle",
  },
  { name: "DEFAULT_AGENT", owner: "operator", hint: "codex, claude, or opencode; default: codex" },
  { name: "CLAUDE_CODE_OAUTH_TOKEN", owner: "operator", hint: "Claude subscription setup token" },
  { name: "CODEX_AUTH_JSON", owner: "operator", hint: "raw ~/.codex/auth.json for Codex subscription login" },
  {
    name: "KIMI_CODE_API_KEY",
    owner: "operator",
    hint: "Kimi Code Console subscription API key for OpenCode, not Kimi Open Platform billing",
  },
  { name: "TASK_TIMEOUT", owner: "operator", hint: "ordinary-stage seconds; default: 7200; max: 86400" },
  { name: "SANDBOX_EVENT_POLL_INTERVAL_MS", owner: "operator", hint: "default: 5000" },
  { name: "ORPHAN_GRACE_MINUTES", owner: "operator", hint: "default: 5" },
  { name: "WEBHOOK_MAX_AGE_SECONDS", owner: "operator", hint: "default: 60" },
  { name: "ALLOW_LINEAR_MERGE", owner: "operator", hint: "default: false" },
];

const OWNER_ANNOTATION: Record<ChecklistOwner, string> = {
  operator: "operator-owned",
  generated: "generatable by `openthrottle setup`",
  derived: "derivable by `openthrottle setup`",
};

export function checklistLine(entry: ChecklistEntry): string {
  return `  fly secrets set ${entry.name}="<value>"   # [${OWNER_ANNOTATION[entry.owner]}] ${entry.hint}`;
}

export function renderLegacyChecklist(): string[] {
  return [
    "One-time Fly supervisor secrets. The database path and port are owned by the",
    "deploy's fly.toml [env] and are deliberately not listed here.",
    "",
    ...SUPERVISOR_SECRET_CHECKLIST.map(checklistLine),
    "",
    "`openthrottle setup` (without --legacy-checklist) generates and sets the",
    "generatable entries and derives the derivable ones for you.",
  ];
}

export interface SetupArgs {
  profile: string;
  check: boolean;
  yes: boolean;
  legacyChecklist: boolean;
}

export function parseSetupArgs(argv: string[]): SetupArgs {
  const args: SetupArgs = { profile: "default", check: false, yes: false, legacyChecklist: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    switch (flag) {
      case "--profile": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) throw new Error("--profile requires a profile name");
        args.profile = value;
        index += 1;
        break;
      }
      case "--check":
        args.check = true;
        break;
      case "--yes":
        args.yes = true;
        break;
      case "--legacy-checklist":
        args.legacyChecklist = true;
        break;
      default:
        throw new Error(`Unknown setup option: ${flag}`);
    }
  }
  return args;
}

/** Injectable prompt surface (same seam pattern as init's promptConfig). */
export interface SetupPromptApi {
  intro(message: string): void;
  outro(message: string): void;
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    success(message: string): void;
  };
  confirm(options: { message: string }): Promise<boolean | symbol>;
  isCancel(value: unknown): value is symbol;
}

const clackPrompts: SetupPromptApi = {
  intro: (message) => p.intro(message),
  outro: (message) => p.outro(message),
  log: {
    info: (message) => p.log.info(message),
    warn: (message) => p.log.warn(message),
    error: (message) => p.log.error(message),
    success: (message) => p.log.success(message),
  },
  confirm: (options) => p.confirm(options),
  isCancel: (value): value is symbol => p.isCancel(value),
};

/** Dependency-injection seam for tests; every field has a production default. */
export interface SetupCommandOptions {
  loadManifest?: () => ReleaseManifestLoadResult;
  profileStore?: ProfileStore;
  secretStore?: ProfileSecretStore & { pathFor(profileName: string): string };
  createCatalogs?: (deps: DefaultCatalogDeps) => ProviderCatalogs;
  env?: Record<string, string | undefined>;
  prompts?: SetupPromptApi;
  now?: () => Date;
}

function cleanEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "" ? trimmed : undefined;
}

interface HostingConfig {
  app: string;
  org: string;
  region: string;
}

// Resolution order: profile resource pin, then env override, then the
// documented Fly defaults. Pins are persisted with withResources after a
// successful run so a resumed setup finds the same external resources.
function resolveHostingConfig(
  resources: Record<string, string>,
  env: Record<string, string | undefined>
): HostingConfig {
  return {
    app: resources.fly_app ?? cleanEnv(env.OT_FLY_APP) ?? DEFAULT_FLY_APP,
    org: resources.fly_org ?? cleanEnv(env.OT_FLY_ORG) ?? DEFAULT_FLY_ORG,
    region: resources.fly_region ?? cleanEnv(env.OT_FLY_REGION) ?? DEFAULT_FLY_REGION,
  };
}

function renderEvidenceTable(evidence: Record<string, ProviderEvidence>): void {
  printTable(
    Object.entries(evidence).map(([key, entry]) => ({
      key,
      status: entry.status,
      owner: entry.owner,
      summary: entry.summary,
      resourceRef: entry.resourceRef,
    })),
    ["key", "status", "owner", "summary", "resourceRef"]
  );
}

export function renderMutationPlan(plan: { hosting: ProviderPlan; runtime: ProviderPlan }): string[] {
  const lines: string[] = ["Planned mutations:"];
  for (const [axis, axisPlan] of [
    ["runtime", plan.runtime],
    ["hosting", plan.hosting],
  ] as const) {
    if (axisPlan.mutations.length === 0) continue;
    const badges: string[] = [];
    if (axisPlan.billable) badges.push("billable");
    if (axisPlan.externallyVisible) badges.push("externally visible");
    lines.push(`${axis}${badges.length > 0 ? ` [${badges.join(", ")}]` : ""}:`);
    for (const mutation of axisPlan.mutations) lines.push(`  - ${mutation}`);
  }
  return lines;
}

// For every missing operator-owned secret surfaced by evidence, print the
// exact manual fallback line from the same checklist table the legacy
// checklist renders.
export function fallbackSecretLines(evidence: Record<string, ProviderEvidence>): string[] {
  const text = Object.values(evidence)
    .filter((entry) => entry.status !== "ready")
    .flatMap((entry) => [entry.summary, entry.recoveryAction ?? ""])
    .join("\n");
  return SUPERVISOR_SECRET_CHECKLIST.filter(
    (entry) => entry.owner === "operator" && new RegExp(`\\b${entry.name}\\b`).test(text)
  ).map(checklistLine);
}

function reportNeedsAction(
  evidence: Record<string, ProviderEvidence>,
  prompts: SetupPromptApi,
  outroMessage: string
): void {
  const actions = [
    ...new Set(
      Object.values(evidence)
        .filter((entry) => !isReadyEvidence(entry))
        .map((entry) => entry.recoveryAction ?? entry.summary)
    ),
  ];
  if (actions.length > 0) {
    prompts.log.warn(["Action needed:", ...actions.map((action) => `  - ${action}`)].join("\n"));
  }
  const fallback = fallbackSecretLines(evidence);
  if (fallback.length > 0) {
    prompts.log.info(["Missing operator-owned secrets can be set manually with:", ...fallback].join("\n"));
  }
  prompts.outro(outroMessage);
}

function pinnedSnapshotName(
  evidence: Record<string, ProviderEvidence>,
  release: ReleaseManifest
): string | undefined {
  const match = evidence.runtime?.resourceRef?.match(/^daytona:snapshot\/(.+)$/);
  if (match) return match[1];
  try {
    return resolveDaytonaSnapshotName(release);
  } catch {
    return undefined;
  }
}

export default async function setup(argv: string[] = [], options: SetupCommandOptions = {}): Promise<void> {
  const prompts = options.prompts ?? clackPrompts;
  let args: SetupArgs;
  try {
    args = parseSetupArgs(argv);
  } catch (error) {
    console.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  if (args.legacyChecklist) {
    for (const line of renderLegacyChecklist()) console.log(line);
    return;
  }

  prompts.intro("openthrottle setup");
  try {
    await runGuidedSetup(args, options, prompts);
  } catch (error) {
    prompts.log.error(getErrorMessage(error));
    prompts.outro("Setup failed. Re-run `openthrottle setup` after fixing the error above.");
    process.exitCode = 1;
  }
}

async function runGuidedSetup(
  args: SetupArgs,
  options: SetupCommandOptions,
  prompts: SetupPromptApi
): Promise<void> {
  const loaded = (options.loadManifest ?? loadReleaseManifest)();
  if (loaded.status === "unpinned") {
    prompts.outro(
      `This CLI build has no pinned release (${loaded.reason}). Install a published ` +
        "openthrottle release, or point OT_RELEASE_MANIFEST at a release-manifest.json to override."
    );
    process.exitCode = 1;
    return;
  }
  const release = loaded.manifest;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const profileStore = options.profileStore ?? new FileProfileStore();
  const secretStore = options.secretStore ?? new LocalFileSecretStore({ allowedKeys: LOCAL_SECRET_KEYS, env });

  const existingProfile = await profileStore.load(args.profile);
  const hostingProviderId = existingProfile?.providers.hosting ?? DEFAULT_HOSTING_PROVIDER_ID;
  const runtimeProviderId = existingProfile?.providers.runtime ?? DEFAULT_RUNTIME_PROVIDER_ID;
  const hostingConfig = resolveHostingConfig(existingProfile?.resources ?? {}, env);

  const catalogs = (options.createCatalogs ?? createDefaultCatalogs)({
    profileName: args.profile,
    secretStore,
    env,
    hosting: hostingConfig,
    log: (message) => prompts.log.info(message),
  });

  const context: AdapterContext = { profileName: args.profile, release, now };

  if (args.check) {
    // Read-only readiness report: preflight + inspect only, never the
    // orchestrator's plan/ensure mutate path.
    const runtime = catalogs.runtime.get(runtimeProviderId);
    const hosting = catalogs.hosting.get(hostingProviderId);
    const evidence: Record<string, ProviderEvidence> = {};
    evidence.runtimePreflight = await runtime.preflight(context);
    evidence.hostingPreflight = await hosting.preflight(context);
    const runtimeInspection = await runtime.inspect(context);
    evidence.runtime = "fragment" in runtimeInspection ? runtimeInspection.evidence : runtimeInspection;
    const hostingInspection = await hosting.inspect(context);
    evidence.hosting = "evidence" in hostingInspection ? hostingInspection.evidence : hostingInspection;
    renderEvidenceTable(evidence);
    if (Object.values(evidence).every(isReadyEvidence)) {
      prompts.outro("Everything is ready. Nothing was changed (--check is read-only).");
      return;
    }
    reportNeedsAction(evidence, prompts, "Readiness gaps found. Nothing was changed (--check is read-only).");
    process.exitCode = 1;
    return;
  }

  const orchestrator = new SetupOrchestrator({
    profileName: args.profile,
    hostingProviderId,
    runtimeProviderId,
    release,
    catalogs,
    profileStore,
    now,
    confirmMutations: async (plan) => {
      prompts.log.warn(renderMutationPlan(plan).join("\n"));
      if (args.yes) {
        prompts.log.info("--yes supplied; applying without prompting.");
        return true;
      }
      const approved = await prompts.confirm({ message: "Apply these mutations?" });
      return !prompts.isCancel(approved) && approved === true;
    },
  });

  const result = await orchestrator.run();
  renderEvidenceTable(result.evidence);

  if (result.outcome === "cancelled") {
    prompts.outro(
      "Setup cancelled; no further mutations were applied. Re-run `openthrottle setup` to continue."
    );
    return;
  }
  if (result.outcome === "needs_action") {
    reportNeedsAction(
      result.evidence,
      prompts,
      "Setup is incomplete. Resolve the actions above, then re-run `openthrottle setup`."
    );
    process.exitCode = 1;
    return;
  }

  // ready: persist the resource pins so a resumed setup finds the same
  // external resources, then hand the operator the remaining human steps.
  const snapshotName = pinnedSnapshotName(result.evidence, release);
  const pinned = withResources(
    result.profile,
    {
      fly_app: hostingConfig.app,
      fly_org: hostingConfig.org,
      fly_region: hostingConfig.region,
      ...(snapshotName ? { daytona_snapshot: snapshotName } : {}),
    },
    now()
  );
  await profileStore.save(pinned);

  const supervisorUrl = `https://${hostingConfig.app}.fly.dev`;
  prompts.log.success(`Supervisor ready at ${supervisorUrl}`);
  prompts.log.info(
    `Generated supervisor secrets (including the status token) are stored in ` +
      `${secretStore.pathFor(args.profile)}; values are never printed.`
  );
  prompts.log.info(
    [
      "Next steps:",
      "  1. Using Linear control? Create the Linear OAuth agent app, then set",
      "     LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET as Fly secrets on the app.",
      `  2. Install the Linear OAuth app via ${supervisorUrl}/oauth/install`,
      "     (authorized with the install secret from the local store above).",
      "  3. Run `openthrottle init` in each target repository to register it.",
      ...result.actions.map((action) => `  - ${action}`),
    ].join("\n")
  );
  prompts.outro("Setup complete.");
}
