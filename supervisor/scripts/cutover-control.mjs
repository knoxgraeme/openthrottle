#!/usr/bin/env node

const action = process.argv[2];
const routes = {
  pause: { method: "POST", path: "/maintenance/admission/pause", body: { reason: "v12 deployment drain" } },
  evidence: { method: "GET", path: "/deployment/cutover-evidence" },
  resume: { method: "POST", path: "/maintenance/admission/resume" },
};
const route = routes[action];
if (!route) {
  throw new Error("usage: cutover-control.mjs <pause|evidence|resume>");
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
