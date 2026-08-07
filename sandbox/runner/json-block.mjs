// Extracts and parses the JSON object that follows a marker heading in text
// such as a sealed loop prompt (see execute-loop.mjs loopPrompt()). Scans
// JSON-string-aware so a brace character inside a quoted string value (e.g.
// free-form plan/receipt text) is never mistaken for structural nesting, and
// ignores an unmatched '}' encountered before the block's own '{' opens
// instead of letting it desynchronize the depth count and return a later,
// unrelated object silently.
export function extractJsonBlock(text, marker) {
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const rest = text.slice(start + marker.length);
  let depth = 0;
  let blockStart = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < rest.length; i += 1) {
    const char = rest[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) blockStart = i;
      depth += 1;
    } else if (char === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0) return JSON.parse(rest.slice(blockStart, i + 1));
    }
  }
  throw new Error(`no balanced JSON object found after marker ${JSON.stringify(marker)}`);
}
