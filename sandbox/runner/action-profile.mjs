import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, digest } from "./kernel-json.mjs";
import {
  chmodReadOnlyPreservingExecuteTree,
  chownTree,
  isRoot,
  pathInside,
} from "./filesystem-isolation.mjs";

export const ACTION_PROFILE_SCHEMA = "openthrottle.action-profile/v1";
export const OPENCODE_PROGRESSIVE_SKILLS_CAPABILITY = "opencode/native-progressive-skills@1";
export const ACTION_TASK_PROMPT_MAX_BYTES = 512 * 1024;
export const ACTION_EXECUTOR_CONTEXT_MAX_BYTES = 8 * 1024;

const ENGINES = new Set(["claude", "codex", "opencode"]);
const REPOSITORY_AUTHORITIES = new Set(["inspect", "edit"]);
const DEFINITION_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUPPORT_PATH = /^(?:assets|references|scripts)\/(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]{1,320}$/;
const MAX_SKILL_FILES = 64;
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_PROFILE_BYTES = 2 * 1024 * 1024;
const ROOT_UID = 0;
const ROOT_GID = 0;
const LOCAL_PLATFORM_FENCE = fileURLToPath(new URL("../../skills/codex/AGENTS-fragment.md", import.meta.url));

function boundedText(value, label, max = 128 * 1024) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > max || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return value.replace(/\r\n?/g, "\n").trim();
}

function boundedFileText(value, label, max = MAX_SKILL_FILE_BYTES) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > max || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return value.replace(/\r\n?/g, "\n");
}

function boundedOptionalText(value, label, max) {
  if (value === undefined || value === null || value === "") return "";
  return boundedText(value, label, max);
}

