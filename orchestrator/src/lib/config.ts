import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { OpenThrottleConfig } from "../types.js";

const DEFAULTS: OpenThrottleConfig = {
  base_branch: "main",
  test: "",
  lint: "",
  build: "",
  format: "",
  dev: "",
  agent: "claude",
  snapshot: "openthrottle",
  notifications: "telegram",
  post_bootstrap: [],
  mcp_servers: {},
  limits: { max_turns: 200, max_budget_usd: 5.0, task_timeout: 7200 },
  review: { enabled: true, max_rounds: 3 },
};

export function loadConfig(configPath: string): OpenThrottleConfig {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as Partial<OpenThrottleConfig>;
  return {
    ...DEFAULTS,
    ...parsed,
    limits: { ...DEFAULTS.limits, ...parsed.limits },
    review: { ...DEFAULTS.review, ...parsed.review },
  };
}
