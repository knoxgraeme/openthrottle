import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalValue } from "../runner/capabilities.mjs";
import {
  COMMAND_DIAGNOSTIC_TAIL_MAX_BYTES,
  HARNESS_REPORT_BOUNDARIES,
  HARNESS_REPORT_CAUSES,
  HARNESS_REPORT_COMPONENTS,
  HARNESS_REPORT_CONFIDENCE,
  HARNESS_REPORT_FAILURE_CLASSES,
  HARNESS_REPORT_INVESTIGATIONS,
  HARNESS_REPORT_REPEATABILITY,
  HARNESS_REPORT_SIGNALS,
  STANDARD_RECEIPT_RESULTS,
  digest,
} from "../runner/artifacts.mjs";
import { LOOP_CREDENTIAL_ENV_NAMES } from "../runner/loop-credentials.mjs";

// The sandbox is a separate deployable with no TypeScript build step, so it
// cannot import @openthrottle/contracts at runtime. Several runner modules
// therefore carry hand-mirrored copies of contracts constants and helpers.
// Each mirror below is pinned against the contracts package itself: the built
// contracts/dist output when it exists (CI builds contracts before running
// the sandbox suite), else the contracts source text. A drifted mirror fails
// here instead of surfacing as a live cross-boundary validation mismatch.
//
// This extends the existing source-text cross-checks:
// - execute-loop.test.mjs pins LOGICAL_CREDENTIAL_SCOPES against
//   contracts/src/graph.ts LOGICAL_CREDENTIALS.
// - loop-mcp-config.test.mjs pins MCP_SERVER_NAME/MCP_ENV_NAME against
//   contracts/src/validation.ts IDENTIFIER and config.ts ENV_NAME.

function contractsPath(relative) {
  return new URL(`../../contracts/${relative}`, import.meta.url);
}

function readContractsSource(file) {
  return readFileSync(contractsPath(`src/${file}`), "utf8");
}

async function importContractsDist(file) {
  const url = contractsPath(`dist/${file}`);
  if (!existsSync(fileURLToPath(url))) return null;
  return import(url.href);
}

function readRunnerSource(file) {
  return readFileSync(new URL(`../runner/${file}`, import.meta.url), "utf8");
}

function extractRegexLiteral(source, declaration, file) {
  const match = source.match(new RegExp(`${declaration} = (\\/\\^.*\\$\\/);`));
  if (!match) throw new Error(`could not find ${declaration} in ${file}`);
  return match[1];
}

// Parses an extracted `{ type: ["a", "b"], ... }` literal of string-array
// entries without evaluating code: quote the bare keys and drop trailing
// commas, then it is JSON.
function parseStringArrayRecordLiteral(literal) {
  const json = literal
    .replace(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '"$1":')
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(json);
}

