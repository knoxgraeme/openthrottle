export const KERNEL_CHECKPOINT_ANCESTRY_MAX_ENTRIES = 64;

export interface KernelCheckpointAncestryEntry {
  checkpoint_id: string;
  input_subject: string;
  output_subject: string;
}

export function validateKernelCheckpointAncestryChain<
  Entry extends KernelCheckpointAncestryEntry,
>(input: {
  entries: readonly Entry[];
  start_subject: string;
  end_subject: string;
  label?: string;
}): Entry[] {
  const label = input.label ?? "checkpoint ancestry";
  if (input.entries.length > KERNEL_CHECKPOINT_ANCESTRY_MAX_ENTRIES) {
    throw new Error(
      `${label} exceeds ${KERNEL_CHECKPOINT_ANCESTRY_MAX_ENTRIES} checkpoints`,
    );
  }

  const checkpointIds = new Set<string>();
  const byInput = new Map<string, Entry>();
  const outputSubjects = new Set<string>();
  for (const entry of input.entries) {
    if (checkpointIds.has(entry.checkpoint_id)) {
      throw new Error(`${label} contains a duplicate checkpoint ID`);
    }
    if (byInput.has(entry.input_subject) || outputSubjects.has(entry.output_subject)) {
      throw new Error(`${label} contains a fork`);
    }
    checkpointIds.add(entry.checkpoint_id);
    byInput.set(entry.input_subject, entry);
    outputSubjects.add(entry.output_subject);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (subject: string): void => {
    if (visiting.has(subject)) throw new Error(`${label} contains a cycle`);
    if (visited.has(subject)) return;
    visiting.add(subject);
    const next = byInput.get(subject);
    if (next) visit(next.output_subject);
    visiting.delete(subject);
    visited.add(subject);
  };
  for (const subject of byInput.keys()) visit(subject);

  const ordered: Entry[] = [];
  let cursor = input.start_subject;
  while (cursor !== input.end_subject) {
    const entry = byInput.get(cursor);
    if (!entry) throw new Error(`${label} contains a gap`);
    ordered.push(entry);
    cursor = entry.output_subject;
  }
  if (ordered.length !== input.entries.length) {
    throw new Error(`${label} contains disconnected extra checkpoints`);
  }
  return ordered;
}
