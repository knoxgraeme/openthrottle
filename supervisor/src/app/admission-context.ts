import { sanitizeText } from "../shared/sanitize.js";

export const ORDINARY_STAGE_TASK_CONTEXT_LIMIT = 64_000;

const PARENT_ISSUE_CONTEXT_LIMIT = 6_000;
const LINEAR_CONTEXT_SECTION_KINDS = [
  "issue",
  "primary-directive-thread",
  "parent-issue",
  "other-thread",
] as const;
const LINEAR_NESTED_ISSUE_MATERIAL_KINDS = [
  "sub-issues",
  "sub-issue",
  "issue-relations",
  "issue-ref",
] as const;
const LINEAR_CONTEXT_ELEMENT_KINDS = [
  ...LINEAR_CONTEXT_SECTION_KINDS,
  ...LINEAR_NESTED_ISSUE_MATERIAL_KINDS,
] as const;
const LINEAR_CONTEXT_SECTION_KIND_SET: ReadonlySet<string> = new Set(LINEAR_CONTEXT_SECTION_KINDS);

type ContextSectionKind = typeof LINEAR_CONTEXT_SECTION_KINDS[number];
type NestedIssueMaterialKind = typeof LINEAR_NESTED_ISSUE_MATERIAL_KINDS[number];
type LinearContextElementKind = ContextSectionKind | NestedIssueMaterialKind;

interface NestedSpan {
  kind: LinearContextElementKind;
  start: number;
  end: number;
}

interface ContextSection {
  kind: ContextSectionKind;
  text: string;
  nestedSpans: NestedSpan[];
}

interface ParsedLinearContextSections {
  sections: ContextSection[];
  error?: string;
}

export interface BoundedTaskContext {
  context: string;
  selectionContext: string;
  pruning?: {
    originalBytes: number;
    boundedBytes: number;
    droppedOtherThreads: number;
    droppedParentSections: number;
    summarizedParentSections: number;
  };
  selectionError?: string;
  ordinaryLimitError?: string;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let output = "";
  for (const char of value) {
    if (utf8Bytes(output + char) > maxBytes) break;
    output += char;
  }
  return output;
}

function invalidLinearContextShapeMessage(): string {
  return "Linear prompt context has an invalid top-level section structure. Expected either exactly one issue " +
    "for an assignment-created delegation, or exactly one issue followed by exactly one primary directive, " +
    "then an optional parent issue and comment threads. No sandbox was provisioned.";
}

function issueIdentifierMismatchMessage(): string {
  return "Linear prompt context issue identifier does not match the authenticated session issue. " +
    "No sandbox was provisioned.";
}

function isContextSectionKind(kind: LinearContextElementKind): kind is ContextSectionKind {
  return LINEAR_CONTEXT_SECTION_KIND_SET.has(kind);
}

function hasValidElementParent(
  stack: ReadonlyArray<{ kind: LinearContextElementKind }>,
  kind: LinearContextElementKind
): boolean {
  const parent = stack.at(-1)?.kind;
  if (kind === "sub-issues") {
    return parent === "issue" || parent === "parent-issue";
  }
  if (kind === "sub-issue") {
    return parent === "sub-issues" || parent === "parent-issue";
  }
  if (kind === "issue-relations") {
    return parent === "issue" || parent === "parent-issue";
  }
  if (kind === "issue-ref") {
    return parent === "issue-relations";
  }
  return parent !== "sub-issues" && parent !== "sub-issue";
}

function linearContextSections(context: string): ParsedLinearContextSections {
  const tokenPattern = new RegExp(
    `</?(${LINEAR_CONTEXT_ELEMENT_KINDS.join("|")})(?=\\s|/?>)[^>]*>`,
    "gi"
  );
  const sections: ContextSection[] = [];
  const stack: Array<{
    kind: LinearContextElementKind;
    start: number;
    nestedSpans: NestedSpan[];
  }> = [];
  for (const match of context.matchAll(tokenPattern)) {
    const raw = match[0]!;
    const kind = match[1]!.toLowerCase() as LinearContextElementKind;
    const closing = raw.startsWith("</");
    if (!closing) {
      if (!hasValidElementParent(stack, kind)) {
        return { sections, error: invalidLinearContextShapeMessage() };
      }
      if (/\/\s*>$/.test(raw)) {
        if (kind !== "issue-ref") {
          return { sections, error: invalidLinearContextShapeMessage() };
        }
        continue;
      }
      stack.push({ kind, start: match.index!, nestedSpans: [] });
      continue;
    }
    const open = stack.at(-1);
    if (!open || open.kind !== kind) {
      return { sections, error: invalidLinearContextShapeMessage() };
    }
    stack.pop();
    const end = match.index! + raw.length;
    if (stack.length === 1) {
      const root = stack[0]!;
      if (open.kind !== "sub-issue" && root.nestedSpans.some((span) => span.kind === open.kind)) {
        return { sections, error: invalidLinearContextShapeMessage() };
      }
      root.nestedSpans.push({
        kind: open.kind,
        start: open.start - root.start,
        end: end - root.start,
      });
    } else if (stack.length === 0) {
      if (!isContextSectionKind(kind)) {
        return { sections, error: invalidLinearContextShapeMessage() };
      }
      sections.push({
        kind,
        text: context.slice(open.start, end),
        nestedSpans: open.nestedSpans,
      });
    }
  }
  if (stack.length > 0) {
    return { sections, error: invalidLinearContextShapeMessage() };
  }
  return { sections };
}

