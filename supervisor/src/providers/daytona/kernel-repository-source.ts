import type { Sandbox } from "@daytona/sdk";
import { shellQuote } from "./shell.js";

const OPENTHROTTLE_ROOT = "/var/lib/openthrottle";
const REPOSITORY_PARENT = `${OPENTHROTTLE_ROOT}/repository-source`;
export const DAYTONA_REPOSITORY_ROOT = `${REPOSITORY_PARENT}/repo`;
const REPOSITORY_STAGING = `${REPOSITORY_PARENT}/repo.part`;
const REPOSITORY_ABSENT_EXIT = 44;
const REPOSITORY_CONFLICT_EXIT = 45;
const REPOSITORY_STAGING_INVALID_EXIT = 46;

function notFound(error: unknown): boolean {
  return /not[ -]?found|404|no such file or directory/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function repositoryParentChecks(exitCode: number): string[] {
  return [
    `test -d ${shellQuote(REPOSITORY_PARENT)} && test ! -L ${shellQuote(REPOSITORY_PARENT)} || exit ${exitCode}`,
    `test "$(stat -c '%U:%G:%a' ${shellQuote(REPOSITORY_PARENT)})" = 'root:root:700' || exit ${exitCode}`,
  ];
}

function repositoryTreeChecks(path: string, exitCode: number): string[] {
  return [
    `test -d ${shellQuote(path)} && test ! -L ${shellQuote(path)} || exit ${exitCode}`,
    `test -d ${shellQuote(`${path}/.git`)} && test ! -L ${shellQuote(`${path}/.git`)} || exit ${exitCode}`,
    `test -z "$(find -P ${shellQuote(path)} ! -user root -print -quit)" || exit ${exitCode}`,
    `test -z "$(find -P ${shellQuote(path)} ! -group root -print -quit)" || exit ${exitCode}`,
    `test -z "$(find -P ${shellQuote(path)} ! -type l -perm /0022 -print -quit)" || exit ${exitCode}`,
  ];
}

function exactRepositoryChecks(
  path: string,
  url: string,
  subject: string,
  exitCode: number,
): string[] {
  return [
    `test "$(git -C ${shellQuote(path)} remote get-url origin)" = ${shellQuote(url)} || exit ${exitCode}`,
    `test "$(git -C ${shellQuote(path)} rev-parse HEAD)" = ${shellQuote(subject)} || exit ${exitCode}`,
    `test "$(git -C ${shellQuote(path)} rev-parse ${shellQuote(`${subject}^{commit}`)})" = ${shellQuote(subject)} || exit ${exitCode}`,
  ];
}

async function ensureRepositoryParent(sandbox: Sandbox): Promise<void> {
  const command = [
    `if test ! -e ${shellQuote(REPOSITORY_PARENT)}; then install -d -o root -g root -m 0700 ${shellQuote(REPOSITORY_PARENT)}; fi`,
    ...repositoryParentChecks(REPOSITORY_CONFLICT_EXIT),
  ].join("\n");
  const result = await sandbox.process.executeCommand(
    command,
    OPENTHROTTLE_ROOT,
    {},
    30,
  );
  if (result.exitCode !== 0) {
    throw new Error("Daytona repository source parent is not executor-owned");
  }
}

async function repositoryBindingState(
  sandbox: Sandbox,
  url: string,
  subject: string,
): Promise<"absent" | "ready" | "conflict"> {
  const probe = [
    ...repositoryParentChecks(REPOSITORY_CONFLICT_EXIT),
    `test -e ${shellQuote(DAYTONA_REPOSITORY_ROOT)} || exit ${REPOSITORY_ABSENT_EXIT}`,
    ...repositoryTreeChecks(DAYTONA_REPOSITORY_ROOT, REPOSITORY_CONFLICT_EXIT),
    ...exactRepositoryChecks(DAYTONA_REPOSITORY_ROOT, url, subject, REPOSITORY_CONFLICT_EXIT),
  ].join("\n");
  const result = await sandbox.process.executeCommand(
    probe,
    OPENTHROTTLE_ROOT,
    { GIT_TERMINAL_PROMPT: "0" },
    120,
  );
  if (result.exitCode === 0) return "ready";
  if (result.exitCode === REPOSITORY_ABSENT_EXIT) return "absent";
  return "conflict";
}

export async function assertDaytonaRepositorySourceFence(sandbox: Sandbox): Promise<void> {
  const result = await sandbox.process.executeCommand(
    [
      ...repositoryParentChecks(REPOSITORY_CONFLICT_EXIT),
      ...repositoryTreeChecks(DAYTONA_REPOSITORY_ROOT, REPOSITORY_CONFLICT_EXIT),
    ].join("\n"),
    OPENTHROTTLE_ROOT,
    {},
    30,
  );
  if (result.exitCode !== 0) {
    throw new Error("Daytona repository source physical fence is invalid");
  }
}

export async function materializeDaytonaRepositorySource(input: {
  sandbox: Sandbox;
  repository: string;
  base_branch: string;
  subject: string;
  github_read_token: string;
}): Promise<void> {
  const { sandbox, repository, base_branch: baseBranch, subject, github_read_token: token } = input;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Daytona repository binding is not a GitHub repository slug");
  }
  await ensureRepositoryParent(sandbox);
  const url = `https://github.com/${repository}.git`;
  const state = await repositoryBindingState(sandbox, url, subject);
  if (state === "ready") return;
  if (state === "conflict") {
    throw new Error("Daytona repository source conflicts with the exact run binding");
  }
  try {
    await sandbox.fs.deleteFile(REPOSITORY_STAGING, true);
  } catch (error) {
    if (!notFound(error)) throw error;
  }
  await sandbox.git.clone(
    url,
    REPOSITORY_STAGING,
    baseBranch,
    subject,
    "x-access-token",
    token,
    false,
  );
  const publish = [
    ...repositoryParentChecks(REPOSITORY_STAGING_INVALID_EXIT),
    `test ! -e ${shellQuote(DAYTONA_REPOSITORY_ROOT)} || exit ${REPOSITORY_CONFLICT_EXIT}`,
    `test -d ${shellQuote(REPOSITORY_STAGING)} && test ! -L ${shellQuote(REPOSITORY_STAGING)} || exit ${REPOSITORY_STAGING_INVALID_EXIT}`,
    `test -d ${shellQuote(`${REPOSITORY_STAGING}/.git`)} && test ! -L ${shellQuote(`${REPOSITORY_STAGING}/.git`)} || exit ${REPOSITORY_STAGING_INVALID_EXIT}`,
    ...exactRepositoryChecks(
      REPOSITORY_STAGING,
      url,
      subject,
      REPOSITORY_STAGING_INVALID_EXIT,
    ),
    `find -P ${shellQuote(REPOSITORY_STAGING)} -exec chown -h root:root -- {} +`,
    `find -P ${shellQuote(REPOSITORY_STAGING)} ! -type l -exec chmod a-w -- {} +`,
    ...repositoryTreeChecks(REPOSITORY_STAGING, REPOSITORY_STAGING_INVALID_EXIT),
    `mv -- ${shellQuote(REPOSITORY_STAGING)} ${shellQuote(DAYTONA_REPOSITORY_ROOT)}`,
  ].join("\n");
  const published = await sandbox.process.executeCommand(
    publish,
    REPOSITORY_PARENT,
    { GIT_TERMINAL_PROMPT: "0" },
    120,
  );
  if (published.exitCode !== 0) {
    throw new Error("Daytona could not atomically publish the exact repository source");
  }
  if (await repositoryBindingState(sandbox, url, subject) !== "ready") {
    throw new Error("Daytona repository source failed exact post-publication verification");
  }
}
