#!/usr/bin/env node

const action = process.argv[2];
const routes = {
  begin: { method: "POST", path: "/deployment/cutover/begin", body: readJsonArg() },
  advance: { method: "POST", path: "/deployment/cutover/advance", body: readJsonArg() },
  pause: { method: "POST", path: "/maintenance/admission/pause", body: { reason: "v12 deployment drain" } },
  evidence: { method: "GET", path: "/deployment/cutover-evidence" },
  resume: { method: "POST", path: "/maintenance/admission/resume" },
};
const route = routes[action];
if (!route) {
  throw new Error("usage: cutover-control.mjs <begin|advance|pause|evidence|resume> [json]");
}

function readJsonArg() {
  if (action !== "begin" && action !== "advance") return undefined;
  const raw = process.argv[3];
  if (!raw) throw new Error(`${action} requires a JSON object argument`);
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${action} JSON argument must be an object`);
  }
  return parsed;
}

const token = process.env.OT_DEPLOY_TOKEN;
if (!token) {
  throw new Error("OT_DEPLOY_TOKEN is not configured inside the Fly supervisor");
}

const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? "8080"}${route.path}`, {
  method: route.method,
  headers: {
    authorization: `Bearer ${token}`,
    ...(route.body ? { "content-type": "application/json" } : {}),
  },
  body: route.body ? JSON.stringify(route.body) : undefined,
});
const body = await response.text();
if (!response.ok) {
  throw new Error(`${action} failed with status ${response.status}: ${body.slice(0, 500)}`);
}
JSON.parse(body);
process.stdout.write(`${body}\n`);
