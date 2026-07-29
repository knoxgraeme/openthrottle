import { cpSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../skills/planning");
const target = resolve(here, "../dist/skills/planning");

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
