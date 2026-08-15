// One shared GitHub REST preamble: base URL, Accept/Authorization/API-version
// headers, and the request timeout. Every supervisor-side GitHub HTTP call
// funnels through githubApiResponse so the wire contract cannot drift between
// call sites. githubApiResponse returns the raw Response (status readable, no
// throw); assertGithubResponseOk carries the shared error-throw convention for
// callers that treat any non-2xx as failure.
//
// This lives under shared/ (not providers/github) because app/ modules — the
// admission preflight's read-token probe — need the same preamble and the
// architecture map forbids app -> providers imports.

const HTTP_TIMEOUT_MS = 15_000;

export interface GithubRequestTarget {
  token: string;
  apiBaseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
}

export async function githubApiResponse(
  target: GithubRequestTarget,
  path: string,
  init: RequestInit = {},
  accept = "application/vnd.github+json"
): Promise<Response> {
  const fetchImpl = target.fetch ?? fetch;
  return fetchImpl(`${target.apiBaseUrl ?? "https://api.github.com"}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      Accept: accept,
      Authorization: `Bearer ${target.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
}

export async function assertGithubResponseOk(response: Response): Promise<Response> {
  if (!response.ok) {
    throw new Error(`GitHub API error (${response.status}): ${await response.text()}`);
  }
  return response;
}
