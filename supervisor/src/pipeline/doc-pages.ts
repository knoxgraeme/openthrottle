import { fileURLToPath } from "node:url";
import { loadPipelineCatalog } from "./manifest.js";
import { pipelineDocFilename, renderPipelineDocPage } from "./render.js";

/** The shipped catalog, resolved the same way `manifest.test.ts` resolves it. */
export const DEFAULT_CATALOG_PATH = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));

/** Repo-root `docs/pipelines`, the only docs subtree this generator owns. */
export const DOCS_PIPELINES_DIR = fileURLToPath(new URL("../../../docs/pipelines", import.meta.url));

export interface PipelineDocPage {
  filename: string;
  content: string;
}

/**
 * Loads every manifest listed in the catalog through the real parse/validate
 * path and renders its documentation page. Shared by
 * `scripts/render-pipelines.mjs` and the drift guard test so the two cannot
 * disagree about what "generated" means.
 */
export function pipelineDocPages(catalogPath: string = DEFAULT_CATALOG_PATH): PipelineDocPage[] {
  const catalog = loadPipelineCatalog(catalogPath);
  return [...catalog.manifests.values()].map(({ manifest }) => ({
    filename: pipelineDocFilename(manifest),
    content: renderPipelineDocPage(manifest),
  }));
}
