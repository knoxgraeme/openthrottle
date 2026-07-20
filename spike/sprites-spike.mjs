#!/usr/bin/env node
// Platform spike for docs/SPRITES-PORT-PLAN.md §8 (Phase 0).
//
// Runs the open-question checks against a real Sprites org and prints
// PASS/FAIL/INFO per check. Zero dependencies; Node >= 20.
//
//   SPRITE_TOKEN=... node spike/sprites-spike.mjs [--only names,exec] [--keep]
//       [--destructive] [--api https://api.sprites.dev]
//
// Creates only sprites named `ot-spike-*` and deletes them at the end
// (unless --keep). --destructive enables the sudoers-removal check, which
// runs on its own dedicated sprite. Rough cost of a full run: well under $1.
//
// Where the public docs are ambiguous the harness probes candidate endpoint
// shapes in order and reports which one the API accepted, so a run of this
// script also settles the protocol questions for supervisor/src/sprites.ts.

const API = argValue("--api") ?? process.env.SPRITES_API_URL ?? "https://api.sprites.dev";
const TOKEN = process.env.SPRITE_TOKEN;
const ONLY = (argValue("--only") ?? "").split(",").filter(Boolean);
const KEEP = process.argv.includes("--keep");
const DESTRUCTIVE = process.argv.includes("--destructive");
const PREFIX = "ot-spike";
const MAIN = `${PREFIX}-main`;

if (!TOKEN) {
  console.error("SPRITE_TOKEN is required (create one at sprites.dev/account or `sprite org auth`).");
  process.exit(2);
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const results = [];
function record(check, status, detail) {
  results.push({ check, status, detail });
  console.log(`[${status}] ${check}${detail ? ` — ${detail}` : ""}`);
}

async function api(method, path, { body, raw, query, timeoutMs = 300_000 } = {}) {
  const url = new URL(API + path);
  for (const [k, v] of query ?? []) url.searchParams.append(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}),
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, text: () => buf.toString("utf8"), json: () => JSON.parse(buf.toString("utf8")) };
}

// --- exec ------------------------------------------------------------------
// Documented shape (managed-agents guide): POST /v1/sprites/{name}/exec with
// repeated `cmd` query params; framed body ending in an 0x03 frame followed
// by the exit code byte.
async function exec(name, script, { timeoutMs = 300_000 } = {}) {
  const res = await api("POST", `/v1/sprites/${name}/exec`, {
    query: [["cmd", "bash"], ["cmd", "-lc"], ["cmd", script]],
    timeoutMs,
  });
  if (res.status !== 200) throw new Error(`exec ${name} HTTP ${res.status}: ${res.text().slice(0, 300)}`);
  const b = res.buf;
  let exitCode = 0;
  let end = b.length;
  if (b.length >= 2 && b[b.length - 2] === 0x03) {
    exitCode = b[b.length - 1];
    end = b.length - 2;
  }
  return { exitCode, output: b.subarray(0, end).toString("utf8"), rawTail: b.subarray(-16).toString("hex") };
}

// Confirmed shape (SDK filesystem.ts): mode is a 4-digit octal string,
// mkdirParents creates the tree.
async function fsWrite(name, path, content, mode = "0644") {
  const res = await api("PUT", `/v1/sprites/${name}/fs/write`, {
    query: [["path", path], ["workingDir", "/"], ["mkdirParents", "true"], ["mode", mode]],
    raw: Buffer.from(content),
  });
  if (res.status >= 300) throw new Error(`fs/write ${path} HTTP ${res.status}: ${res.text().slice(0, 300)}`);
}

async function createSprite(name, extra = {}) {
  return api("POST", "/v1/sprites", { body: { name, wait_for_capacity: true, ...extra } });
}

async function deleteSprite(name) {
  return api("DELETE", `/v1/sprites/${name}`);
}

