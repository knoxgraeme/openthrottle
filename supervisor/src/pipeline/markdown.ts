const FENCE_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/g;

export function extractJsonBlocks(markdown: string, schema: string): string[] {
  return extractJsonBlocksAny(markdown, [schema]);
}

export function extractJsonBlocksAny(markdown: string, schemas: readonly string[]): string[] {
  const blocks: string[] = [];
  for (const match of markdown.matchAll(FENCE_PATTERN)) {
    const marker = match[1]?.trim().split(/\s+/) ?? [];
    const markerSchemas = schemas.filter((schema) => marker.includes(schema));
    if (markerSchemas.length === 0) continue;
    if (markerSchemas.length > 1) {
      throw new Error(`JSON fence declares multiple schemas: ${markerSchemas.join(", ")}`);
    }
    const json = match[2]?.trim() ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch {
      throw new Error(`${markerSchemas[0]} block must contain valid JSON`);
    }
    const payloadSchema = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { schema?: unknown }).schema
      : undefined;
    if (payloadSchema !== markerSchemas[0]) {
      throw new Error(`${markerSchemas[0]} block payload schema must be ${markerSchemas[0]}`);
    }
    blocks.push(json);
  }
  return blocks;
}
