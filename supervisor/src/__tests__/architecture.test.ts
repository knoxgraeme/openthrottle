import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));

interface SourceModule {
  file: string;
  source: string;
}

interface ImportEdge {
  specifier: string;
  resolved?: string;
}

const boundaryImports: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["root", new Set(["app", "http", "operations", "persistence", "pipeline", "providers", "runtime", "shared"])],
  ["app", new Set(["app", "persistence", "pipeline", "runtime", "shared"])],
  ["http", new Set(["app", "http", "persistence", "shared"])],
  ["operations", new Set(["app", "operations", "persistence", "pipeline", "runtime", "shared"])],
  ["persistence", new Set(["persistence", "pipeline", "shared"])],
  ["pipeline", new Set(["pipeline", "runtime"])],
  ["providers", new Set(["app", "persistence", "pipeline", "providers", "runtime", "shared"])],
  ["runtime", new Set(["pipeline", "runtime"])],
  ["shared", new Set(["shared"])],
]);

const activePipelineRootModules = new Set([
  "pipeline/checkpoint-object.ts",
  "pipeline/definition-compilation.ts",
]);

const activePersistenceStores = new Set([
  "persistence/blob-store.ts",
  "persistence/kernel-analysis-store.ts",
  "persistence/kernel-codex-auth-store.ts",
  "persistence/kernel-inbox-store.ts",
  "persistence/kernel-projection-store.ts",
  "persistence/kernel-registration-store.ts",
  "persistence/kernel-runtime-context-store.ts",
  "persistence/kernel-store.ts",
]);

function relativeSource(file: string): string {
  return path.relative(sourceRoot, file).replaceAll(path.sep, "/");
}

function isTestSupport(file: string): boolean {
  const rel = relativeSource(file);
  return rel.split("/").some((part) => part === "__fixtures__" || part === "__tests__")
    || rel.endsWith(".test.ts");
}

function productionSources(): SourceModule[] {
  const modules: SourceModule[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__fixtures__" && entry.name !== "__tests__") visit(file);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        modules.push({ file, source: readFileSync(file, "utf8") });
      }
    }
  };
  visit(sourceRoot);
  return modules.sort((left, right) => relativeSource(left.file).localeCompare(relativeSource(right.file)));
}

function boundaryFor(file: string): string {
  const rel = relativeSource(file);
  const first = rel.split("/", 1)[0]!;
  return rel.includes("/") && boundaryImports.has(first) && first !== "root" ? first : "root";
}

function providerArea(file: string): string | undefined {
  const parts = relativeSource(file).split("/");
  return parts[0] === "providers" ? parts[1] : undefined;
}

function sourceTarget(from: string, specifier: string): string {
  const emittedTarget = path.resolve(path.dirname(from), specifier);
  if (specifier.endsWith(".js")) return `${emittedTarget.slice(0, -3)}.ts`;
  if (specifier.endsWith(".ts")) return emittedTarget;
  return `${emittedTarget}.ts`;
}