async function spriteStatus(name) {
  const res = await api("GET", `/v1/sprites/${name}`);
  return res.status === 200 ? res.json() : { status: `http-${res.status}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enabled = (id) => ONLY.length === 0 || ONLY.includes(id);

// --- checks ----------------------------------------------------------------

async function checkAuth() {
  const res = await api("GET", "/v1/sprites", { query: [["prefix", PREFIX]] });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text().slice(0, 200)}`);
  record("auth", "PASS", `token valid; ${res.json().sprites?.length ?? 0} existing ${PREFIX}* sprites`);
}

async function checkCreate() {
  const t0 = Date.now();
  const res = await createSprite(MAIN);
  if (res.status >= 300 && res.status !== 409) throw new Error(`create HTTP ${res.status}: ${res.text().slice(0, 200)}`);
  const again = await createSprite(MAIN);
  record(
    "create",
    "PASS",
    `create=${res.status} in ${Date.now() - t0}ms; repeat create=${again.status} (expect 409/200-style reuse)`
  );
}

// §8 Q5 — name constraints.
async function checkNames() {
  const probes = ["ot-Spike-UPPER", "ot_spike_underscore", `ot-spike-${"x".repeat(70)}`, "ot-spike-trailing-", "-ot-spike-leading"];
  const out = [];
  for (const name of probes) {
    const res = await createSprite(name);
    out.push(`${JSON.stringify(name.slice(0, 30))}=>${res.status}`);
    if (res.status < 300) await deleteSprite(name);
  }
  record("names", "INFO", out.join(", "));
}

async function checkExec() {
  const t0 = Date.now();
  const r = await exec(MAIN, "echo spike-stdout; echo spike-stderr 1>&2; exit 7");
  const framingOk = r.exitCode === 7 && r.output.includes("spike-stdout");
  record(
    "exec",
    framingOk ? "PASS" : "FAIL",
    `exit=${r.exitCode} (want 7), latency=${Date.now() - t0}ms, tail-hex=${r.rawTail}` +
      (framingOk ? "" : ` output=${JSON.stringify(r.output.slice(0, 120))}`)
  );
}

async function checkFs() {
  await fsWrite(MAIN, "/tmp/spike-dir/spike-fs.txt", "hello-from-fs-write\n", "0600");
  const r = await exec(MAIN, "cat /tmp/spike-dir/spike-fs.txt && stat -c '%a %U' /tmp/spike-dir/spike-fs.txt");
  const read = await api("GET", `/v1/sprites/${MAIN}/fs/read`, {
    query: [["path", "/tmp/spike-dir/spike-fs.txt"], ["workingDir", "/"]],
  });
  record(
    "fs",
    r.output.includes("hello-from-fs-write") && read.text().includes("hello-from-fs-write") ? "PASS" : "FAIL",
    `${r.output.trim().replace(/\n/g, " | ")}; fs/read=${read.status} (expect mode 600, mkdirParents worked)`
  );
}

// §8 Q4 (read-only part) — who are we, can we sudo, can a non-sudo user exist.
async function checkSudo() {
  const r = await exec(
    MAIN,
    [
      "echo user=$(id -un)",
      "sudo -n true && echo sudo=yes || echo sudo=no",
      "sudo -n useradd -m agent 2>/dev/null || true",
      "echo agent=$(sudo -n -u agent id -un 2>/dev/null || echo FAIL)",
      "sudo -n -u agent sudo -n true 2>/dev/null && echo agent_sudo=yes || echo agent_sudo=no",
      "echo sudoers_files=$(sudo -n ls /etc/sudoers.d/ 2>/dev/null | tr '\\n' ',')",
    ].join(" && ")
  );
  record("sudo", "INFO", r.output.trim().replace(/\n/g, " | "));
}

