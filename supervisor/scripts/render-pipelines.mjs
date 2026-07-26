#!/usr/bin/env node
// Regenerates docs/pipelines/*.md from supervisor/pipelines/catalog.yaml.
// Run with `npm run docs:pipelines --prefix supervisor`. It runs under tsx so
// the real TypeScript manifest parser and renderer are used directly — there is
// deliberately no second YAML reader or schema copy in this file.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CATALOG_PATH,
  DOCS_PIPELINES_DIR,
  pipelineDocPages,
} from "../src/pipeline/doc-pages.js";

mkdirSync(DOCS_PIPELINES_DIR, { recursive: true });

const pages = pipelineDocPages();
const expected = new Set(pages.map((page) => page.filename));
let changed = 0;

for (const page of pages) {
  const path = join(DOCS_PIPELINES_DIR, page.filename);
  let current = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = null;
  }
  if (current === page.content) continue;
  writeFileSync(path, page.content);
  changed += 1;
  console.log(`${current === null ? "created" : "updated"} docs/pipelines/${page.filename}`);
}

// A manifest dropped from the catalog must not leave a stale page behind.
for (const entry of readdirSync(DOCS_PIPELINES_DIR)) {
  if (!entry.endsWith(".md") || expected.has(entry)) continue;
  rmSync(join(DOCS_PIPELINES_DIR, entry));
  changed += 1;
  console.log(`removed docs/pipelines/${entry}`);
}

console.log(`${pages.length} page(s) from ${DEFAULT_CATALOG_PATH}; ${changed} file(s) changed.`);
