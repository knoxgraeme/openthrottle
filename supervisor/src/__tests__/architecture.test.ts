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

interface ResolvedModule {
  module: SourceModule;
  edges: ImportEdge[];
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

// OPE-112 read-contract, promoted from SPEC prose to an assertion here:
// run_outcomes and the receipt tables are evidence for improvement
// proposals, never a decision input (see docs/SPEC.md "Analysis
// read-contract", generalizing the pre-existing orchestration_journal
// doctrine). No gate, transition, scheduler, or effect-drain module may
// import or query the read-only analysis surface. Most of these already sit
// in the "pipeline" boundary, which allowedEdges already confines to
// pipeline/shared -- this list is deliberately explicit (and includes those
// too) so the doctrine reads as one rule instead of depending on nobody ever
// loosening the coarser boundary map, and so it also reaches the persistence
// and operations modules the coarse map does not block from one another.
const analysisSurfaceModules = new Set([
  "persistence/pipeline/analysis-store.ts",
]);

// OPE-177 cut steering over to steering_items as its sole owner. The former
// WorkStore remains only as legacy history exercised by its own migration
// tests; no production module may resume advancing that retired state machine.
const legacyHistoryModules = new Set([
  "persistence/work-store.ts",
]);

// Named entry points only -- everything each one pulls in transitively
// (walked below by decisionSurfaceClosure) is covered automatically, so this
// list only needs a new entry when a genuinely new gate/transition/
// scheduler/effect-drain entry point is added, not for every helper it comes
// to depend on.
const decisionSurfaceModules = new Set([
  // gate
  "pipeline/gates.ts",
  "pipeline/execution-gates.ts",
  "persistence/pipeline/unit-store-phase-reducer.ts",
  // transition
  "persistence/pipeline/transition-store.ts",
  "persistence/pipeline/instance-store.ts",
  // scheduler
  "pipeline/coordinator.ts",
  "pipeline/unit-coordinator.ts",
  // effect drain
  "operations/pipeline-effects.ts",
  "operations/unit-effects.ts",
  "operations/structured-child-runtime.ts",
  // control/settlement call coordinatePipelineEvent/evaluateStageGate
  // directly, exactly like the scheduler/gate entries above -- they are
  // peer decision entry points, not derived helpers.
  "pipeline/control.ts",
  "pipeline/settlement.ts",
]);

// A prior version of this check only looked at direct import edges out of
// decisionSurfaceModules, so a helper a root module started depending on
// (operations/actor-settlement.ts, imported by operations/pipeline-effects.ts)
// could import the analysis surface with no violation raised (PR #156
// follow-up review). Walk the import graph forward from the named roots so
// any transitive dependency inherits the same restriction.
function decisionSurfaceClosure(modules: readonly ResolvedModule[]): ReadonlySet<string> {
  const importsByFile = new Map<string, Set<string>>();
  for (const { module, edges } of modules) {
    const rel = relativeSource(module.file);
    const merged = importsByFile.get(rel) ?? new Set<string>();
    for (const edge of edges) {
      // Same reasoning as typeOnlyExceptions above: an `import type` edge is
      // erased at emit and cannot execute a read at run time, so following
      // it here would only pull pure-type contract modules (pipeline/
      // store.ts, runtime/contracts.ts, ...) into the closure and turn every
      // module that shares those type shapes into a future false positive.
      // Only value edges propagate the decision-surface restriction.
      if (edge.typeOnly) continue;
      if (edge.resolved) merged.add(relativeSource(edge.resolved));
    }
    importsByFile.set(rel, merged);
  }

  const closure = new Set<string>();
  const queue = [...decisionSurfaceModules];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (closure.has(current)) continue;
    closure.add(current);
    for (const next of importsByFile.get(current) ?? []) {
      if (!closure.has(next)) queue.push(next);
    }
  }
  return closure;
}