describe("contracts mirrors carried by the sandbox runner", () => {
  it("keeps capabilities.mjs canonicalValue/canonicalJson behaviorally identical to contracts canonical.ts", async () => {
    const dist = await importContractsDist("canonical.js");
    if (!dist) {
      // Same precedent as contracts/src/determinism.test.ts: behavioral
      // equivalence needs the executable contracts package.
      throw new Error("missing built artifact contracts/dist/canonical.js; run `npm run build --prefix contracts` before this fixture");
    }
    const fixture = {
      z: [3, 1, { b: null, a: "ü" }],
      a: { nested: { y: true, x: [{ k2: 2, k1: 1 }] } },
      "é": "accent",
      10: "ten",
      2: "two",
      empty: {},
      arr: [],
      s: "line\n\ttab",
      n: 12345.678,
      bool: false,
    };
    expect(canonicalJson(fixture)).toBe(dist.canonicalJson(fixture));
    expect(canonicalJson(canonicalValue(fixture))).toBe(dist.canonicalJson(fixture));
    expect(digest(canonicalJson(fixture))).toBe(dist.digestCanonicalJson(fixture));
  });

  it("keeps artifacts.mjs COMMAND_DIAGNOSTIC_TAIL_MAX_BYTES byte-identical with contracts receipts.ts", async () => {
    const dist = await importContractsDist("receipts.js");
    const contractsValue = dist
      ? dist.COMMAND_DIAGNOSTIC_TAIL_MAX_BYTES
      : Number(readContractsSource("receipts.ts").match(/export const COMMAND_DIAGNOSTIC_TAIL_MAX_BYTES = (\d+);/)[1]);
    expect(COMMAND_DIAGNOSTIC_TAIL_MAX_BYTES).toBe(contractsValue);
  });

  it("keeps artifacts.mjs STANDARD_RECEIPT_RESULTS aligned with contracts RECEIPT_RESULTS_BY_TYPE", async () => {
    const dist = await importContractsDist("receipts.js");
    let contractsResults;
    if (dist) {
      contractsResults = dist.RECEIPT_RESULTS_BY_TYPE;
    } else {
      const contractsMatch = readContractsSource("receipts.ts")
        .match(/export const RECEIPT_RESULTS_BY_TYPE = (\{[\s\S]*?\}) as const/);
      expect(contractsMatch).not.toBeNull();
      contractsResults = parseStringArrayRecordLiteral(contractsMatch[1]);
    }
    expect(JSON.parse(JSON.stringify(STANDARD_RECEIPT_RESULTS)))
      .toEqual(JSON.parse(JSON.stringify(contractsResults)));
  });

  it("keeps harness-report vocabularies aligned with the shared contract", async () => {
    const contract = await importContractsDist("harness-report.js");
    if (!contract) throw new Error("missing built artifact contracts/dist/harness-report.js");
    expect([...HARNESS_REPORT_COMPONENTS]).toEqual([...contract.HARNESS_REPORT_COMPONENTS]);
    expect([...HARNESS_REPORT_BOUNDARIES]).toEqual([...contract.HARNESS_REPORT_BOUNDARIES]);
    expect([...HARNESS_REPORT_CONFIDENCE]).toEqual([...contract.HARNESS_REPORT_CONFIDENCE]);
    expect([...HARNESS_REPORT_FAILURE_CLASSES]).toEqual([...contract.HARNESS_REPORT_FAILURE_CLASSES]);
    expect([...HARNESS_REPORT_SIGNALS]).toEqual([...contract.HARNESS_REPORT_SIGNALS]);
    expect([...HARNESS_REPORT_CAUSES]).toEqual([...contract.HARNESS_REPORT_CAUSES]);
    expect([...HARNESS_REPORT_INVESTIGATIONS]).toEqual([...contract.HARNESS_REPORT_INVESTIGATIONS]);
    expect([...HARNESS_REPORT_REPEATABILITY]).toEqual([...contract.HARNESS_REPORT_REPEATABILITY]);
  });

  it("keeps the runner NATIVE_SESSION_ID mirrors byte-identical with contracts validation.ts", () => {
    const contractsLiteral = extractRegexLiteral(
      readContractsSource("validation.ts"),
      "export const NATIVE_SESSION_ID",
      "contracts/src/validation.ts"
    );
    expect(extractRegexLiteral(readRunnerSource("artifacts.mjs"), "const NATIVE_SESSION_ID", "artifacts.mjs"))
      .toBe(contractsLiteral);
    expect(extractRegexLiteral(readRunnerSource("validate.mjs"), "export const NATIVE_SESSION_ID", "validate.mjs"))
      .toBe(contractsLiteral);
    // A native session id later becomes a filesystem path component, so the
    // package path fence must admit exactly the same shapes.
    expect(extractRegexLiteral(readRunnerSource("native-session-package.mjs"), "const PACKAGE_PATH_ID", "native-session-package.mjs"))
      .toBe(contractsLiteral);
  });

  it("keeps artifacts.mjs SKILL_REFERENCE byte-identical with contracts PRODUCER_SKILL_REFERENCE", () => {
    const contractsSource = readContractsSource("validation.ts");
    const contractsMatch = contractsSource.match(/export const PRODUCER_SKILL_REFERENCE = (\/\^.*\$\/);/);
    expect(contractsMatch).not.toBeNull();
    const sandboxMatch = readRunnerSource("artifacts.mjs").match(/const SKILL_REFERENCE = (\/\^.*\$\/);/);
    expect(sandboxMatch).not.toBeNull();
    expect(sandboxMatch[1]).toBe(contractsMatch[1]);
  });

  it("keeps loop-credentials.mjs LOOP_CREDENTIAL_ENV_NAMES aligned with the Daytona adapter's stage credential allowlist", () => {
    const adapterSource = readFileSync(
      new URL("../../supervisor/src/providers/daytona/adapter.ts", import.meta.url),
      "utf8"
    );
    const adapterMatch = adapterSource.match(/const STAGE_CREDENTIAL_ENV = new Set\(\[([^\]]+)\]\);/);
    expect(adapterMatch).not.toBeNull();
    const adapterNames = JSON.parse(`[${adapterMatch[1].trim().replace(/,\s*$/, "")}]`).sort();
    expect([...LOOP_CREDENTIAL_ENV_NAMES].sort()).toEqual(adapterNames);
  });
});
