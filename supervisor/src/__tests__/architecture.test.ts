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
  from: string;
  specifier: string;
  typeOnly: boolean;
  resolved?: string;
}

const boundaries = new Set([
  "app",
  "http",
  "operations",
  "persistence",
  "pipeline",
  "providers",
  "runtime",
  "shared",
]);

const allowedEdges = new Map<string, ReadonlySet<string>>([
  ["app", new Set(["app", "persistence", "pipeline", "shared"])],
  ["http", new Set(["app", "http", "persistence", "pipeline", "providers", "runtime", "shared"])],
  ["operations", new Set(["app", "operations", "persistence", "pipeline", "runtime", "shared"])],
  ["persistence", new Set(["persistence", "pipeline", "runtime", "shared"])],
  ["pipeline", new Set(["pipeline", "shared"])],
  ["providers", new Set(["app", "persistence", "pipeline", "providers", "runtime", "shared"])],
  ["runtime", new Set(["persistence", "pipeline", "runtime", "shared"])],
  ["shared", new Set(["shared"])],
]);

const typeOnlyExceptions = new Set([
  // The app and pipeline boundaries use runtime descriptor shapes as durable
  // contracts; concrete runtime services and adapters still flow outward.
  "app->runtime:runtime/contracts.ts",
  "pipeline->runtime:runtime/contracts.ts",
]);

const deletedFlatModules = new Set([
  "actor-settlement.ts",
  "commands.ts",
  "config.ts",
  "codex-auth.ts",
  "daytona.ts",
  "db-migrations.ts",
  "db.ts",
  "feedback-store.ts",
  "gate-evaluators.ts",
  "github-events.ts",
  "github.ts",
  "inbox.ts",
  "linear-auth.ts",
  "linear-events.ts",
  "linear-outbox.ts",
  "linear.ts",
  "logs.ts",
  "pipeline-coordinator.ts",
  "pipeline-control.ts",
  "pipeline-effects.ts",
  "pipeline-publication.ts",
  "pipeline-store.ts",
  "reaper.ts",
  "sandbox-events.ts",
  "sandbox-lifecycle.ts",
  "sandbox-runtime.ts",
  "sanitize.ts",
  "server.ts",
  "sweep.ts",
  "webhook-delivery.ts",
  "work-store.ts",
]);

function productionSources(): SourceModule[] {
  const modules: SourceModule[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__fixtures__") continue;
        visit(file);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        modules.push({ file, source: readFileSync(file, "utf8") });
      }
    }
  };
  visit(sourceRoot);
  return modules.sort((a, b) => relativeSource(a.file).localeCompare(relativeSource(b.file)));
}

function relativeSource(file: string): string {
  return path.relative(sourceRoot, file).replaceAll(path.sep, "/");
}

function boundaryFor(file: string): string {
  const [first] = relativeSource(file).split("/");
  return boundaries.has(first) ? first : "root";
}

function providerArea(file: string): string | undefined {
  const parts = relativeSource(file).split("/");
  return parts[0] === "providers" ? parts[1] : undefined;
}

function resolvesToSourceFile(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = specifier.endsWith(".js")
    ? [base.slice(0, -3) + ".ts"]
    : [base + ".ts", path.join(base, "index.ts")];
  return candidates.find((candidate) => productionFileSet.has(path.resolve(candidate)));
}

const productionFileSet = new Set<string>();