// The import-edge rule above only catches importing analysis-store.ts by
// name; a decision-surface module living under persistence/ (e.g.
// transition-store.ts, instance-store.ts) is otherwise free to write its own
// `SELECT ... FROM run_outcomes` and read the corpus with no import at all
// (PR #156 review). Confine the table itself to its two legitimate SQL
// authors: the write path (and its own idempotency read) and the read-only
// analysis surface. Deliberately not folded into the runs/run_liveness
// check below, which exempts all of persistence/ -- this one must NOT
// exempt persistence/pipeline/{transition,instance}-store.ts.
const RUN_OUTCOMES_SQL_ALLOWLIST = new Set([
  "persistence/pipeline/run-outcome-store.ts",
  "persistence/pipeline/analysis-store.ts",
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
  // Resolve each module's imports once and share the result with the
  // decision-surface walk below, instead of re-parsing every production
  // file's AST a second time.
  const resolvedModules = modules.map((module) => ({ module, edges: collectImports(module) }));
  const decisionSurface = decisionSurfaceClosure(resolvedModules);

  const violations: string[] = [];
  for (const { module, edges } of resolvedModules) {
    const rel = relativeSource(module.file);
    const boundary = boundaryFor(module.file);
    if (boundary === "root" && rel !== "index.ts") {
      violations.push(`${rel}: only src/index.ts may be a top-level production file`);
    }
    if (deletedFlatModules.has(rel)) {
      violations.push(`${rel}: deleted flat module returned as a production facade`);
    }

    for (const edge of edges) {
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
        if (decisionSurface.has(rel) && analysisSurfaceModules.has(toRel)) {
          violations.push(`${rel}: gate/transition/scheduler/effect-drain code may not import the read-only analysis surface ${toRel}`);
        }
        if (legacyHistoryModules.has(toRel)) {
          violations.push(`${rel}: production code may not import legacy history module ${toRel}`);
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

    if (!RUN_OUTCOMES_SQL_ALLOWLIST.has(rel)) {
      for (const literal of collectStringLiterals(module)) {
        if (/\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+run_outcomes\b/i.test(literal)) {
          violations.push(`${rel}: run_outcomes SQL is confined to run-outcome-store.ts and analysis-store.ts`);
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
      { file: path.join(sourceRoot, "persistence", "bad-legacy-work.ts"), source: "import './work-store.js';" },
      { file: path.join(sourceRoot, "__fixtures__", "helper.ts"), source: "export const fixture = true;" },
      { file: path.join(sourceRoot, "app", "bad-fixture.ts"), source: "import '../__fixtures__/helper.js';" },
      // Same paths as two real decision-surface modules, with fake content:
      // the real files (scanned separately via productionSources()) don't
      // import the analysis surface and so contribute no violation of their
      // own; these fixture copies exercise the OPE-112 rule for the two
      // categories (transition, effect drain) the coarse boundary map above
      // would otherwise silently allow, since persistence->persistence and
      // operations->persistence edges are both already permitted.
      {
        file: path.join(sourceRoot, "persistence", "pipeline", "transition-store.ts"),
        source: "import './analysis-store.js';",
      },
      {
        file: path.join(sourceRoot, "operations", "pipeline-effects.ts"),
        source: "import '../persistence/pipeline/analysis-store.js';",
      },
      // A decision-surface module reading run_outcomes with its own SQL,
      // no import required -- the gap the review named directly.
      {
        file: path.join(sourceRoot, "persistence", "pipeline", "instance-store.ts"),
        source: "export const sql = 'SELECT * FROM run_outcomes';",
      },
      // Not itself a listed root: operations/actor-settlement.ts is only
      // reachable because operations/pipeline-effects.ts (a real root)
      // really imports it. Proves the walk is transitive, not just a check
      // against the enumerated root list itself (OPE-118).
      {
        file: path.join(sourceRoot, "operations", "actor-settlement.ts"),
        source: "import '../persistence/pipeline/analysis-store.js';",
      },
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
        "persistence/bad-legacy-work.ts: production code may not import legacy history module persistence/work-store.ts",
        "app/bad-fixture.ts: production module imports test fixture __fixtures__/helper.ts",
        "persistence/pipeline/transition-store.ts: gate/transition/scheduler/effect-drain code may not import the read-only analysis surface persistence/pipeline/analysis-store.ts",
        "operations/pipeline-effects.ts: gate/transition/scheduler/effect-drain code may not import the read-only analysis surface persistence/pipeline/analysis-store.ts",
        "persistence/pipeline/instance-store.ts: run_outcomes SQL is confined to run-outcome-store.ts and analysis-store.ts",
        "operations/actor-settlement.ts: gate/transition/scheduler/effect-drain code may not import the read-only analysis surface persistence/pipeline/analysis-store.ts",
      ])
    );
  });
});
