import {
  IDENTIFIER,
  arrayAt,
  enumAt,
  fail,
  normalizedContract,
  objectAt,
  stringAt,
  unique,
  type ValidatedContract,
} from "./validation.js";

export const CONFIG_SCHEMA = "openthrottle.config/v1" as const;
export const GRAPH_SOURCE_KINDS = ["builtin", "repository"] as const;

export interface ConfigGraphSource {
  id: string;
  kind: (typeof GRAPH_SOURCE_KINDS)[number];
  ref: string;
}

export interface RepositoryConfigContract {
  schema: typeof CONFIG_SCHEMA;
  default_graph: string;
  graphs: ConfigGraphSource[];
}

const BUILTIN_GRAPH = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*@\d+$/;
const REPOSITORY_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+\.json$/;

function parseSource(value: unknown, path: string): ConfigGraphSource {
  const input = objectAt(value, path, ["id", "kind", "ref"]);
  const kind = enumAt(input.kind, `${path}.kind`, GRAPH_SOURCE_KINDS);
  const ref = stringAt(input.ref, `${path}.ref`, {
    max: 240,
    pattern: kind === "builtin" ? BUILTIN_GRAPH : REPOSITORY_PATH,
  });
  return {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    kind,
    ref,
  };
}

export function validateRepositoryConfigContract(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<RepositoryConfigContract> {
  const source = options.source ?? "config";
  const input = objectAt(value, source, ["schema", "default_graph", "graphs"]);
  if (input.schema !== CONFIG_SCHEMA) fail(`${source}.schema`, `must be ${CONFIG_SCHEMA}`);
  const config: RepositoryConfigContract = {
    schema: CONFIG_SCHEMA,
    default_graph: stringAt(input.default_graph, `${source}.default_graph`, { pattern: IDENTIFIER }),
    graphs: arrayAt(input.graphs, `${source}.graphs`, parseSource, { min: 1, max: 16 }),
  };
  unique(config.graphs.map((graph) => graph.id), `${source}.graphs`);
  if (!config.graphs.some((graph) => graph.id === config.default_graph)) {
    fail(`${source}.default_graph`, "references an unknown graph");
  }
  return normalizedContract(config);
}

export function parseRepositoryConfigContract(
  raw: string,
  options: { source?: string } = {}
): ValidatedContract<RepositoryConfigContract> {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) fail(options.source ?? "config", "JSON exceeds 64 KiB");
  return validateRepositoryConfigContract(JSON.parse(raw) as unknown, options);
}

