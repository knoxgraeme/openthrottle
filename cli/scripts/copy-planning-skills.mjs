import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../skills/planning");
const target = resolve(here, "../dist/skills/planning");
const editableTaskSource = resolve(here, "../../skills/tasks/implement-plan");
const editableTaskTarget = resolve(here, "../dist/skills/tasks/implement-plan");
const editableGraphSource = resolve(here, "../../supervisor/graphs/simple-v1.json");
const editableGraphTarget = resolve(here, "../dist/scaffolds/simple-v1.json");
const requiredEditableTaskFiles = ["SKILL.md", "agents/openai.yaml"];
const repositorySkillMaxFiles = 64;
const repositorySkillMaxBytes = 256 * 1024;

function editableTaskFiles(root) {
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("editable implement-plan source must be a real directory");
  }
  const files = [];
  let totalBytes = 0;
  const visit = (absolute, relative) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const entryAbsolute = join(absolute, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`editable implement-plan source must not contain symlinks: ${entryRelative}`);
      }
      if (entry.isDirectory()) {
        visit(entryAbsolute, entryRelative);
      } else if (entry.isFile()) {
        if (files.length >= repositorySkillMaxFiles) {
          throw new Error(`editable implement-plan source exceeds the ${repositorySkillMaxFiles} file limit`);
        }
        totalBytes += readFileSync(entryAbsolute).byteLength;
        if (totalBytes > repositorySkillMaxBytes) {
          throw new Error("editable implement-plan source exceeds the 256 KiB snapshot limit");
        }
        files.push(entryRelative);
      } else {
        throw new Error(`editable implement-plan source contains a non-regular entry: ${entryRelative}`);
      }
    }
  };
  visit(root, "");
  files.sort();
  for (const required of requiredEditableTaskFiles) {
    if (!files.includes(required)) throw new Error(`editable implement-plan source is missing ${required}`);
  }
  return files;
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
rmSync(editableTaskTarget, { recursive: true, force: true });
for (const path of editableTaskFiles(editableTaskSource)) {
  const destination = resolve(editableTaskTarget, path);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(resolve(editableTaskSource, path), destination);
}
mkdirSync(resolve(here, "../dist/scaffolds"), { recursive: true });
cpSync(editableGraphSource, editableGraphTarget);