function contextSectionsOf(sections: ContextSection[], kind: ContextSectionKind): ContextSection[] {
  return sections.filter((section) => section.kind === kind);
}

function hasCanonicalLinearContextShape(sections: ContextSection[]): boolean {
  if (sections.length === 1) {
    return sections[0]?.kind === "issue";
  }
  if (sections.length < 2 ||
      sections[0]?.kind !== "issue" ||
      sections[1]?.kind !== "primary-directive-thread") {
    return false;
  }
  if (contextSectionsOf(sections, "issue").length !== 1 ||
      contextSectionsOf(sections, "primary-directive-thread").length !== 1) {
    return false;
  }

  let parentCount = 0;
  let sawOtherThread = false;
  for (const section of sections.slice(2)) {
    if (section.kind === "parent-issue") {
      parentCount += 1;
      if (parentCount > 1 || sawOtherThread) return false;
      continue;
    }
    if (section.kind === "other-thread") {
      sawOtherThread = true;
      continue;
    }
    return false;
  }
  return true;
}

function issueSectionIdentifier(section: ContextSection): string | undefined {
  const match = section.text.match(
    /^<issue\b[^>]*\bidentifier\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function isGithubIssueBodyDirective(section: ContextSection): boolean {
  return section.text.startsWith(
    `<primary-directive-thread comment-id="github-issue-body">`
  );
}

function isGithubCommentsOmittedMarker(section: ContextSection): boolean {
  return /^<other-thread comment-id="github-comments-omitted" author="openthrottle" omitted-count="\d+" pagination-truncated="(?:true|false)"><comment>Older GitHub Issue comments were omitted by the deterministic context bound\.<\/comment><\/other-thread>$/.test(
    section.text
  );
}

function decodeXmlText(value: string): string {
  return value.replace(/&(amp|lt|gt);/g, (_match, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    return ">";
  });
}

function stripNestedLinearContextSections(section: ContextSection): ContextSection {
  if (section.nestedSpans.length === 0) return section;
  let text = section.text;
  for (const span of [...section.nestedSpans].reverse()) {
    text = `${text.slice(0, span.start)}${text.slice(span.end)}`;
  }
  return { ...section, text: text.trim(), nestedSpans: [] };
}

function withoutSections(context: string, sections: ContextSection[]): string {
  let output = context;
  for (const section of sections) {
    output = output.replace(section.text, "");
  }
  return output.trim();
}

function hasLinearContextStructuralDelimiter(context: string): boolean {
  return new RegExp(
    `</?(?:${LINEAR_CONTEXT_ELEMENT_KINDS.join("|")})(?=\\s|/?>)[^>]*>`,
    "i"
  ).test(context);
}

function parentIssueSummary(section: ContextSection): string {
  const title = section.text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const description = section.text.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i)?.[1]?.trim();
  const body = [
    `<parent-issue-context source="linear" status="summarized">`,
    ...(title ? [`<title>${title}</title>`] : []),
    ...(description
      ? [`<description-summary>${truncateUtf8(description, PARENT_ISSUE_CONTEXT_LIMIT)}</description-summary>`]
      : ["Parent issue details were omitted to keep the delegated task context bounded."]),
    `</parent-issue-context>`,
  ].join("\n");
  return utf8Bytes(body) <= PARENT_ISSUE_CONTEXT_LIMIT + 500
    ? body
    : truncateUtf8(body, PARENT_ISSUE_CONTEXT_LIMIT + 500);
}

export function composeBoundedTaskContext(
  rawContext: string,
  options: { requireLinearSections?: boolean; expectedIssueIdentifier?: string } = {}
): BoundedTaskContext {
  const sanitized = sanitizeText(rawContext);
  const originalBytes = utf8Bytes(sanitized);
  const parsed = linearContextSections(sanitized);
  const sections = parsed.sections;
  if (parsed.error || (sections.length > 0 && !hasCanonicalLinearContextShape(sections))) {
    return {
      context: sanitized,
      selectionContext: "",
      selectionError: parsed.error ?? invalidLinearContextShapeMessage(),
    };
  }
  const rawIssueSections = contextSectionsOf(sections, "issue");
  if (rawIssueSections.length > 0 &&
      options.expectedIssueIdentifier !== undefined &&
      issueSectionIdentifier(rawIssueSections[0]!) !== options.expectedIssueIdentifier) {
    return {
      context: sanitized,
      selectionContext: "",
      selectionError: issueIdentifierMismatchMessage(),
    };
  }
  const issueSections = rawIssueSections.map(stripNestedLinearContextSections);
  const rawDirectiveSections = contextSectionsOf(sections, "primary-directive-thread");
  const directiveSections = rawDirectiveSections.map(stripNestedLinearContextSections);
  if (issueSections.length === 0) {
    if (options.requireLinearSections) {
      return {
        context: sanitized,
        selectionContext: "",
        selectionError: invalidLinearContextShapeMessage(),
      };
    }
    return {
      context: sanitized,
      selectionContext: sanitized,
      ordinaryLimitError: originalBytes > ORDINARY_STAGE_TASK_CONTEXT_LIMIT
        ? `Task context exceeds ${ORDINARY_STAGE_TASK_CONTEXT_LIMIT} bytes for an ordinary stage pipeline, ` +
          "and OpenThrottle could not identify the child issue to preserve. " +
          "No sandbox was provisioned."
        : undefined,
    };
  }

  const parentSections = contextSectionsOf(sections, "parent-issue");
  const otherThreadSections = contextSectionsOf(sections, "other-thread");
  const parentSectionCount = parentSections.length;
  const knownSections = [
    ...rawIssueSections,
    ...rawDirectiveSections,
    ...parentSections,
    ...otherThreadSections,
  ];
  const remaining = withoutSections(sanitized, knownSections);
  if (remaining || hasLinearContextStructuralDelimiter(remaining)) {
    return {
      context: sanitized,
      selectionContext: "",
      selectionError: invalidLinearContextShapeMessage(),
    };
  }
  const parentSummaries = parentSections.map(parentIssueSummary);
  const requiredSections = [
    ...issueSections,
    ...directiveSections,
  ].map((section) => section.text);
  const decodeGithubAuthority = rawDirectiveSections.length === 1 &&
    isGithubIssueBodyDirective(rawDirectiveSections[0]!);
  const requiredOmissionSections = decodeGithubAuthority
    ? otherThreadSections.filter(isGithubCommentsOmittedMarker)
    : [];
  const optionalThreadSections = otherThreadSections.filter(
    (section) => !requiredOmissionSections.includes(section)
  );
  const selectionContext = requiredSections
    .map((section) => decodeGithubAuthority ? decodeXmlText(section) : section)
    .join("\n\n")
    .trim();
  const requiredContext = [
    ...requiredSections,
    ...requiredOmissionSections.map((section) => section.text),
  ].join("\n\n").trim();
  if (utf8Bytes(requiredContext) > ORDINARY_STAGE_TASK_CONTEXT_LIMIT) {
    return {
      context: sanitized,
      selectionContext,
      ordinaryLimitError:
        `Task context required content exceeds ${ORDINARY_STAGE_TASK_CONTEXT_LIMIT} bytes. ` +
        "Reduce the issue description or primary directive. No sandbox was provisioned.",
    };
  }

  const keptParentSummaries: string[] = [];
  let current = requiredContext;
  for (const summary of parentSummaries) {
    const candidate = [current, summary].filter(Boolean).join("\n\n");
    if (utf8Bytes(candidate) <= ORDINARY_STAGE_TASK_CONTEXT_LIMIT) {
      keptParentSummaries.push(summary);
      current = candidate;
    }
  }

  const keptOptional: ContextSection[] = [];
  for (const section of [...optionalThreadSections].reverse()) {
    const candidate = [current, section.text].filter(Boolean).join("\n\n");
    if (utf8Bytes(candidate) <= ORDINARY_STAGE_TASK_CONTEXT_LIMIT) {
      keptOptional.push(section);
      current = candidate;
    }
  }
  keptOptional.reverse();
  const context = [
    ...requiredSections,
    ...keptParentSummaries,
    ...requiredOmissionSections.map((section) => section.text),
    ...keptOptional.map((section) => section.text),
  ].join("\n\n").trim();
  const boundedBytes = utf8Bytes(context);
  const pruning = originalBytes !== boundedBytes ||
    optionalThreadSections.length !== keptOptional.length ||
    parentSectionCount > 0
    ? {
      originalBytes,
      boundedBytes,
      droppedOtherThreads: optionalThreadSections.length - keptOptional.length,
      droppedParentSections: parentSectionCount,
      summarizedParentSections: keptParentSummaries.length,
    }
    : undefined;

  return {
    context,
    selectionContext,
    pruning,
  };
}
