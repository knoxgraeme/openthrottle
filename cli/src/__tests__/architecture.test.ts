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

interface SourceScan {
  imports: ImportEdge[];
  stringLiterals: string[];
}

const productionFileSet = new Set<string>();

function productionSources(): SourceModule[] {
  const modules: SourceModule[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        visit(file);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        modules.push({ file, source: readFileSync(file, "utf8") });
      }
    }
  };
  visit(sourceRoot);
  return modules.sort((left, right) => relativeSource(left.file).localeCompare(relativeSource(right.file)));
}

function relativeSource(file: string): string {
  return path.relative(sourceRoot, file).replaceAll(path.sep, "/");
}

function resolvesToSourceFile(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = specifier.endsWith(".js")
    ? [base.slice(0, -3) + ".ts"]
    : [base + ".ts", path.join(base, "index.ts")];
  return candidates.find((candidate) => productionFileSet.has(path.resolve(candidate)));
}

function scanSource(module: SourceModule): SourceScan {
  const sourceFile = ts.createSourceFile(module.file, module.source, ts.ScriptTarget.Latest, true);
  const imports: ImportEdge[] = [];
  const stringLiterals: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        resolved: resolvesToSourceFile(module.file, node.moduleSpecifier.text),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        resolved: resolvesToSourceFile(module.file, node.moduleSpecifier.text),
      });
    } else if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      imports.push({
        specifier: node.arguments[0].text,
        resolved: resolvesToSourceFile(module.file, node.arguments[0].text),
      });
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      stringLiterals.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { imports, stringLiterals };
}

function architectureViolations(modules: SourceModule[]): string[] {
  productionFileSet.clear();
  for (const module of modules) productionFileSet.add(path.resolve(module.file));
  const violations: string[] = [];
  for (const module of modules) {
    const rel = relativeSource(module.file);
    const scan = scanSource(module);
    for (const edge of scan.imports) {
      if (edge.specifier.startsWith(".")) {
        if (!edge.specifier.endsWith(".js")) {
          violations.push(`${rel}: relative import ${edge.specifier} must use the emitted .js specifier`);
        }
        if (!edge.resolved) violations.push(`${rel}: relative import ${edge.specifier} does not resolve`);
      }
      if (
        rel.startsWith("onboarding/") &&
        !rel.startsWith("onboarding/providers/") &&
        edge.specifier === "@daytona/sdk"
      ) {
        violations.push(`${rel}: provider SDK imports are confined to adapter subtrees`);
      }
      if (
        rel.startsWith("onboarding/") &&
        !rel.startsWith("onboarding/providers/") &&
        edge.specifier === "node:child_process"
      ) {
        violations.push(`${rel}: provider commands are confined to adapter subtrees`);
      }
    }
    if (rel.startsWith("onboarding/") && !rel.startsWith("onboarding/providers/")) {
      for (const literal of scan.stringLiterals) {
        if (/\b(?:flyctl|daytona|sandbox\/Dockerfile|supervisor\/Dockerfile)\b/i.test(literal)) {
          violations.push(`${rel}: onboarding core contains provider-specific command or source path text`);
        }
      }
    }
  }
  return violations;
}

describe("CLI onboarding architecture", () => {
  it("keeps the onboarding core provider-neutral", () => {
    expect(architectureViolations(productionSources())).toEqual([]);
  });

  it("rejects representative provider coupling", () => {
    const fixtures: SourceModule[] = [
      {
        file: path.join(sourceRoot, "onboarding", "bad-sdk.ts"),
        source: "import '@daytona/sdk';",
      },
      {
        file: path.join(sourceRoot, "onboarding", "bad-command.ts"),
        source: "import { execFile } from 'node:child_process'; export const command = 'flyctl deploy';",
      },
      {
        file: path.join(sourceRoot, "onboarding", "bad-path.ts"),
        source: "export const dockerfile = 'sandbox/Dockerfile';",
      },
      {
        file: path.join(sourceRoot, "onboarding", "bad-dynamic-sdk.ts"),
        source: "export async function load() { await import('@daytona/sdk'); }",
      },
      {
        file: path.join(sourceRoot, "onboarding", "bad-require-command.ts"),
        source: "const cp = require('node:child_process');",
      },
    ];

    expect(architectureViolations([...productionSources(), ...fixtures])).toEqual(
      expect.arrayContaining([
        "onboarding/bad-sdk.ts: provider SDK imports are confined to adapter subtrees",
        "onboarding/bad-command.ts: provider commands are confined to adapter subtrees",
        "onboarding/bad-command.ts: onboarding core contains provider-specific command or source path text",
        "onboarding/bad-path.ts: onboarding core contains provider-specific command or source path text",
        "onboarding/bad-dynamic-sdk.ts: provider SDK imports are confined to adapter subtrees",
        "onboarding/bad-require-command.ts: provider commands are confined to adapter subtrees",
      ])
    );
  });

  it("allows provider SDK imports inside adapter subtrees", () => {
    const fixtures: SourceModule[] = [
      {
        file: path.join(sourceRoot, "onboarding", "providers", "daytona", "good-sdk.ts"),
        source: "import '@daytona/sdk';",
      },
    ];

    expect(architectureViolations([...productionSources(), ...fixtures])).toEqual([]);
  });
});