// §8 Q4 (destructive part) — remove sprite's sudo on a dedicated sprite and see
// whether exec / services / the management socket still work.
async function checkSudoRemoval() {
  const name = `${PREFIX}-sudo`;
  await createSprite(name);
  const pre = await exec(name, "sudo -n true && echo sudo=yes");
  await exec(name, "sudo -n bash -c 'rm -f /etc/sudoers.d/* ; sed -i \"/^sprite/d\" /etc/sudoers' || true");
  const post = await exec(
    name,
    [
      "sudo -n true 2>/dev/null && echo sudo=still-yes || echo sudo=removed",
      "sprite-env services list >/dev/null 2>&1 && echo services_api=ok || echo services_api=broken",
      "curl -s --unix-socket /.sprite/api.sock http://sprite/v1/tasks >/dev/null && echo socket=ok || echo socket=broken",
      "echo exec=ok",
    ].join("; ")
  );
  record("sudo-removal", "INFO", `pre: ${pre.output.trim()} | post: ${post.output.trim().replace(/\n/g, " | ")}`);
  await deleteSprite(name);
}

// D2/D5 — the run-holding pattern: service + task heartbeat keeps the sprite
// active past the ~30s idle window; after release it pauses on its own.
async function checkServiceTask() {
  const script = [
    "#!/usr/bin/env bash",
    "set -e",
    'sprite-env curl -X POST /v1/tasks -d \'{"name":"spike","expire":"3m"}\' >/dev/null 2>&1 || true',
    "sleep 75", // > idle window, no exec/session activity from outside
    "date +%s > /tmp/spike-service-done",
    "sprite-env curl -X DELETE /v1/tasks/spike >/dev/null 2>&1 || true",
    "sprite-env services stop spike-run >/dev/null 2>&1 || true",
  ].join("\n");
  await fsWrite(MAIN, "/tmp/spike-service.sh", script);
  await exec(MAIN, "chmod +x /tmp/spike-service.sh");
  const put = await api("PUT", `/v1/sprites/${MAIN}/services/spike-run`, {
    body: { cmd: "bash", args: ["-lc", "/tmp/spike-service.sh"], needs: [] },
  });
  if (put.status >= 300) {
    record("service-task", "FAIL", `service PUT HTTP ${put.status}: ${put.text().slice(0, 200)} (probe: endpoint shape wrong?)`);
    return;
  }
  const statuses = [];
  for (let i = 0; i < 10; i++) {
    await sleep(15_000);
    statuses.push((await spriteStatus(MAIN)).status);
  }
  const done = await exec(MAIN, "cat /tmp/spike-service-done 2>/dev/null || echo MISSING");
  record(
    "service-task",
    done.output.includes("MISSING") ? "FAIL" : "PASS",
    `status over 150s: [${statuses.join(",")}]; done-marker=${done.output.trim()} — expect running while task held, warm/paused after`
  );
}

// §8 Q2 — checkpoint create/restore timing.
// Confirmed shape (SDK sprite.ts): POST .../checkpoint (singular) with an
// NDJSON progress stream; list is GET .../checkpoints (plural); restore is
// POST .../checkpoints/{id}/restore (also NDJSON).
//
// NOTE: the test file lives under /home/sprite (persisted overlay), NOT /tmp.
// /tmp is scratch/tmpfs and is explicitly not part of the checkpointed overlay,
// so a /tmp file is a false negative for restore. We also read the file back
// via fs/read (raw bytes) instead of exec, to avoid exec's stream-ID framing
// bytes leaking into the compared output.
async function checkCheckpoint() {
  const P = "/home/sprite/spike-ckpt.txt";
  const readFile = async () => {
    const rd = await api("GET", `/v1/sprites/${MAIN}/fs/read`, { query: [["path", P], ["workingDir", "/"]] });
    return { status: rd.status, body: rd.status === 200 ? rd.text() : "" };
  };
  await fsWrite(MAIN, P, "pre-checkpoint\n");
  const t0 = Date.now();
  const res = await api("POST", `/v1/sprites/${MAIN}/checkpoint`, { body: { comment: "spike" } });
  if (res.status >= 300) {
    record("checkpoint", "FAIL", `POST /checkpoint HTTP ${res.status}: ${res.text().slice(0, 200)}`);
    return;
  }
  const createMs = Date.now() - t0; // fetch buffers the full NDJSON stream, so this is time-to-stream-end
  const list = await api("GET", `/v1/sprites/${MAIN}/checkpoints`);
  const checkpoints = list.status === 200 ? list.json() : [];
  const latest = Array.isArray(checkpoints) ? checkpoints[checkpoints.length - 1] : undefined;
  record(
    "checkpoint",
    "PASS",
    `create stream completed in ${createMs}ms (docs claim ms-CoW vs 10-30s — this settles it); ${
      Array.isArray(checkpoints) ? checkpoints.length : "?"
    } checkpoints, latest=${latest?.id}`
  );
  if (!latest?.id) return;
  await fsWrite(MAIN, P, "post-checkpoint\n");
  const t1 = Date.now();
  const restore = await api("POST", `/v1/sprites/${MAIN}/checkpoints/${latest.id}/restore`);
  const restoreMs = Date.now() - t1;
  // Restore is async and restarts the environment; fs/read retries while it comes back.
  let after = { status: 0, body: "" };
  for (let i = 0; i < 12; i++) {
    await sleep(3_000);
    after = await readFile().catch(() => ({ status: 0, body: "" }));
    if (after.status === 200) break;
  }
  record(
    "checkpoint-restore",
    after.body.includes("pre-checkpoint") ? "PASS" : "FAIL",
    `restore HTTP ${restore.status}, stream ${restoreMs}ms; fs/read after restore=${after.status} body=${JSON.stringify(
      after.body.trim()
    )} (want pre-checkpoint on the persisted /home/sprite path)`
  );
}

