import { execFileSync } from "node:child_process";

const repo = () => process.env.GITHUB_REPO!;

function gh(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();
}

export function taskTransition(
  id: string,
  oldLabel: string,
  newLabel: string,
): void {
  try {
    gh([
      "issue",
      "edit",
      id,
      "--repo",
      repo(),
      "--remove-label",
      oldLabel,
      "--add-label",
      newLabel,
    ]);
  } catch {
    // Swallow — matches bash || true behavior
  }
}

export function taskClose(id: string): void {
  try {
    gh(["issue", "close", id, "--repo", repo()]);
  } catch {
    // Swallow
  }
}

export function taskComment(id: string, body: string): void {
  try {
    gh(["issue", "comment", id, "--repo", repo(), "--body", body]);
  } catch {
    // Swallow
  }
}

export function taskView(id: string, ...extraArgs: string[]): string {
  return gh(["issue", "view", id, "--repo", repo(), ...extraArgs]);
}

export function taskReadComments(id: string, filter?: string): string {
  try {
    if (filter) {
      return gh([
        "issue",
        "view",
        id,
        "--repo",
        repo(),
        "--json",
        "comments",
        "--jq",
        `[.comments[] | select(.body | contains(${JSON.stringify(filter)}))] | last | .body`,
      ]);
    }
    return gh([
      "issue",
      "view",
      id,
      "--repo",
      repo(),
      "--json",
      "comments",
      "--jq",
      '[.comments[].body] | join("\\n\\n---\\n\\n")',
    ]);
  } catch {
    return "";
  }
}

export function prComment(prNum: string, body: string): void {
  try {
    gh(["pr", "comment", prNum, "--repo", repo(), "--body", body]);
  } catch {
    // Swallow
  }
}

export function prEdit(
  prNum: string,
  opts: { addLabel?: string; removeLabel?: string },
): boolean {
  const args = ["pr", "edit", prNum, "--repo", repo()];
  if (opts.addLabel) args.push("--add-label", opts.addLabel);
  if (opts.removeLabel) args.push("--remove-label", opts.removeLabel);
  try {
    gh(args);
    return true;
  } catch {
    return false;
  }
}

export function prView(prNum: string, ...extraArgs: string[]): string {
  return gh(["pr", "view", prNum, "--repo", repo(), ...extraArgs]);
}

export function prList(
  head: string,
  ...extraArgs: string[]
): string {
  try {
    return gh([
      "pr",
      "list",
      "--repo",
      repo(),
      "--head",
      head,
      ...extraArgs,
    ]);
  } catch {
    return "";
  }
}

export function prReview(
  prNum: string,
  action: "--approve" | "--request-changes",
  body: string,
): void {
  try {
    gh(["pr", "review", prNum, "--repo", repo(), action, "--body", body]);
  } catch {
    // Swallow
  }
}
