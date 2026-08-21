import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, digest } from "./kernel-json.mjs";
import { prepareAgentRuntime, prepareResultCorrectionRuntime } from "./agent-runtime.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function correctionRequest(engine) {
  return {
    engine,
    model: engine === "opencode" ? "kimi-code/kimi-for-coding" : null,
    reasoning_effort: null,
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    request_hash: "a".repeat(64),
    definition_bundle_hash: "b".repeat(64),
    lease_id: "correction-lease-1",
    native_session_id: "native-1",
  };
}

function channel(root) {
  const value = {
    schema: "openthrottle.result-submission-channel/v1",
    schema_path: join(root, "semantic-schema.json"),
    provider_schema_path: join(root, "provider-schema.json"),
    candidate_path: join(root, "candidate.json"),
    rejection_path: join(root, "rejected.json"),
  };
  writeFileSync(value.provider_schema_path, "{}\n");
  return value;
}

function inspectRequest(engine, actionDirectory, artifactPath) {
  const instructions = "Review the exact accepted change.";
  return {
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    request_hash: "a".repeat(64),
    definition_bundle_hash: "b".repeat(64),
    lease_id: "work-lease-1",
    task_prompt: "Review this change.",
    repository_authority: "inspect",
    repository_path: join(actionDirectory, "repository"),
    change_boundary: {
      checkpoint_id: "checkpoint-1",
      input_subject: "c".repeat(40),
      output_subject: "d".repeat(40),
    },
    inspect_change_artifact: {
      schema: "openthrottle.inspect-change-context/v1",
      path: artifactPath,
      bytes: Buffer.byteLength("{}\n", "utf8"),
      sha256: digest("{}\n"),
    },
    action: {
      engine,
      model: engine === "opencode" ? "kimi-code/kimi-for-coding" : null,
      reasoning_effort: null,
      agent_id: "core/reviewer",
      skill_ids: [],
      entry_skill: null,
      definition_entries: [{
        definition_kind: "agent",
        definition_id: "core/reviewer",
        normalized_payload: instructions,
        content_hash: digest(canonicalJson(instructions)),
      }],
    },
  };
}

describe("result correction runtime", () => {
  it.each(["claude", "codex"])(
    "retains a sealed steering hook and exact correction bindings for %s",
    (engine) => {
      const actionDirectory = mkdtempSync(join(tmpdir(), "ot-correction-runtime-"));
      directories.push(actionDirectory);
      const profileRoot = join(actionDirectory, `.${engine}`);
      const prepared = prepareResultCorrectionRuntime({
        request: correctionRequest(engine),
        actionDirectory,
        channel: channel(actionDirectory),
        profileRoot,
        home: join(actionDirectory, "home"),
        cwd: join(actionDirectory, "repository"),
        env: { PATH: process.env.PATH },
      });

      expect(prepared.childEnv).toMatchObject({
        OT_PIPELINE_RUN_ID: "run-1",
        OT_ATTEMPT_ID: "attempt-1",
        OT_REQUEST_HASH: "a".repeat(64),
        OT_DEFINITION_BUNDLE_HASH: "b".repeat(64),
        OT_LEASE_ID: "correction-lease-1",
        OT_SESSION_FENCE_FILE: join(actionDirectory, "session-fence.json"),
      });
      expect(prepared.hookPath).toBe(join(
        profileRoot,
        engine === "claude" ? "settings.json" : "hooks.json",
      ));
      expect(readFileSync(prepared.hookPath, "utf8")).toContain("ot-inbox-drain.sh");
      expect(statSync(prepared.hookPath).mode & 0o777).toBe(0o444);
    },
  );

  it("keeps Claude correction result-only even when the steering hook is present", () => {
    const actionDirectory = mkdtempSync(join(tmpdir(), "ot-correction-authority-"));
    directories.push(actionDirectory);
    const prepared = prepareResultCorrectionRuntime({
      request: correctionRequest("claude"),
      actionDirectory,
      channel: channel(actionDirectory),
      profileRoot: join(actionDirectory, ".claude"),
      home: join(actionDirectory, "home"),
      cwd: join(actionDirectory, "repository"),
      env: { PATH: process.env.PATH },
    });

    expect(prepared.args).toEqual(expect.arrayContaining([
      "--permission-mode", "dontAsk",
      "--tools", "Bash",
      "--allowedTools", "Bash(ot-result:*)",
      "--disallowedTools", "Read,Edit,Write,Grep,Glob,WebFetch,WebSearch,Task,mcp__*",
      "--strict-mcp-config",
    ]));
  });
});

describe("inspect change context runtime", () => {
  it("names the same bounded artifact in every engine prompt without widening authority", () => {
    const preparedByEngine = new Map();
    const contextRoot = mkdtempSync(join(tmpdir(), "ot-inspect-runtime-context-"));
    directories.push(contextRoot);
    const artifactPath = join(contextRoot, "inspect-context", "change.json");
    mkdirSync(join(contextRoot, "inspect-context"));
    writeFileSync(artifactPath, "{}\n", { mode: 0o444 });
    for (const engine of ["claude", "codex", "opencode"]) {
      const actionDirectory = mkdtempSync(join(tmpdir(), `ot-inspect-runtime-${engine}-`));
      directories.push(actionDirectory);
      const prepared = prepareAgentRuntime({
        request: inspectRequest(engine, actionDirectory, artifactPath),
        actionDirectory,
        channel: channel(actionDirectory),
        env: { PATH: process.env.PATH },
      });
      expect(prepared.prompt).toContain(`Read the bounded, read-only change artifact at ${artifactPath}.`);
      expect(prepared.prompt).toContain("do not expand repository, tool, network, provider, or MCP authority");
      preparedByEngine.set(engine, { prepared, artifactPath, actionDirectory });
    }
    expect(new Set([...preparedByEngine.values()].map(({ artifactPath: path }) => path))).toEqual(
      new Set([artifactPath]),
    );

    const claude = preparedByEngine.get("claude");
    expect(claude.prepared.args.join("\n")).toContain(`Read(//${claude.artifactPath.slice(1)})`);
    expect(preparedByEngine.get("codex").prepared.args).toEqual(expect.arrayContaining([
      "--sandbox", "read-only", "--ignore-user-config",
    ]));
    const opencode = preparedByEngine.get("opencode");
    const config = JSON.parse(readFileSync(
      join(opencode.actionDirectory, "opencode-config", "opencode.json"),
      "utf8",
    ));
    expect(config.permission).toMatchObject({
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      task: "deny",
      external_directory: { "*": "deny", [opencode.artifactPath]: "allow" },
    });
  });
});