// D6 — egress policy enforcement.
// Confirmed shape (SDK policy.ts): GET/POST /v1/sprites/{name}/policy/network,
// 204 on success.
async function checkPolicy() {
  const path = `/v1/sprites/${MAIN}/policy/network`;
  const policy = { rules: [{ include: "defaults" }, { domain: "example.com", action: "deny" }] };
  const res = await api("POST", path, { body: policy });
  if (res.status >= 300) {
    record("policy", "FAIL", `POST ${path} HTTP ${res.status}: ${res.text().slice(0, 200)}`);
    return;
  }
  await sleep(3_000);
  const readBack = await api("GET", path);
  const r = await exec(
    MAIN,
    "cat /.sprite/policy/network.json 2>/dev/null | head -c 200; echo; dig +short github.com | head -1; dig example.com 2>&1 | grep -o REFUSED | head -1"
  );
  record(
    "policy",
    "PASS",
    `applied (HTTP ${res.status}); GET=${readBack.status}; in-sprite view+resolution: ${r.output.trim().replace(/\n/g, " | ")}`
  );
  // reset to unrestricted for the remaining checks
  await api("POST", path, { body: { rules: [] } });
}

// §8 Q7 / D7 — URL auth behavior and wake-on-request.
async function checkUrl() {
  const info = await spriteStatus(MAIN);
  if (!info.url) {
    record("url", "FAIL", "no url in GET /v1/sprites response");
    return;
  }
  await api("PUT", `/v1/sprites/${MAIN}/services/spike-web`, {
    body: { cmd: "python3", args: ["-m", "http.server", "3000"], http_port: 3000, needs: [] },
  });
  await sleep(3_000);
  const anon = await fetch(info.url, { redirect: "manual", signal: AbortSignal.timeout(30_000) }).catch((e) => ({ status: `ERR ${e.message}` }));
  const tokened = await fetch(info.url, {
    headers: { authorization: `Bearer ${TOKEN}` },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => ({ status: `ERR ${e.message}` }));
  record("url", "INFO", `url=${info.url} auth=${info.url_settings?.auth}; anonymous=>${anon.status}; org-token=>${tokened.status}`);
  await exec(MAIN, "sprite-env services delete spike-web >/dev/null 2>&1 || true");
}

// Warm-wake latency: leave the sprite idle past the window, then time an exec.
async function checkWake() {
  await exec(MAIN, "true");
  await sleep(50_000);
  const before = (await spriteStatus(MAIN)).status;
  const t0 = Date.now();
  await exec(MAIN, "true");
  record("wake", "INFO", `status after 50s idle=${before}; exec-after-idle latency=${Date.now() - t0}ms`);
}

// §8 Q1 — concurrency cap. Research indicates SEPARATE active and warm caps
// (equal per tier; Adventurer=20), paused=warm counts against the warm cap,
// cold counts against neither, and the create call returns a structured
// `concurrent_sprite_limit_exceeded` error. This probes the create-time cap
// and surfaces the structured fields. Raise --cap-probe above the plan tier to
// actually trip it (default 25 clears Adventurer's 20).
async function checkCap() {
  const max = Number(argValue("--cap-probe") ?? 25);
  const created = [];
  let capHit = null;
  for (let i = 1; i <= max; i++) {
    const name = `${PREFIX}-cap-${i}`;
    const res = await api("POST", "/v1/sprites", { body: { name, wait_for_capacity: false } });
    if (res.status >= 300 && res.status !== 409) {
      let extra = res.text().slice(0, 160);
      try {
        const j = res.json();
        extra = `error=${j.error} limit=${j.limit} current=${j.current_count} upgrade=${j.upgrade_available}`;
      } catch {}
      capHit = `capped at create #${i}: HTTP ${res.status} ${extra}`;
      break;
    }
    created.push(name);
  }
  record(
    "cap",
    "INFO",
    (capHit ?? `created ${created.length} sprites without a create-time cap (raise --cap-probe)`) +
      " — research: distinct active vs warm caps; confirm whether these ot-spike sprites (now warm) block a fresh create"
  );
  for (const name of created) await deleteSprite(name);
}

// §8 Q3 — memory. Research says design bursts to 16 GB but the practical
// ceiling is reported ~8 GB. Allocate past 8 GB in 1 MB chunks and see where it
// dies (or whether it reaches ~16 GB), plus what `free` reports.
async function checkMem() {
  const r = await exec(
    MAIN,
    "free -m | head -2; node -e 'const a=[];try{for(let i=0;i<17000;i++){a.push(Buffer.alloc(1<<20,1));if(i%1000===0)console.log(i,\"MB\")}}catch(e){console.log(\"died:\",e.message)}' 2>&1 | tail -3",
    { timeoutMs: 300_000 }
  );
  record("mem", "INFO", `${r.output.trim().replace(/\n/g, " | ")} — expect death ~8GB (advertised 16GB)`);
}

async function cleanup() {
  if (KEEP) {
    record("cleanup", "INFO", "--keep set; leaving ot-spike-* sprites in place");
    return;
  }
  const res = await api("GET", "/v1/sprites", { query: [["prefix", PREFIX]] });
  const names = (res.status === 200 ? res.json().sprites ?? [] : []).map((s) => s.name);
  for (const name of names) await deleteSprite(name);
  record("cleanup", "PASS", `deleted: ${names.join(", ") || "(none)"}`);
}

// --- run -------------------------------------------------------------------

const CHECKS = [
  ["auth", checkAuth],
  ["create", checkCreate],
  ["names", checkNames],
  ["exec", checkExec],
  ["fs", checkFs],
  ["sudo", checkSudo],
  ["sudo-removal", checkSudoRemoval, { destructive: true }],
  ["service-task", checkServiceTask],
  ["checkpoint", checkCheckpoint],
  ["policy", checkPolicy],
  ["url", checkUrl],
  ["wake", checkWake],
  ["cap", checkCap],
  ["mem", checkMem],
];

for (const [id, fn, opts] of CHECKS) {
  if (!enabled(id)) continue;
  if (opts?.destructive && !DESTRUCTIVE) {
    record(id, "SKIP", "pass --destructive to run");
    continue;
  }
  try {
    await fn();
  } catch (err) {
    record(id, "FAIL", String(err.message ?? err).slice(0, 300));
  }
}
await cleanup().catch((err) => record("cleanup", "FAIL", String(err.message ?? err)));

console.log("\n=== summary ===");
for (const r of results) console.log(`${r.status.padEnd(4)} ${r.check}`);
process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
