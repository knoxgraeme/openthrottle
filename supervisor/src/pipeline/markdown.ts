const FENCE_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/g;

export function extractJsonBlocks(markdown: string, schema: string): string[] {
  return extractJsonBlocksAny(markdown, [schema]);
}

export function extractJsonBlocksAny(markdown: string, schemas: readonly string[]): string[] {
  const blocks: string[] = [];
  for (const match of markdown.matchAll(FENCE_PATTERN)) {
    const marker = match[1]?.trim().split(/\s+/) ?? [];
    if (!schemas.some((schema) => marker.includes(schema))) continue;
    blocks.push(match[2]?.trim() ?? "");
  }
  return blocks;
}