function collectImports(module: SourceModule): ImportEdge[] {
  const sourceFile = ts.createSourceFile(module.file, module.source, ts.ScriptTarget.Latest, true);
  const imports: ImportEdge[] = [];
  const push = (specifier: string, typeOnly: boolean) => {
    imports.push({
      from: module.file,
      specifier,
      typeOnly,
      resolved: resolvesToSourceFile(module.file, specifier),
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      push(node.moduleSpecifier.text, Boolean(node.importClause?.isTypeOnly));
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      push(node.moduleSpecifier.text, Boolean(node.isTypeOnly));
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      push(node.arguments[0].text, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function collectStringLiterals(module: SourceModule): string[] {
  const sourceFile = ts.createSourceFile(module.file, module.source, ts.ScriptTarget.Latest, true);
  const values: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      values.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
}

function findArchitectureViolations(modules: SourceModule[]): string[] {
  productionFileSet.clear();
  for (const module of modules) productionFileSet.add(path.resolve(module.file));

  const violations: string[] = [];
  for (const module of modules) {
    const rel = relativeSource(module.file);
    const boundary = boundaryFor(module.file);
    if (boundary === "root" && rel !== "index.ts") {
      violations.push(`${rel}: only src/index.ts may be a top-level production file`);
    }
    if (deletedFlatModules.has(rel)) {
      violations.push(`${rel}: deleted flat module returned as a production facade`);
    }

    for (const edge of collectImports(module)) {
      const specifier = edge.specifier;
      if (specifier.startsWith(".")) {
        if (!specifier.endsWith(".js")) {
          violations.push(`${rel}: relative import ${specifier} must use the emitted .js specifier`);
        }
        if (!edge.resolved) {
          violations.push(`${rel}: relative import ${specifier} does not resolve to a production source module`);
          continue;
        }
        const toRel = relativeSource(edge.resolved);
        const toBoundary = boundaryFor(edge.resolved);
        if (toRel.startsWith("__fixtures__/")) {
          violations.push(`${rel}: production module imports test fixture ${toRel}`);
        }
        if (boundary === "root" && rel === "index.ts") continue;
        const allowed = allowedEdges.get(boundary)?.has(toBoundary) ?? false;
        const exceptionKey = `${boundary}->${toBoundary}:${toRel}`;
        if (!allowed && !(edge.typeOnly && typeOnlyExceptions.has(exceptionKey))) {
          violations.push(`${rel}: ${boundary} may not import ${toBoundary} module ${toRel}`);
        }
        const fromProvider = providerArea(module.file);
        const toProvider = providerArea(edge.resolved);
        if (fromProvider && toProvider && fromProvider !== toProvider) {
          violations.push(`${rel}: provider ${fromProvider} may not import provider ${toProvider} module ${toRel}`);
        }
      } else {
        if (specifier === "@daytona/sdk" && !rel.startsWith("providers/daytona/")) {
          violations.push(`${rel}: @daytona/sdk is confined to providers/daytona`);
        }
        if (specifier === "better-sqlite3" && !rel.startsWith("persistence/")) {
          violations.push(`${rel}: better-sqlite3 is confined to persistence`);
        }
        if (specifier === "@openthrottle/contracts" && rel !== "pipeline/manifest.ts") {
          violations.push(`${rel}: @openthrottle/contracts is mediated through pipeline/manifest.ts`);
        }
        if ((specifier === "hono" || specifier === "@hono/node-server") && !rel.startsWith("http/")) {
          violations.push(`${rel}: ${specifier} is confined to http`);
        }
      }
    }

    if (!rel.startsWith("persistence/")) {
      for (const literal of collectStringLiterals(module)) {
        if (/\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:runs|run_liveness)\b/i.test(literal)) {
          violations.push(`${rel}: runs/run_liveness SQL is confined to persistence`);
        }
      }
    }
  }
  return violations;
}

describe("supervisor source architecture", () => {
  it("keeps production modules inside their owning boundaries", () => {
    expect(findArchitectureViolations(productionSources())).toEqual([]);
  });

  it("rejects representative forbidden dependencies", () => {
    const fixtures: SourceModule[] = [
      { file: path.join(sourceRoot, "db.ts"), source: "export {};" },
      { file: path.join(sourceRoot, "pipeline", "bad-provider.ts"), source: "import '../providers/github/client.js';" },
      { file: path.join(sourceRoot, "runtime", "bad-sdk.ts"), source: "import '@daytona/sdk';" },
      { file: path.join(sourceRoot, "app", "bad-http.ts"), source: "import '../http/server.js';" },
      { file: path.join(sourceRoot, "shared", "bad-domain.ts"), source: "import '../pipeline/store.js';" },
      { file: path.join(sourceRoot, "providers", "linear", "bad-sibling.ts"), source: "import '../github/client.js';" },
      { file: path.join(sourceRoot, "operations", "bad-sql.ts"), source: "export const sql = 'SELECT * FROM runs';" },
      { file: path.join(sourceRoot, "runtime", "bad-contracts.ts"), source: "import '@openthrottle/contracts';" },
      { file: path.join(sourceRoot, "__fixtures__", "helper.ts"), source: "export const fixture = true;" },
      { file: path.join(sourceRoot, "app", "bad-fixture.ts"), source: "import '../__fixtures__/helper.js';" },
    ];

    expect(findArchitectureViolations([...productionSources(), ...fixtures])).toEqual(
      expect.arrayContaining([
        "db.ts: only src/index.ts may be a top-level production file",
        "db.ts: deleted flat module returned as a production facade",
        "pipeline/bad-provider.ts: pipeline may not import providers module providers/github/client.ts",
        "runtime/bad-sdk.ts: @daytona/sdk is confined to providers/daytona",
        "app/bad-http.ts: app may not import http module http/server.ts",
        "shared/bad-domain.ts: shared may not import pipeline module pipeline/store.ts",
        "providers/linear/bad-sibling.ts: provider linear may not import provider github module providers/github/client.ts",
        "operations/bad-sql.ts: runs/run_liveness SQL is confined to persistence",
        "runtime/bad-contracts.ts: @openthrottle/contracts is mediated through pipeline/manifest.ts",
        "app/bad-fixture.ts: production module imports test fixture __fixtures__/helper.ts",
      ])
    );
  });
});
