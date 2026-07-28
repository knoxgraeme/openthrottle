import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(cliRoot, "..");

execFileSync("npm", ["run", "build", "--prefix", join(repoRoot, "contracts")], {
  stdio: "inherit",
});
rmSync(join(cliRoot, "node_modules", "@openthrottle", "contracts"), {
  recursive: true,
  force: true,
});
execFileSync("npm", ["install", "--install-links", "--no-save", "--ignore-scripts", "../contracts"], {
  cwd: cliRoot,
  stdio: "inherit",
});
