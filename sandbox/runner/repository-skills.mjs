import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";
import { runGitAsExecutor } from "./repository-control.mjs";
import { chownTree, isRoot, pathInside as containedPath } from "./filesystem-isolation.mjs";

export const REPOSITORY_SKILL_CAPABILITY = "agent/repository-skill@1";

const DIGEST = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const INVOCATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_SKILL_REFERENCE =
  /^repo:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}#(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/;

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function string(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundedString(value, label, pattern, max) {
  if (typeof value !== "string" || value.length > max) throw new Error(`${label} is invalid`);
  return string(value, label, pattern);
}

function pathInside(root, child, label) {
  return containedPath(root, child, `${label} escapes its root`);
}

function gitBytes(repoDir, args) {
  try {
    return execFileSync("git", ["-c", `safe.directory=${repoDir}`, ...args], {
      cwd: repoDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
}

function chmodDirectories(path, directoryMode) {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  chmodSync(path, directoryMode);
  for (const entry of readdirSync(path)) chmodDirectories(resolve(path, entry), directoryMode);
}

function skillFrontmatterName(raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") throw new Error("repository skill SKILL.md is missing frontmatter");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("repository skill SKILL.md frontmatter is unterminated");
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^name:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]{0,127})["']?\s*$/);
    if (match) return match[1];
  }
  throw new Error("repository skill SKILL.md frontmatter is missing name");
}

function assertSkillFrontmatterMatchesInvocation(targetRoot, invocation) {
  const skillPath = resolve(targetRoot, "SKILL.md");
  const name = skillFrontmatterName(readFileSync(skillPath, "utf8"));
  if (!repositorySkillNameMatchesInvocation(name, invocation)) {
    throw new Error("repository skill frontmatter name does not match invocation");
  }
}

export function repositorySkillNameMatchesInvocation(name, invocation) {
  return name === invocation;
}

function gitTreeFileEntry(repoDir, commit, path) {
  const output = runGitAsExecutor(repoDir, ["ls-tree", commit, "--", path]);
  const match = output.match(/^(\d{6}) blob ([a-f0-9]{40,64})\t/);
  if (!match) throw new Error("repository skill source file is not a regular file");
  return { mode: match[1], blobSha: match[2] };
}

export function repositorySkillDiscoveryRoot(agent, env = process.env) {
  if (env.OT_REPOSITORY_SKILL_DISCOVERY_ROOT) return env.OT_REPOSITORY_SKILL_DISCOVERY_ROOT;
  if (agent === "claude") return "/home/agent/.claude/skills";
  if (agent === "codex") return "/home/agent/.codex/skills";
  return "/home/agent/.ot/stage/opencode-skills";
}

export function skillBody(raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return raw.trim();
  const end = lines.indexOf("---", 1);
  return (end === -1 ? raw : lines.slice(end + 1).join("\n")).trim();
}

// OpenCode inlines the whole prompt at render time and has no admin-scope
// skill discovery equivalent (see repositorySkillDiscoveryRoot): a SKILL.md
// pointer like "read `references/x.md`" is unresolvable once only the body
// is embedded, since OpenCode's process runs from the target repository, not
// the skill package directory. Render every references/*.md file inline so
// the pointer has something to resolve against.
export function skillReferencesText(skillDir) {
  const referencesDir = resolve(skillDir, "references");
  if (!existsSync(referencesDir)) return "";
  const names = readdirSync(referencesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  return names
    .map((name) => `\n\n## references/${name}\n\n${readFileSync(resolve(referencesDir, name), "utf8").trim()}`)
    .join("");
}

export function validateRepositorySkillPackage(value, label = "repositorySkill") {
  const input = record(value, label);
  const allowed = new Set(["schema", "reference", "invocation", "directory", "commit", "packageDigest", "files"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} has unknown field ${unknown}`);
  if (input.schema !== "openthrottle.repository-skill-package/v1") throw new Error(`${label}.schema is unsupported`);
  const files = input.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > 64) {
    throw new Error(`${label}.files must be a bounded non-empty array`);
  }
  const reference = boundedString(input.reference, `${label}.reference`, REPOSITORY_SKILL_REFERENCE, 320);
  const invocation = string(input.invocation, `${label}.invocation`, INVOCATION);
  const directory = string(input.directory, `${label}.directory`, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]{1,240}$/);
  const commit = string(input.commit, `${label}.commit`, COMMIT);
  const referenceMatch = reference.match(/^repo:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@([a-f0-9]{40})#(.+)$/);
  if (!referenceMatch || referenceMatch[1] !== commit || referenceMatch[2] !== directory) {
    throw new Error(`${label}.reference must match the sealed commit and directory`);
  }
  return {
    schema: "openthrottle.repository-skill-package/v1",
    reference,
    invocation,
    directory,
    commit,
    packageDigest: string(input.packageDigest, `${label}.packageDigest`, DIGEST),
    files: files.map((file, index) => {
      const entry = record(file, `${label}.files[${index}]`);
      const fileAllowed = new Set(["path", "blobSha", "digest"]);
      const fileUnknown = Object.keys(entry).find((key) => !fileAllowed.has(key));
      if (fileUnknown) throw new Error(`${label}.files[${index}] has unknown field ${fileUnknown}`);
      return {
        path: string(entry.path, `${label}.files[${index}].path`, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]{1,320}$/),
        blobSha: string(entry.blobSha, `${label}.files[${index}].blobSha`, /^[a-f0-9]{40,64}$/),
        digest: string(entry.digest, `${label}.files[${index}].digest`, DIGEST),
      };
    }),
  };
}

export function materializeRepositorySkillPackage({ packageInfo: rawPackageInfo, repoDir, agent, discoveryRoot = repositorySkillDiscoveryRoot(agent) }) {
  const packageInfo = validateRepositorySkillPackage(rawPackageInfo);
  const { packageDigest, ...unsignedPackage } = packageInfo;
  if (digest(canonicalJson(unsignedPackage)) !== packageDigest) throw new Error("repository skill package digest mismatch");
  const sourceRoot = pathInside(repoDir, packageInfo.directory, "repository skill source");
  const targetRoot = pathInside(resolve(discoveryRoot), packageInfo.invocation, "repository skill discovery");
  rmSync(discoveryRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true, mode: 0o755 });
  for (const file of packageInfo.files) {
    const sourcePath = pathInside(repoDir, file.path, "repository skill file");
    const sourceRelative = relative(sourceRoot, sourcePath);
    if (sourceRelative.startsWith("..") || sourceRelative === "" || sourceRelative.split(sep).includes("..")) {
      throw new Error("repository skill file is outside the sealed package");
    }
    const { mode, blobSha } = gitTreeFileEntry(repoDir, packageInfo.commit, file.path);
    if (mode !== "100644" && mode !== "100755") throw new Error("repository skill source file is not a regular file");
    if (blobSha !== file.blobSha) throw new Error("repository skill blob fence mismatch");
    const bytes = gitBytes(repoDir, ["cat-file", "-p", blobSha]);
    if (digest(bytes) !== file.digest) throw new Error("repository skill file digest mismatch");
    const destination = pathInside(targetRoot, sourceRelative, "repository skill destination");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    writeFileSync(destination, bytes, { mode: mode === "100755" ? 0o555 : 0o444 });
  }
  if (!existsSync(resolve(targetRoot, "SKILL.md"))) throw new Error("repository skill package is missing SKILL.md");
  assertSkillFrontmatterMatchesInvocation(targetRoot, packageInfo.invocation);
  if (isRoot()) chownTree(discoveryRoot, 0, 0);
  chmodDirectories(discoveryRoot, 0o555);
  return targetRoot;
}