function collectImports(module: SourceModule, knownFiles: ReadonlySet<string>): ImportEdge[] {
  const sourceFile = ts.createSourceFile(module.file, module.source, ts.ScriptTarget.Latest, true);
  const imports: ImportEdge[] = [];
  const add = (specifier: string) => {
    const target = specifier.startsWith(".") ? sourceTarget(module.file, specifier) : undefined;
    imports.push({
      specifier,
      resolved: target && knownFiles.has(path.resolve(target)) ? path.resolve(target) : undefined,
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0]
      && ts.isStringLiteral(node.arguments[0])
    ) {
      add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function vocabularyWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function retiredVocabulary(module: SourceModule): ReadonlySet<string> {
  const sourceFile = ts.createSourceFile(module.file, module.source, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const inspect = (value: string) => {
    const words = vocabularyWords(value);
    // A dependency graph is an implementation-level data shape, not the
    // retired user-facing graph orchestration concept.
    if (words.some((word) => word === "graph" || word === "graphs") && !words.includes("dependency")) {
      found.add("graph");
    }
    if (words.some((word) => word === "receipt" || word === "receipts")) found.add("receipt");
  };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      inspect(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function cleanCutPathViolation(rel: string): string | undefined {
  if (rel.split("/").includes("graphs")) return "retired graphs directory returned";
  if (rel.includes("receipt")) return "retired receipt module returned";
  if (rel.startsWith("persistence/migrations/")) return "retired in-place migration directory returned";
  if (rel.startsWith("persistence/pipeline/")) return "retired persistence/pipeline store tree returned";
  if (
    rel.startsWith("pipeline/")
    && !rel.startsWith("pipeline/kernel/")
    && !activePipelineRootModules.has(rel)
  ) {
    return "retired top-level pipeline module returned";
  }
  if (/^persistence\/[^/]+-store\.ts$/.test(rel) && !activePersistenceStores.has(rel)) {
    return "retired root persistence store returned";
  }
  return undefined;
}

function findArchitectureViolations(modules: readonly SourceModule[]): string[] {
  const knownFiles = new Set(modules.map((module) => path.resolve(module.file)));
  const violations: string[] = [];

  for (const module of modules) {
    if (isTestSupport(module.file)) continue;
    const rel = relativeSource(module.file);
    const boundary = boundaryFor(module.file);

    if (boundary === "root" && rel !== "index.ts") {
      violations.push(`${rel}: only src/index.ts may be a top-level production file`);
    }
    const retiredPath = cleanCutPathViolation(rel);
    if (retiredPath) violations.push(`${rel}: ${retiredPath}`);
    for (const word of retiredVocabulary(module)) {
      violations.push(`${rel}: retired ${word} vocabulary returned to production code`);
    }

    for (const edge of collectImports(module, knownFiles)) {
      const { specifier } = edge;
      if (specifier.startsWith(".")) {
        if (!specifier.endsWith(".js")) {
          violations.push(`${rel}: relative import ${specifier} must use the emitted .js specifier`);
        }
        const target = sourceTarget(module.file, specifier);
        if (isTestSupport(target)) {
          violations.push(`${rel}: production module imports test support ${relativeSource(target)}`);
          continue;
        }
        if (!edge.resolved) {
          violations.push(`${rel}: relative import ${specifier} does not resolve to a production source module`);
          continue;
        }
        const targetRel = relativeSource(edge.resolved);
        const targetBoundary = boundaryFor(edge.resolved);
        if (!(boundaryImports.get(boundary)?.has(targetBoundary) ?? false)) {
          violations.push(`${rel}: ${boundary} may not import ${targetBoundary} module ${targetRel}`);
        }
        const sourceProvider = providerArea(module.file);
        const targetProvider = providerArea(edge.resolved);
        if (sourceProvider && targetProvider && sourceProvider !== targetProvider) {
          violations.push(`${rel}: provider ${sourceProvider} may not import provider ${targetProvider} module ${targetRel}`);
        }
        continue;
      }

      if ((specifier === "hono" || specifier.startsWith("hono/") || specifier.startsWith("@hono/")) && boundary !== "http") {
        violations.push(`${rel}: ${specifier} is confined to http`);
      }
      if ((specifier === "@daytona/sdk" || specifier.startsWith("@daytona/sdk/")) && !rel.startsWith("providers/daytona/")) {
        violations.push(`${rel}: @daytona/sdk is confined to providers/daytona`);
      }
      if (specifier === "better-sqlite3" && boundary !== "persistence") {
        violations.push(`${rel}: better-sqlite3 is confined to persistence`);
      }
    }
  }
  return violations;
}

describe("supervisor source architecture", () => {
  it("keeps the clean execution kernel inside its owning boundaries", () => {
    expect(findArchitectureViolations(productionSources())).toEqual([]);
  });

  it("rejects representative boundary and clean-cut regressions", () => {
    const fixtures: SourceModule[] = [
      { file: path.join(sourceRoot, "db.ts"), source: "export {};" },
      { file: path.join(sourceRoot, "app", "bad-extension.ts"), source: "import '../pipeline/kernel/store';" },
      { file: path.join(sourceRoot, "app", "missing.ts"), source: "import './absent.js';" },
      { file: path.join(sourceRoot, "app", "bad-http.ts"), source: "import '../http/server.js';" },
      { file: path.join(sourceRoot, "shared", "bad-domain.ts"), source: "import '../pipeline/kernel/store.js';" },
      { file: path.join(sourceRoot, "runtime", "bad-sdk.ts"), source: "import '@daytona/sdk';" },
      { file: path.join(sourceRoot, "app", "bad-sqlite.ts"), source: "import 'better-sqlite3';" },
      { file: path.join(sourceRoot, "app", "bad-hono.ts"), source: "import 'hono';" },
      { file: path.join(sourceRoot, "providers", "codex", "bad-sibling.ts"), source: "import '../github/client.js';" },
      { file: path.join(sourceRoot, "__fixtures__", "helper.ts"), source: "export const helper = true;" },
      { file: path.join(sourceRoot, "app", "bad-fixture.ts"), source: "import '../__fixtures__/helper.js';" },
      { file: path.join(sourceRoot, "graphs", "compiler.ts"), source: "export {};" },
      { file: path.join(sourceRoot, "persistence", "pipeline", "run-store.ts"), source: "export {};" },
      { file: path.join(sourceRoot, "pipeline", "manifest.ts"), source: "export {};" },
      { file: path.join(sourceRoot, "persistence", "run-store.ts"), source: "export {};" },
      { file: path.join(sourceRoot, "app", "legacy-result.ts"), source: "export interface StageReceipt {}" },
    ];

    expect(findArchitectureViolations([...productionSources(), ...fixtures])).toEqual(expect.arrayContaining([
      "db.ts: only src/index.ts may be a top-level production file",
      "app/bad-extension.ts: relative import ../pipeline/kernel/store must use the emitted .js specifier",
      "app/missing.ts: relative import ./absent.js does not resolve to a production source module",
      "app/bad-http.ts: app may not import http module http/server.ts",
      "shared/bad-domain.ts: shared may not import pipeline module pipeline/kernel/store.ts",
      "runtime/bad-sdk.ts: @daytona/sdk is confined to providers/daytona",
      "app/bad-sqlite.ts: better-sqlite3 is confined to persistence",
      "app/bad-hono.ts: hono is confined to http",
      "providers/codex/bad-sibling.ts: provider codex may not import provider github module providers/github/client.ts",
      "app/bad-fixture.ts: production module imports test support __fixtures__/helper.ts",
      "graphs/compiler.ts: retired graphs directory returned",
      "persistence/pipeline/run-store.ts: retired persistence/pipeline store tree returned",
      "pipeline/manifest.ts: retired top-level pipeline module returned",
      "persistence/run-store.ts: retired root persistence store returned",
      "app/legacy-result.ts: retired receipt vocabulary returned to production code",
    ]));
  });
});
