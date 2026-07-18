import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify GitHub's `X-Hub-Signature-256` header: `sha256=<hex hmac>` of the
 * raw request body, keyed with the webhook secret.
 * https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */
export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookSecret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expectedHex = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  const expected = `sha256=${expectedHex}`;
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export interface GithubPullRequestEvent {
  action: string; // "opened" | "closed" | "reopened" | ... — we only act on "closed"
  pull_request: {
    number: number;
    html_url: string;
    merged: boolean;
    head: { ref: string };
    base: { ref: string };
  };
  repository: {
    full_name: string; // owner/name
  };
}

export function parseGithubPullRequestEvent(raw: string): GithubPullRequestEvent {
  return JSON.parse(raw) as GithubPullRequestEvent;
}

/** Branch naming convention per SPEC: `ot/{issueIdentifier-lowercased}`. */
export function isOpenthrottleBranch(ref: string): boolean {
  return ref.startsWith("ot/");
}