function definitionId(value, label) {
  if (typeof value !== "string" || !DEFINITION_ID.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function skillInvocation(definitionIdValue) {
  const name = definitionIdValue.slice(definitionIdValue.lastIndexOf("/") + 1);
  if (!SKILL_NAME.test(name)) throw new Error(`skill ${definitionIdValue} has an invalid invocation name`);
  return name;
}

function uniqueDefinitionIds(values, label) {
  if (!Array.isArray(values) || values.length > 32) throw new Error(`${label} must be a bounded array`);
  const result = values.map((value, index) => definitionId(value, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
  const invocations = result.map(skillInvocation);
  if (new Set(invocations).size !== invocations.length) {
    throw new Error(`${label} contains colliding native skill names`);
  }
  return result;
}

function resolvedDefault(primary, fallback) {
  return existsSync(primary) ? primary : fallback;
}

export function configuredPlatformFencePath(env = process.env) {
  const path = env.OT_PLATFORM_FENCE_FILE ?? resolvedDefault(
    "/opt/openthrottle/skills/codex/AGENTS-fragment.md",
    LOCAL_PLATFORM_FENCE,
  );
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("platform fence path is invalid");
  return resolve(path);
}

function frontmatterName(raw) {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") throw new Error("sealed skill SKILL.md is missing frontmatter");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("sealed skill SKILL.md frontmatter is unterminated");
  for (const line of lines.slice(1, end)) {
    const match = /^name:\s*["']?([a-z0-9]+(?:-[a-z0-9]+)*)["']?\s*$/.exec(line);
    if (match) return match[1];
  }
  throw new Error("sealed skill SKILL.md frontmatter is missing name");
}

function yamlScalar(value) {
  return JSON.stringify(value);
}

function renderSkillMarkdown(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("skill payload is invalid");
  const frontmatter = payload.frontmatter;
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error("skill frontmatter payload is invalid");
  }
  const lines = ["---"];
  for (const key of ["name", "description", "license", "compatibility"]) {
    if (frontmatter[key] !== undefined) lines.push(`${key}: ${yamlScalar(frontmatter[key])}`);
  }
  if (frontmatter.metadata !== undefined) {
    lines.push("metadata:");
    for (const [key, value] of Object.entries(frontmatter.metadata).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      lines.push(`  ${yamlScalar(key)}: ${yamlScalar(value)}`);
    }
  }
  lines.push("---", "", boundedText(payload.instructions, "skill instructions", MAX_SKILL_FILE_BYTES), "");
  return lines.join("\n");
}

function materializeBundledSkill({ entry, discoveryRoot }) {
  const id = definitionId(entry.definition_id, "skill definition_id");
  const invocation = skillInvocation(id);
  if (entry.definition_kind !== "skill") throw new Error(`definition ${id} is not a skill`);
  if (digest(canonicalJson(entry.normalized_payload)) !== entry.content_hash) {
    throw new Error(`skill ${id} content hash does not match its normalized payload`);
  }
  const destinationRoot = pathInside(resolve(discoveryRoot), invocation, "skill destination escapes discovery root");
  mkdirSync(destinationRoot, { recursive: true, mode: 0o755 });
  const skillMarkdown = renderSkillMarkdown(entry.normalized_payload);
  if (frontmatterName(skillMarkdown) !== invocation) throw new Error(`skill ${id} frontmatter name does not match its native invocation`);
  writeFileSync(join(destinationRoot, "SKILL.md"), skillMarkdown, { mode: 0o444, flag: "wx" });
  const files = entry.normalized_payload.files;
  if (!Array.isArray(files) || files.length > MAX_SKILL_FILES) throw new Error(`skill ${id} files are invalid`);
  for (const [index, file] of files.entries()) {
    if (!file || typeof file !== "object" || Array.isArray(file) || !SUPPORT_PATH.test(file.path)) {
      throw new Error(`skill ${id} files[${index}] path is invalid`);
    }
    const content = boundedFileText(file.content, `skill ${id} files[${index}].content`);
    if (digest(content) !== file.content_hash) throw new Error(`skill ${id} files[${index}] content hash mismatch`);
    const destination = pathInside(destinationRoot, file.path, "skill support file escapes destination root");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    // Definition bundles intentionally omit ambient source-mode bits. Give
    // support files deterministic package semantics instead: scripts are
    // executable procedures, while references and assets stay data-only.
    writeFileSync(destination, content, {
      mode: file.path.startsWith("scripts/") ? 0o555 : 0o444,
      flag: "wx",
    });
  }
  return { id, invocation, content_hash: entry.content_hash, destination: destinationRoot };
}

export function engineSkillDiscoveryRoot(engine, profileRoot) {
  if (!ENGINES.has(engine)) throw new Error("action profile engine is invalid");
  return pathInside(resolve(profileRoot), "skills", "skill discovery root escapes profile root");
}

function entryActivation(engine, entrySkill, explicitInvocation) {
  if (!entrySkill && !explicitInvocation) return "";
  const invocation = explicitInvocation ?? skillInvocation(entrySkill);
  if (!SKILL_NAME.test(invocation)) throw new Error("entry skill invocation is invalid");
  if (engine === "claude") return `/${invocation}`;
  if (engine === "codex") return `$${invocation}`;
  return `Use the native skill tool to load \"${invocation}\" before acting.`;
}

export function composeActionProfilePrompt(profile) {
  const activation = entryActivation(profile.engine, profile.entry_skill, profile.entry_invocation);
  const catalog = profile.skills.map(({ destination: _destination, ...skill }) => skill);
  const common = [
    "## OpenThrottle platform fence",
    profile.platform_fence,
    `## Agent instructions (${profile.agent_id})`,
    profile.instructions,
    "## Available skills",
    canonicalJson(catalog),
    "Only these skill packages are discoverable. Skill references and supporting files stay lazy until a loaded skill explicitly uses them.",
    `## Repository authority: ${profile.repository_authority}`,
    profile.repository_authority === "inspect"
      ? "The executor supplied one immutable exact-subject view. Do not mutate repository content or run mutating tools."
      : "The executor supplied one isolated writable content tree. Edit only that tree; Git administration remains executor-owned.",
    "## Sealed task prompt",
    profile.task_prompt,
    profile.executor_context,
  ];
  return [activation, ...common].filter(Boolean).join("\n\n");
}

export function compileActionProfile({
  engine,
  agentId,
  repositoryAuthority,
  skillIds,
  entrySkill = null,
  taskPrompt,
  executorContext = "",
  definitionEntries,
  platformFence = readFileSync(configuredPlatformFencePath(), "utf8"),
}) {
  if (!ENGINES.has(engine)) throw new Error("action profile engine is invalid");
  const selectedAgentId = definitionId(agentId, "agentId");
  if (!REPOSITORY_AUTHORITIES.has(repositoryAuthority)) throw new Error("repositoryAuthority is invalid");
  const selectedSkillIds = uniqueDefinitionIds(skillIds, "skillIds");
  const selectedEntrySkill = entrySkill === null ? null : definitionId(entrySkill, "entrySkill");
  if (selectedEntrySkill && !selectedSkillIds.includes(selectedEntrySkill)) {
    throw new Error("entrySkill must be present in the skill allowlist");
  }
  if (!Array.isArray(definitionEntries)) throw new Error("definitionEntries must be an array");
  const agent = definitionEntries.find((entry) => entry.definition_kind === "agent" && entry.definition_id === selectedAgentId);
  if (!agent || typeof agent.normalized_payload !== "string") throw new Error(`agent ${selectedAgentId} is absent from the sealed bundle`);
  if (digest(canonicalJson(agent.normalized_payload)) !== agent.content_hash) {
    throw new Error(`agent ${selectedAgentId} content hash does not match its normalized payload`);
  }
  const skills = selectedSkillIds.map((id) => {
    const entry = definitionEntries.find((candidate) => candidate.definition_kind === "skill" && candidate.definition_id === id);
    if (!entry) throw new Error(`skill ${id} is absent from the sealed bundle`);
    return entry;
  });
  return {
    schema: ACTION_PROFILE_SCHEMA,
    engine,
    agent_id: selectedAgentId,
    repository_authority: repositoryAuthority,
    entry_skill: selectedEntrySkill,
    instructions: boundedText(agent.normalized_payload, "agent instructions"),
    platform_fence: boundedText(platformFence, "platform fence"),
    task_prompt: boundedText(taskPrompt, "task prompt", ACTION_TASK_PROMPT_MAX_BYTES),
    executor_context: boundedOptionalText(
      executorContext,
      "executor context",
      ACTION_EXECUTOR_CONTEXT_MAX_BYTES,
    ),
    skill_entries: skills,
  };
}

export function materializeActionProfile({ profile, profileRoot }) {
  if (profile?.schema !== ACTION_PROFILE_SCHEMA) throw new Error("action profile schema is unsupported");
  const discoveryRoot = engineSkillDiscoveryRoot(profile.engine, profileRoot);
  rmSync(discoveryRoot, { recursive: true, force: true });
  mkdirSync(discoveryRoot, { recursive: true, mode: 0o755 });
  const skills = profile.skill_entries.map((entry) => materializeBundledSkill({ entry, discoveryRoot }));
  if (isRoot()) chownTree(discoveryRoot, ROOT_UID, ROOT_GID);
  chmodReadOnlyPreservingExecuteTree(discoveryRoot);
  const sealed = {
    schema: ACTION_PROFILE_SCHEMA,
    engine: profile.engine,
    agent_id: profile.agent_id,
    repository_authority: profile.repository_authority,
    entry_skill: profile.entry_skill,
    skills: skills.map(({ destination: _destination, ...skill }) => skill),
    fence_nonce: randomUUID(),
  };
  const bytes = `${canonicalJson(sealed)}\n`;
  if (Buffer.byteLength(bytes, "utf8") > MAX_PROFILE_BYTES) throw new Error("action profile manifest exceeds its bound");
  const manifestPath = pathInside(resolve(profileRoot), ".ot-action-profile.json", "action profile manifest escapes profile root");
  writeFileSync(manifestPath, bytes, { mode: 0o400, flag: "wx" });
  if (isRoot()) chownSync(manifestPath, ROOT_UID, ROOT_GID);
  return {
    ...profile,
    skills,
    discoveryRoot,
    manifestPath,
    prompt: composeActionProfilePrompt({ ...profile, skills }),
  };
}

function sealedEntry(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error("action profile seal contains a symbolic link");
  if ((metadata.mode & 0o222) !== 0) throw new Error("action profile seal contains a writable entry");
  const entry = {
    path,
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode & 0o7777,
    type: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "unsupported",
  };
  if (entry.type === "unsupported") throw new Error("action profile seal contains an unsupported entry");
  if (entry.type === "file") {
    entry.bytes = metadata.size;
    entry.sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return entry;
}

function sealedTree(path, entries = []) {
  const entry = sealedEntry(path);
  entries.push(entry);
  if (entry.type === "directory") {
    for (const child of readdirSync(path).sort()) sealedTree(resolve(path, child), entries);
  }
  return entries;
}

export function captureActionProfileSeal(materialized) {
  return [
    ...sealedTree(materialized.discoveryRoot),
    sealedEntry(materialized.manifestPath),
    ...(materialized.controlFiles ?? []).map(sealedEntry),
  ];
}

export function assertActionProfileSeal(materialized, expected) {
  const actual = captureActionProfileSeal(materialized);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("agent changed the executor-sealed action profile");
  }
}
