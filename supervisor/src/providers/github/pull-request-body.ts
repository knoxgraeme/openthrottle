export function buildGithubPullRequestBody(body: string, ownershipMarker: string): string {
  return `${body.trimEnd()}\n\n<!-- ${ownershipMarker} -->\n`;
}
