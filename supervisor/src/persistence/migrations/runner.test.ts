import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../database.js";
import { applyBaseSchema } from "../schema.js";
import {
  canonicalJson,
  parsePipelineManifest,
  PIPELINE_OUTCOMES,
  STAGE_OUTCOMES,
  type PipelineUnitPhaseBinding,
} from "../../pipeline/manifest.js";
import { createExecutionUnitStore } from "../pipeline/unit-store.js";
import { createJournalStore } from "../pipeline/journal-store.js";
import { GATE_RECEIPT_REASONS } from "../../pipeline/gates.js";
import { FAULT_ATTRIBUTIONS } from "../../pipeline/fault-attribution.js";
import { ENGINES } from "../pipeline/run-outcome-store.js";
import { createSettingsStore } from "../settings-store.js";
import { createSupervisorStore } from "../store.js";
import { considerCiGithubHead } from "../../providers/github/events.js";
import {
  applyDatabaseMigrations,
  applyDatabaseMigrationsForAuthority,
  databaseMigrations,
  ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX,
} from "./runner.js";

let db: Database.Database | undefined;
const temporaryDirectories: string[] = [];
const PREDECESSOR_MIGRATION_VERSION = 45;
const PREDECESSOR_RELEASE_COMMIT = "463aa48a2d31257e2ccb93b1a48f6e3b550c58c4";
const PREDECESSOR_ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX =
  " [rollback-compatible:additive/v1]";
const PREDECESSOR_MIGRATION_CATALOG_SHA256 =
  "31171c29d16f19b28e86ec0e5580600c7066547ef309936a4cc10cb6fbeeafdf";

function migrationCatalogDigest(
  migrations: ReadonlyArray<{ version: number; name: string; checksum: string; mode?: string }>
): string {
  return createHash("sha256")
    .update(JSON.stringify(migrations.map(({ version, name, checksum, mode }) => ({
      version,
      name,
      checksum,
      mode: mode ?? null,
    }))))
    .digest("hex");
}

function builtinUnitPhaseBindings(): PipelineUnitPhaseBinding[] {
  const worker = {
    id: "worker",
    engine: "agent" as const,
    allowed_mcp_servers: [],
    session_scope: "fresh" as const,
    credentials: ["model.invoke", "repo.read", "repo.write"],
  };
  const implement: PipelineUnitPhaseBinding = {
    id: "implement",
    kind: "agent",
    loop: {
      id: "implement-loop",
      skill: "builtin://ce/implement@1",
      input_scope: "unit",
      receipt: "unit_completion",
      max_parallel: 1,
      max_rounds: 1,
      timeout_seconds: 60,
    },
    worker,
    executor: { kind: "agent", capability: "ce/implement@1" },
    context: "fresh",
    credentials: worker.credentials,
  };
  return [
    implement,
    {
      id: "simplify",
      kind: "agent",
      loop: {
        id: "simplify-loop",
        skill: "builtin://ce/simplify@1",
        input_scope: "unit",
        receipt: "unit_completion",
        max_parallel: 1,
        max_rounds: 1,
        timeout_seconds: 60,
      },
      worker,
      executor: { kind: "agent", capability: "ce/simplify@1" },
      context: "fresh",
      credentials: worker.credentials,
    },
    { id: "command", kind: "command", commands: [] },
    { id: "candidate", kind: "evidence" },
    {
      id: "lead",
      kind: "gate",
      loop: {
        id: "lead-loop",
        skill: "builtin://ce/implement@1",
        input_scope: "unit",
        receipt: "unit_decision",
        max_parallel: 1,
        max_rounds: 1,
        timeout_seconds: 60,
      },
      worker,
      executor: { kind: "agent", capability: "ce/implement@1" },
      context: "fresh",
      credentials: worker.credentials,
    },
    { id: "integrate", kind: "integrate" },
  ];
}

afterEach(() => {
  db?.close();
  db = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database migrations", () => {
  it("records immutable checksums and is idempotent", () => {
    db = openDb(":memory:");
    applyDatabaseMigrations(db);

    const rows = db.prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
    ).all() as Array<{ version: number; name: string; checksum: string }>;
    expect(rows).toHaveLength(databaseMigrations.length);
    expect(rows.map((row) => row.version)).toEqual(databaseMigrations.map((migration) => migration.version));
    expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(true);
    // These hashes come only from stable migration manifests, never transpiled
    // Function#toString output. Changing one normally means adding a new
    // migration. V35 was corrected before its first successful deployment:
    // the initial rollout could not commit it on the staging database.
    expect(databaseMigrations.map((migration) => migration.checksum)).toEqual([
      "b94ca61aba6b4e06872210f58f19d7dc8c53fbdec42f6ad238be7cf4d96bebef",
      "504d954a847f08dbd3db3f144c208b3270de4ecd8b52cddcbb02893353c40b68",
      "140f060d9f9b340c994776f60e97a5e5945e1648fff18879ff5548f29a4618be",
      "4d2bb23002c3c517560bc0ef43e0e9af732ce0dfc9d180129e2b1b23138c928c",
      "bed5e9e1ce85b323ebb87d4dd70148bae8a44e64017eec6d25484cb433079c65",
      "a25c3d25dbbbabaeb00a7b74d77ff186706f92579333aeee8b78f18eb1de4644",
      "3da725659a91d7b2babf5a2dac20f1cca26cbe7957d238c5f1877f7bf38de40a",
      "e2cd34be32f4dd0ab9fdacb87732dae7121574efb7bd1aa166090e3591b851e6",
      "a8687cedc0fd1fc88b1cc8a6c39589d9cbe3279f6360195975de9f87e1d25ba3",
      "3ad35a452352b7cd5db98b32ba67b2f6906c465fa263a8396cae4ad09b7a3ab7",
      "1b7f1245f97725dfe081493638283b38fec8f363138fe5b8c4450ba9220ee84c",
      "5a368da3f7ec165fef42cdb27545534372e6344c3283f185e65e5c447a671dee",
      "927f4e9a8a9583b52fed3f537a364ba4a57c47ea9afa4b9475286e2ec8605b71",
      "e9a57fd85fbca09daeb1b87dbeab27d9cf696da3cb6e00a4a0ee7652bb72d6e2",
      "f8bdad88455442e46d1951f7fe48050f9367d83273ed94c8eaf7f610666fb809",
      "5327e028894aeac2334d4fd63da3937cdb3470419d9cde8aa7f20832280aa6ad",
      "438e4388d9f50e29233a33c86065e97e0e958b9c1e39a04e0c6be74c279c805f",
      "23f09c8fd9f001ea824f86a24edd3d496949594af5dfeb9ad835fc109942ac97",
      "5cf580fcb6d73b2b4ff4fdaa5cf4e1a7c14b2f84b945fcdf313caf36ca4cf662",
      "a4b0a5723dfa7953ca199dcb5e84da498771882bb19ecfde2e98f0e20cb4f825",
      "60d16031c8c20060780fa6e5517d0b7b4bd39484b63c5e972d19ab43ba1828b8",
      "b75e921b54e36b415be7159cafe28f96a857ccc28127300f132680b9d0d6fa5e",
      "5d9718a2604226bee84c076db80af6c44524f98997825d80b2d6d7ebb939ee1f",
      "523d304d8f13e0cf3852785ceb1c5878224a3ca22eb42766aa30eab1e7a8bf9d",
      "f58ac346a0822417b9d3ff3a40df91beb77d1f8c52c135ebb5a795bc29f73914",
      "97611e1f750392871f83ff7944039c761695e834d54661ee225bd205b0c38b1b",
      "393246d3d56b685e1a25e7a18e6a8a2485c70b96301836a8437bfac5568bd009",
      "d07f005df485a8b7506a2e81046846c0c070a4790109e22e8c7081df9a2f29f0",
      "f814f7519462623d684c0d8b15f997afeaa4391ac861dc93ecd6dd8326677367",
      "62d23bf76b20a18c4ff15352d3ef1558fe6bb364860d58915a26a84c8a6ed2b3",
      "1b9a06d171fdefd11b55aa4b785fc639310792b8de144d4c49c50206c4a6a3b2",
      "e1f1cc26fcd21df5ca8cb56548d2d38f90311d40d93bcd0e54d4ab62f9eb6ad4",
      "36f3c74ad261f3e4e9e5014221e5ff8510dc7123b03ab92f2875b02ab0cf4fb2",
      "8ede2103ae2f761958e4a21fc672b1c7a2a6c8fe39f75109ca3843b2fe492597",
      "0d0aa73d6cbb944697d6815f5bd1c8dd766a919b8692945b905298759dd766a7",
      "be4b0a09caf911013a376efe34aed76843fc89901c59dfe195eda0be4b4a852a",
      "0550761a59df3d2178bcdfd5113c0d270c35fe090da08fb0f732eccf7d2d2fd3",
      "fd013193d587a17350c261bc411384c0420e432babc2cd87af648d8c1348a0d2",
      "4942852ca8dc280d8b9b86f79e7dc6621317667eaec0ec3c848fa1415fe67d48",
      "acb5e6c121d5ed18ec87b5c717c190dd4a6c486a88824807c5c25c32b12edeb4",
      "9e3ab22f612eab044e4c1f0e4fda8ac471b8c24befcb59594add21658d429564",
      "793d6ba7d049343e8275d0994677f5b8ebe00c942796512879544da10d45bfab",
      "816a31439db18b9975c2d66b9dda45f3bfa9375d0d43309b46eeb28acf486a3a",
      "71bba805a7a02e1efb77633f9458b63ce55b7ee6546d2c26ac2124ee3e802c31",
      "072679bbc79c4a0f930e8d56be07c4a1a4a124014c0e1453be9709306765a197",
      "ccdf4a1bedafc52eea3aab537d55799e666e25cd78ab5dcc61b8c4c976bde7d7",
      "e9ef3b9a4ddc219cfaa755bd72e73580ef497bcb3c361b5622ab1b412a32dd2a",
      "ba1a28c92a0e3f84080ce6fe1b329f21855d5e96ebdf3312d22af646d182fff7",
      "0dd5b83a690d982be21f4232daa62ed45eaa66f082c6a100284004305bbde74b",
      "5e755e28e1a6a500c108c9cf3c6c4a66f97dc78309b9be11fe1af204b688d7f2",
      "167edf7c177c22c3074446c93e742cf44b47a9dc5da5e338d64f9e06f8549f07",
    ]);
  });

  it("backfills the single steering owner from the legacy inbox and active delivery", () => {
    // Migration 1 used this three-field encoding when it introduced WorkStore
    // and backfilled the pre-ledger session inbox. Migration 51 must preserve
    // those bytes while still accepting an exact provider retry of the ID.
    const legacyRequestHash = createHash("sha256")
      .update(JSON.stringify(["steer-1", "session-1", "keep this message"]))
      .digest("hex");
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyBaseSchema(db);
    applyDatabaseMigrationsForAuthority(db, {
      migrations: databaseMigrations.filter((migration) => migration.version <= 50),
      rollbackCompatibleMigrationNameSuffix: ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX,
    });
    db.exec(`
      INSERT INTO tickets (
        ticket_id, ticket_reference, session_id, control_provider, external_thread_id,
        external_thread_reference, branch, agent, repo, state, total_cost_usd,
        base_branch, created_at, updated_at
      ) VALUES (
        'issue-1', 'OT-1', 'session-1', 'linear', 'issue-1', 'OT-1',
        'ot/ot-1', 'codex', 'owner/repo', 'active', 0, 'main',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO agent_sessions (
        id, ticket_id, generation, state, provider_conversation_id, created_at, updated_at
      ) VALUES (
        'session-1', 'issue-1', 2, 'current', 'native-1',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO runs (
        id, ticket_id, session_id, session_generation, task_type, token_hash,
        status, started_at, expires_at, actor_state
      ) VALUES (
        'run-1', 'issue-1', 'session-1', 2, 'implement', 'hash', 'running',
        '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'running'
      );
      INSERT INTO session_inbox (
        id, ticket_id, session_id, run_id, source, body, status, created_at, delivered_at
      ) VALUES (
        'steer-1', 'issue-1', 'session-1', 'run-1', 'human', 'keep this message',
        'dispatched', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z'
      ), (
        'steer-legacy-delivered', 'issue-1', 'session-1', 'run-1', 'operator',
        'historically delivered then canceled', 'delivered',
        '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:04.000Z'
      ), (
        'steer-live-acknowledged', 'issue-1', 'session-1', 'run-1', 'operator',
        'acknowledged and consumed', 'acknowledged',
        '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:06.000Z'
      ), (
        'steer-live-canceled', 'issue-1', 'session-1', 'run-1', 'operator',
        'canceled before delivery', 'canceled',
        '2026-01-01T00:00:07.000Z', NULL
      ), (
        'steer-live-pending', 'issue-1', 'session-1', NULL, 'human',
        'still pending', 'pending', '2026-01-01T00:00:08.000Z', NULL
      );
      INSERT INTO work_items (
        id, ticket_id, session_id, run_id, native_session_id, generation,
        context_revision, source, priority, body, request_hash, status,
        active_delivery_id, available_at, created_at, updated_at
      ) VALUES (
        'steer-1', 'issue-1', 'session-1', NULL, 'native-1', 2, 0,
        'human', 0, 'keep this message', '${legacyRequestHash}', 'dispatched',
        'delivery-1', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z',
        '2026-01-01T00:00:02.000Z'
      ), (
        'steer-legacy-delivered', 'issue-1', 'session-1', NULL, 'native-1', 2, 0,
        'operator', 10, 'historically delivered then canceled', 'legacy-canceled-hash',
        'canceled', NULL, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z',
        '2026-01-01T00:00:04.000Z'
      ), (
        'steer-live-acknowledged', 'issue-1', 'session-1', NULL, 'native-1', 2, 0,
        'operator', 10, 'acknowledged and consumed', 'legacy-consumed-hash',
        'consumed', 'delivery-consumed', '2026-01-01T00:00:05.000Z',
        '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:06.000Z'
      ), (
        'steer-live-canceled', 'issue-1', 'session-1', NULL, 'native-1', 2, 0,
        'operator', 10, 'canceled before delivery', 'legacy-canceled-pair-hash',
        'canceled', NULL, '2026-01-01T00:00:07.000Z',
        '2026-01-01T00:00:07.000Z', '2026-01-01T00:00:07.000Z'
      ), (
        'steer-live-pending', 'issue-1', 'session-1', NULL, 'native-1', 2, 0,
        'human', 0, 'still pending', 'legacy-pending-hash', 'pending', NULL,
        '2026-01-01T00:00:08.000Z', '2026-01-01T00:00:08.000Z',
        '2026-01-01T00:00:08.000Z'
      );
      INSERT INTO work_deliveries (
        id, work_item_id, attempt_ordinal, idempotency_key, ticket_id, session_id,
        run_id, native_session_id, generation, context_revision, request_hash,
        status, lease_until, created_at, dispatched_at
      ) VALUES (
        'delivery-1', 'steer-1', 1, 'delivery-key', 'issue-1', 'session-1',
        'run-1', 'native-1', 2, 0, '${legacyRequestHash}', 'dispatched',
        '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z',
        '2026-01-01T00:00:02.000Z'
      ), (
        'delivery-consumed', 'steer-live-acknowledged', 1, 'delivery-consumed-key',
        'issue-1', 'session-1', 'run-1', 'native-1', 2, 0,
        'legacy-consumed-hash', 'consumed', '2026-01-01T00:01:00.000Z',
        '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:06.000Z'
      );
    `);

    applyDatabaseMigrations(db);

    expect(db.prepare("SELECT * FROM steering_items WHERE id = 'steer-1'").get()).toMatchObject({
      ticket_id: "issue-1",
      session_id: "session-1",
      run_id: "run-1",
      status: "dispatched",
      delivery_id: "delivery-1",
      request_hash: legacyRequestHash,
      generation: 2,
      native_session_id: "native-1",
      lease_until: "2099-01-01T00:00:00.000Z",
    });

    const store = createSupervisorStore(db);
    expect(store.enqueueInbox({
      id: "steer-1",
      issueId: "issue-1",
      sessionId: "session-1",
      runId: "run-1",
      source: "human",
      body: "keep this message",
    })).toMatchObject({ id: "steer-1", request_hash: legacyRequestHash });
    expect(db.prepare("SELECT request_hash FROM steering_items WHERE id = 'steer-1'").get())
      .toEqual({ request_hash: legacyRequestHash });
    expect(db.prepare(`
      SELECT status, run_id, delivery_id
      FROM steering_items WHERE id = 'steer-legacy-delivered'
    `).get()).toEqual({
      status: "canceled",
      run_id: "run-1",
      delivery_id: null,
    });
    expect(db.prepare(`
      SELECT id, status, delivery_id FROM steering_items
      WHERE id LIKE 'steer-live-%' ORDER BY id
    `).all()).toEqual([
      { id: "steer-live-acknowledged", status: "acknowledged", delivery_id: "delivery-consumed" },
      { id: "steer-live-canceled", status: "canceled", delivery_id: null },
      { id: "steer-live-pending", status: "pending", delivery_id: null },
    ]);

    const postCutover = store.enqueueInbox({
      id: "steer-post-cutover",
      issueId: "issue-1",
      sessionId: "session-1",
      runId: "run-1",
      source: "operator",
      body: "visible only to the deploy-forward owner",
    });
    expect(store.enqueueInbox({
      id: "steer-post-cutover",
      issueId: "issue-1",
      sessionId: "session-1",
      runId: "run-1",
      source: "operator",
      body: "visible only to the deploy-forward owner",
    })).toEqual(postCutover);
    expect(db.prepare("SELECT id FROM steering_items WHERE id = 'steer-post-cutover'").get())
      .toEqual({ id: "steer-post-cutover" });
    expect(db.prepare("SELECT id FROM session_inbox WHERE id = 'steer-post-cutover'").get())
      .toBeUndefined();
    expect(db.prepare("SELECT id FROM work_items WHERE id = 'steer-post-cutover'").get())
      .toBeUndefined();
    expect(db.prepare("SELECT work_item_id FROM work_deliveries WHERE work_item_id = 'steer-post-cutover'").get())
      .toBeUndefined();
  });

  it("maps every durable work status without reviving terminal legacy steering", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyBaseSchema(db);
    applyDatabaseMigrationsForAuthority(db, {
      migrations: databaseMigrations.filter((migration) => migration.version <= 50),
      rollbackCompatibleMigrationNameSuffix: ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX,
    });
    db.exec(`
      INSERT INTO tickets (
        ticket_id, ticket_reference, session_id, control_provider, external_thread_id,
        external_thread_reference, branch, agent, repo, state, total_cost_usd,
        base_branch, created_at, updated_at
      ) VALUES (
        'issue-statuses', 'OT-STATUSES', 'session-statuses', 'linear',
        'issue-statuses', 'OT-STATUSES', 'ot/statuses', 'codex', 'owner/repo',
        'active', 0, 'main', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO agent_sessions (
        id, ticket_id, generation, state, created_at, updated_at
      ) VALUES (
        'session-statuses', 'issue-statuses', 1, 'current',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    const insertInbox = db.prepare(`
      INSERT INTO session_inbox (
        id, ticket_id, session_id, run_id, source, body, status, created_at
      ) VALUES (?, 'issue-statuses', 'session-statuses', NULL, 'human', ?, ?, ?)
    `);
    const insertWork = db.prepare(`
      INSERT INTO work_items (
        id, ticket_id, session_id, run_id, native_session_id, generation,
        context_revision, source, priority, body, request_hash, status,
        active_delivery_id, available_at, created_at, updated_at
      ) VALUES (
        ?, 'issue-statuses', 'session-statuses', NULL, NULL, 1, 0,
        'human', 0, ?, ?, ?, NULL, ?, ?, ?
      )
    `);
    const cases = [
      ["pending", "pending", "pending"],
      ["leased", "pending", "pending"],
      ["dispatched", "delivered", "dispatched"],
      ["acknowledged", "acknowledged", "acknowledged"],
      ["consumed", "acknowledged", "acknowledged"],
      ["canceled", "delivered", "canceled"],
      ["dead", "delivered", "canceled"],
      ["reconciliation", "delivered", "canceled"],
    ] as const;
    cases.forEach(([workStatus, inboxStatus], index) => {
      const id = `steer-status-${workStatus}`;
      const body = `status ${workStatus}`;
      const timestamp = `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`;
      insertInbox.run(id, body, inboxStatus, timestamp);
      insertWork.run(id, body, `hash-${workStatus}`, workStatus, timestamp, timestamp, timestamp);
    });

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT id, status FROM steering_items
      WHERE ticket_id = 'issue-statuses' ORDER BY id
    `).all()).toEqual(cases.map(([workStatus, , expectedStatus]) => ({
      id: `steer-status-${workStatus}`,
      status: expectedStatus,
    })).sort((left, right) => left.id.localeCompare(right.id)));
  });

  it("uses the v51 partial index for run-bound steering settlement", () => {
    db = openDb(":memory:");

    const index = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'steering_items_run_settlement_idx'
    `).get() as { sql: string } | undefined;
    expect(index?.sql).toContain("WHERE status IN ('pending', 'dispatched')");

    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      UPDATE steering_items SET status = 'canceled'
      WHERE run_id = ? AND status IN ('pending', 'dispatched')
    `).all("run-1") as Array<{ detail: string }>;
    expect(plan.map((step) => step.detail).join("\n"))
      .toContain("steering_items_run_settlement_idx");
  });

  it("marks migration 51 deploy-forward-only while retaining the mechanically required additive suffix", () => {
    const migration = databaseMigrations.find((candidate) => candidate.version === 51)!;

    expect(migration.name).toBe(
      `steering-items-single-owner${ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX}`
    );
    expect(migration.source).toContain("deployment-policy:deploy-forward-only/operator-authorized/v1");
    expect(migration.source).toContain("copy work_items.request_hash byte-for-byte");
    expect(migration.source).toContain("work_items is the newer status authority");
    expect(migration.source).toContain("legacy tables remain only for additive schema and old-row backfill");
    expect(migration.source).toContain("no dual-write");
    expect(migration.source).toContain("rollback does not expose steering written after cutover");
  });

  it("persists tune as a closed task type on fresh and upgraded databases", () => {
    db = openDb(":memory:");
    const sql = (db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_instances'
    `).get() as { sql: string }).sql;
    expect(sql).toContain("'tune'");
    const now = "2026-08-12T00:00:00.000Z";
    db.exec(`
      INSERT INTO tickets (
        ticket_id, ticket_reference, session_id, branch, agent, repo, state,
        base_branch, created_at, updated_at
      ) VALUES ('tune-ticket', 'OPE-TUNE', 'tune-session', 'ot/tune', 'codex', 'owner/repo', 'active', 'main', '${now}', '${now}');
      INSERT INTO agent_sessions (id, ticket_id, generation, state, created_at, updated_at)
      VALUES ('tune-session', 'tune-ticket', 1, 'current', '${now}', '${now}');
      INSERT INTO pipeline_catalog_entries (pipeline_id, version, digest, normalized_manifest, accepted_at)
      VALUES ('core/tune', 1, '${"a".repeat(64)}', '{}', '${now}');
      INSERT INTO runtime_capability_descriptors (runtime_release, digest, protocol, normalized_descriptor, accepted_at)
      VALUES ('runtime/v1', '${"b".repeat(64)}', 'stage-executor@1', '{}', '${now}');
      INSERT INTO repository_config_snapshots (
        id, repository, base_commit, blob_sha, digest, normalized_config, created_at
      ) VALUES ('tune-config', 'owner/repo', '${"c".repeat(40)}', 'blob', '${"d".repeat(64)}', '{}', '${now}');
    `);
    const insert = db.prepare(`
      INSERT INTO pipeline_instances (
        id, ticket_id, session_id, generation, pipeline_id, pipeline_version,
        manifest_digest, normalized_manifest, repository, base_commit,
        repository_config_snapshot_id, repository_config_digest, runtime_release,
        capability_digest, executor_protocol, authorized_capabilities, status,
        created_at, updated_at, branch, agent, task_type, base_branch
      ) VALUES (?, 'tune-ticket', 'tune-session', 1, 'core/tune', 1, ?, '{}',
        'owner/repo', ?, 'tune-config', ?, 'runtime/v1', ?, 'stage-executor@1',
        '[]', 'pending', ?, ?, 'ot/tune', 'codex', ?, 'main')
    `);
    insert.run("tune-instance", "a".repeat(64), "c".repeat(40), "d".repeat(64), "b".repeat(64), now, now, "tune");
    expect(db.prepare("SELECT task_type FROM pipeline_instances WHERE id = 'tune-instance'").get())
      .toEqual({ task_type: "tune" });
    expect(() => insert.run("bad", "a".repeat(64), "c".repeat(40), "d".repeat(64), "b".repeat(64), now, now, "unknown"))
      .toThrow(/CHECK constraint failed/);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("adds durable GitHub redelivery state to a v35 database without losing deliveries or ledger rows", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        next_attempt_at TEXT,
        last_error TEXT,
        received_at TEXT NOT NULL
      );
      INSERT INTO webhook_deliveries (
        delivery_id, source, payload, status, attempts, next_attempt_at,
        last_error, received_at
      ) VALUES (
        'legacy-dead', 'github', '{"repository":{"full_name":"acme/widget"}}',
        'dead', 4, NULL, 'preserve me', '2026-01-01T00:00:00.000Z'
      );
    `);
    for (const migration of databaseMigrations.filter((migration) => migration.version <= 35)) {
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT delivery_id, source, payload, status, attempts, next_attempt_at,
             last_error, redelivered_at, received_at
      FROM webhook_deliveries
    `).get()).toEqual({
      delivery_id: "legacy-dead",
      source: "github",
      payload: '{"repository":{"full_name":"acme/widget"}}',
      status: "dead",
      attempts: 4,
      next_attempt_at: null,
      last_error: "preserve me",
      redelivered_at: null,
      received_at: "2026-01-01T00:00:00.000Z",
    });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'github_webhook_redelivery_requests'
    `).get()).toEqual({ name: "github_webhook_redelivery_requests" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'github_webhook_redelivery_process_idx'
    `).get()).toEqual({ name: "github_webhook_redelivery_process_idx" });
    expect(db.prepare(`
      SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1
    `).get()).toEqual({
      version: 51,
      name: `steering-items-single-owner${ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX}`,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: databaseMigrations.length,
    });
  });

  it("backfills the provider activation fence when upgrading existing sessions", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        provider_conversation_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        superseded_at TEXT
      );
      INSERT INTO agent_sessions (
        id, ticket_id, generation, state, created_at, updated_at
      ) VALUES (
        'session-legacy', 'github:owner/repo#1', 1, 'current',
        '2026-08-11T00:05:00.987Z', '2026-08-11T00:05:00.987Z'
      );
    `);
    for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 36)) {
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-08-11T00:05:00.987Z')
      `).run(migration.version, migration.name, migration.checksum);
    }

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT provider_activated_at, provider_activation_id
      FROM agent_sessions WHERE id = 'session-legacy'
    `).get()).toEqual({
      provider_activated_at: "2026-08-11T00:05:00.987Z",
      provider_activation_id: null,
    });
    expect(db.prepare(`
      SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1
    `).get()).toEqual({
      version: 51,
      name: `steering-items-single-owner${ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX}`,
    });
  });

  it("adds epoch-fenced observation retry defaults to a v38 work-attempt table", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE execution_work_attempts (id TEXT PRIMARY KEY);
      INSERT INTO execution_work_attempts(id) VALUES ('legacy-action');
    `);
    for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 38)) {
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-08-11T00:05:00.987Z')
      `).run(migration.version, migration.name, migration.checksum);
    }

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT observation_failure_count, observation_retry_at, observation_epoch
      FROM execution_work_attempts WHERE id = 'legacy-action'
    `).get()).toEqual({
      observation_failure_count: 0,
      observation_retry_at: null,
      observation_epoch: 0,
    });
    expect(db.prepare(`
      SELECT name, "notnull", dflt_value
      FROM pragma_table_info('execution_work_attempts')
      WHERE name = 'observation_epoch'
    `).get()).toEqual({ name: "observation_epoch", notnull: 1, dflt_value: "0" });
  });

  it("adds the settings write-time column in v47 while retaining legacy rows unstamped", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO settings(key, value) VALUES ('github-supervisor-comment:1', 'control-session');
    `);
    for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 46)) {
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-08-14T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }

    applyDatabaseMigrations(db);

    expect(db.prepare("SELECT key, value, updated_at FROM settings").get()).toEqual({
      key: "github-supervisor-comment:1",
      value: "control-session",
      updated_at: null,
    });
    const settings = createSettingsStore(db);
    settings.setSetting("github-supervisor-comment:1", "control-session");
    const stamped = db.prepare(
      "SELECT updated_at FROM settings WHERE key = 'github-supervisor-comment:1'"
    ).get() as { updated_at: string | null };
    expect(stamped.updated_at).toBeTruthy();
    expect(Number.isNaN(Date.parse(stamped.updated_at!))).toBe(false);
  });

  it("adds the typed stop outcome to a v47 execution graph without disturbing legacy stop rows", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE execution_graphs (id TEXT PRIMARY KEY, stopped_at TEXT, stop_reason TEXT);
      INSERT INTO execution_graphs(id, stopped_at, stop_reason)
      VALUES ('legacy-graph', '2026-08-13T00:00:00.000Z', 'retryable_infrastructure_failure: legacy stop');
    `);
    for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 47)) {
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-08-13T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT stopped_at, stop_reason, stop_outcome FROM execution_graphs WHERE id = 'legacy-graph'
    `).get()).toEqual({
      stopped_at: "2026-08-13T00:00:00.000Z",
      stop_reason: "retryable_infrastructure_failure: legacy stop",
      stop_outcome: null,
    });
    expect(() => db!.prepare(
      "UPDATE execution_graphs SET stop_outcome = 'not-an-outcome' WHERE id = 'legacy-graph'"
    ).run()).toThrow(/CHECK constraint failed/);
  });

  // Migrations 34 and 35 issue PRAGMA foreign_keys from inside the runner's
  // exclusive transaction, where SQLite silently ignores it, so both actually
  // run with foreign keys ON. The next three fences pin the schema properties
  // that make that safe (see the notes beside the frozen sources in
  // definitions.ts).
  it("keeps the v34 publication/effect rebuild safe: no table declares foreign keys into the rebuilt tables", () => {
    db = openDb(":memory:");
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND (sql LIKE '%REFERENCES pipeline_publication_receipts%'
          OR sql LIKE '%REFERENCES pipeline_effect_intents%')
    `).all()).toEqual([]);
  });

  it("rewrites execution_publication_events' outbox reference through the v35 rename on a fresh database", () => {
    db = openDb(":memory:");
    const { sql } = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_publication_events'
    `).get() as { sql: string };
    expect(sql).toMatch(/REFERENCES "?control_outbox"?\s*\(/);
    expect(sql).not.toContain("linear_outbox");
  });

  it("rewrites a legacy linear_outbox reference in place when upgrading through v35", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE linear_outbox (
        id TEXT PRIMARY KEY,
        linear_session_id TEXT,
        linear_issue_id TEXT,
        run_id TEXT,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        processed_at TEXT,
        last_error TEXT,
        external_id TEXT,
        external_url TEXT,
        attachment_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE execution_publication_events (
        id TEXT PRIMARY KEY,
        linear_outbox_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(linear_outbox_id) REFERENCES linear_outbox(id) ON DELETE RESTRICT
      );
      INSERT INTO linear_outbox (
        id, linear_session_id, linear_issue_id, sequence, kind, payload,
        payload_hash, status, next_attempt_at, created_at
      ) VALUES (
        'outbox-1', 'session-1', 'issue-1', 1, 'activity', '{}', 'hash',
        'processed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO execution_publication_events (id, linear_outbox_id, body, created_at)
      VALUES ('event-1', 'outbox-1', 'published', '2026-01-01T00:00:00.000Z');
    `);
    for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 34)) {
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }

    applyDatabaseMigrations(db);

    const { sql } = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_publication_events'
    `).get() as { sql: string };
    // RENAME TO only rewrites other tables' REFERENCES clauses while foreign
    // keys are enabled. If the v35 pragma ever took effect, this reference
    // would still name the dropped linear_outbox table.
    expect(sql).toMatch(/REFERENCES "?control_outbox"?\s*\(/);
    expect(sql).not.toContain("linear_outbox");
    expect(db.prepare(`
      SELECT control_outbox_id FROM execution_publication_events WHERE id = 'event-1'
    `).get()).toEqual({ control_outbox_id: "outbox-1" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("commits a complete ledger that reopens idempotently from a real SQLite file", () => {
    const directory = mkdtempSync(join(tmpdir(), "openthrottle-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "supervisor.db");
    db = new Database(path);
    applyDatabaseMigrations(db);
    db.close();

    db = new Database(path);
    applyDatabaseMigrations(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: databaseMigrations.length,
    });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_deliveries'"
    ).get()).toEqual({ name: "work_deliveries" });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'steering_items'"
    ).get()).toEqual({ name: "steering_items" });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_journal'"
    ).get()).toEqual({ name: "orchestration_journal" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'orchestration_journal_issue_recorded_idx'
    `).get()).toEqual({ name: "orchestration_journal_issue_recorded_idx" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'orchestration_journal_issue_lower_recorded_idx'
    `).get()).toEqual({ name: "orchestration_journal_issue_lower_recorded_idx" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'orchestration_journal_repository_recorded_idx'
    `).get()).toEqual({ name: "orchestration_journal_repository_recorded_idx" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'orchestration_journal_repository_lower_recorded_idx'
    `).get()).toEqual({ name: "orchestration_journal_repository_lower_recorded_idx" });
    expect(db.prepare(`
      SELECT name FROM pragma_table_info('pipeline_instances') WHERE name = 'published_subject'
    `).get()).toEqual({ name: "published_subject" });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_units'"
    ).get()).toEqual({ name: "execution_units" });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_gate_receipts'"
    ).get()).toEqual({ name: "execution_gate_receipts" });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_downstream_context'"
    ).get()).toEqual({ name: "execution_downstream_context" });
    expect(db.prepare(`
      SELECT name FROM pragma_table_info('execution_graphs') WHERE name = 'stopped_at'
    `).get()).toEqual({ name: "stopped_at" });
    expect(db.prepare(`
      SELECT name FROM pragma_table_info('execution_graphs') WHERE name = 'stop_reason'
    `).get()).toEqual({ name: "stop_reason" });
    expect(db.prepare(`
      SELECT name FROM pragma_table_info('execution_graphs') WHERE name = 'stop_outcome'
    `).get()).toEqual({ name: "stop_outcome" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'execution_work_one_active_idx'
    `).get()).toEqual({ name: "execution_work_one_active_idx" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'execution_units_graph_status_idx'
    `).get()).toEqual({ name: "execution_units_graph_status_idx" });
    expect(db.prepare(`
      SELECT name, "notnull", dflt_value
      FROM pragma_table_info('execution_work_attempts')
      WHERE name = 'observation_epoch'
    `).get()).toEqual({ name: "observation_epoch", notnull: 1, dflt_value: "0" });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM pragma_foreign_key_list('execution_units')
      WHERE "table" = 'execution_graphs'
    `).get()).toEqual({ count: 3 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM pragma_foreign_key_list('execution_work_attempts')
      WHERE "table" = 'execution_units'
    `).get()).toEqual({ count: 5 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM pragma_foreign_key_list('execution_units')
      WHERE "table" = 'execution_work_attempts'
    `).get()).toEqual({ count: 6 });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tune_state'"
    ).get()).toEqual({ name: "tune_state" });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tune_state_intent_idx'"
    ).get()).toEqual({ name: "tune_state_intent_idx" });
  });

  it("restarts the tune-state migration after a partial pre-ledger interruption", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE tune_state (
        id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        intent_digest TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        proposal_digest TEXT NOT NULL UNIQUE,
        citation_decision_digest TEXT NOT NULL,
        ratchet_decision_digest TEXT NOT NULL,
        edit_authorization_digest TEXT NOT NULL,
        release_descriptor_digest TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'rejected', 'needs_human')),
        payload TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX tune_state_intent_idx ON tune_state(intent_digest, created_at);
    `);
    for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 40)) {
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-08-12T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }

    applyDatabaseMigrations(db);

    expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 41").get())
      .toEqual({ version: 41, name: "tune-state" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get())
      .toEqual({ count: databaseMigrations.length });
  });

  it("converges a freshly opened database on neutral live control identifiers", () => {
    db = openDb(":memory:");

    expect(db.prepare(`
      SELECT name FROM pragma_table_info('tickets') WHERE name = 'ticket_id'
    `).get()).toEqual({ name: "ticket_id" });
    expect(db.prepare(`
      SELECT name FROM pragma_table_info('tickets') WHERE name = 'linear_issue_id'
    `).get()).toBeUndefined();
    expect(db.prepare(`
      SELECT name FROM pragma_table_info('pipeline_instances') WHERE name = 'session_id'
    `).get()).toEqual({ name: "session_id" });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'control_outbox'"
    ).get()).toEqual({ name: "control_outbox" });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'linear_outbox'"
    ).get()).toBeUndefined();
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'pipeline_publications_process_idx'
    `).get()).toEqual({ name: "pipeline_publications_process_idx" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'pipeline_effects_pending_idx'
    `).get()).toEqual({ name: "pipeline_effects_pending_idx" });
    expect(() => db!.prepare(`
      INSERT INTO repository_registrations (
        github_repo, control_provider, linear_team_key, base_branch,
        webhook_id, snapshot, created_at, updated_at
      ) VALUES (
        'acme/missing-linear-team', 'linear', NULL, 'main', 1, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `).run()).toThrow();
  });

  it("does not recreate the retired Linear outbox after reopening a migrated database", () => {
    const directory = mkdtempSync(join(tmpdir(), "openthrottle-neutral-reopen-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "supervisor.db");

    db = openDb(path);
    db.close();
    db = openDb(path);

    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'control_outbox'"
    ).get()).toEqual({ name: "control_outbox" });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'linear_outbox'"
    ).get()).toBeUndefined();
  });

  it("rekeys retained legacy work rows before changing their ticket parent key", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE tickets (
        linear_issue_id TEXT PRIMARY KEY,
        linear_issue_identifier TEXT NOT NULL,
        linear_session_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        agent TEXT NOT NULL,
        repo TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        linear_issue_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(linear_issue_id, generation),
        FOREIGN KEY(linear_issue_id) REFERENCES tickets(linear_issue_id)
      );
      CREATE TABLE session_work (
        id TEXT PRIMARY KEY,
        linear_session_id TEXT NOT NULL,
        linear_issue_id TEXT NOT NULL,
        source TEXT NOT NULL,
        priority INTEGER NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        claimed_run_id TEXT,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        canceled_at TEXT,
        FOREIGN KEY(linear_session_id) REFERENCES agent_sessions(id),
        FOREIGN KEY(linear_issue_id) REFERENCES tickets(linear_issue_id)
      );
      INSERT INTO tickets (
        linear_issue_id, linear_issue_identifier, linear_session_id,
        branch, agent, repo, created_at, updated_at
      ) VALUES (
        'issue-legacy', 'OPE-1', 'session-legacy',
        'ot/ope-1', 'codex', 'owner/repo', '2026-01-01', '2026-01-01'
      );
      INSERT INTO agent_sessions (
        id, linear_issue_id, generation, state, created_at, updated_at
      ) VALUES (
        'session-legacy', 'issue-legacy', 1, 'current', '2026-01-01', '2026-01-01'
      );
      INSERT INTO session_work (
        id, linear_session_id, linear_issue_id, source, priority, body,
        status, claimed_run_id, available_at, created_at, consumed_at, canceled_at
      ) VALUES (
        'work-legacy', 'session-legacy', 'issue-legacy', 'human', 0, 'steer',
        'consumed', NULL, '2026-01-01', '2026-01-01', '2026-01-01', NULL
      );
    `);

    const migration = databaseMigrations.find((candidate) => candidate.version === 35)!;
    expect(() => db!.transaction(() => migration.up(db!))()).not.toThrow();

    expect(db.prepare(`
      SELECT ticket_id, session_id FROM session_work WHERE id = 'work-legacy'
    `).get()).toEqual({
      ticket_id: "linear:issue-legacy",
      session_id: "session-legacy",
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("rekeys the complete GitHub head fence without losing canonical or newer state", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tickets (
        linear_issue_id TEXT PRIMARY KEY,
        linear_issue_identifier TEXT NOT NULL,
        linear_session_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        agent TEXT NOT NULL,
        repo TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO tickets (
        linear_issue_id, linear_issue_identifier, linear_session_id,
        branch, agent, repo, created_at, updated_at
      ) VALUES
        ('issue-authoritative', 'OT-1', 'session-1', 'ot/ot-1', 'codex', 'owner/repo', '2026-01-01', '2026-01-01'),
        ('issue-sequenced', 'OT-2', 'session-2', 'ot/ot-2', 'codex', 'owner/repo', '2026-01-01', '2026-01-01'),
        ('issue-simple', 'OT-3', 'session-3', 'ot/ot-3', 'codex', 'owner/repo', '2026-01-01', '2026-01-01');
    `);
    const insertSetting = db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)");
    for (const [key, value] of [
      ["github-head:issue-authoritative", "authoritative-head"],
      ["github-head-source:issue-authoritative", "authoritative"],
      ["github-head-watermark:issue-authoritative:workflow_run", "41"],
      ["github-head:linear:issue-authoritative", "ci-head"],
      ["github-head-source:linear:issue-authoritative", JSON.stringify({ source: "workflow_run", sequence: 50 })],
      ["github-head-watermark:linear:issue-authoritative:workflow_run", "50"],
      ["github-head:issue-sequenced", "newer-head"],
      ["github-head-source:issue-sequenced", JSON.stringify({ source: "check_suite", sequence: 20 })],
      ["github-head-watermark:issue-sequenced:check_suite", "20"],
      ["github-head-watermark:issue-sequenced:deployment_status", "8"],
      ["github-head:linear:issue-sequenced", "older-head"],
      ["github-head-source:linear:issue-sequenced", JSON.stringify({ source: "check_suite", sequence: 10 })],
      ["github-head-watermark:linear:issue-sequenced:check_suite", "10"],
      ["github-head-watermark:linear:issue-sequenced:deployment_status", "12"],
      ["github-head:issue-simple", "simple-head"],
      ["github-head-source:issue-simple", JSON.stringify({ source: "workflow_run", sequence: 7 })],
      ["github-head-watermark:issue-simple:workflow_run", "7"],
    ] as const) {
      insertSetting.run(key, value);
    }

    const migration = databaseMigrations.find((candidate) => candidate.version === 35)!;
    migration.up(db);
    // The current settings store writes the v47 write-time column.
    databaseMigrations.find((candidate) => candidate.version === 47)!.up(db);

    const settings = createSettingsStore(db);
    expect(settings.getSetting("github-head:linear:issue-authoritative")).toBe("authoritative-head");
    expect(settings.getSetting("github-head-source:linear:issue-authoritative")).toBe("authoritative");
    expect(settings.getSetting("github-head-watermark:linear:issue-authoritative:workflow_run")).toBe("50");
    expect(settings.getSetting("github-head:linear:issue-sequenced")).toBe("newer-head");
    expect(settings.getSetting("github-head-source:linear:issue-sequenced")).toBe(
      JSON.stringify({ source: "check_suite", sequence: 20 })
    );
    expect(settings.getSetting("github-head-watermark:linear:issue-sequenced:check_suite")).toBe("20");
    expect(settings.getSetting("github-head-watermark:linear:issue-sequenced:deployment_status")).toBe("12");
    expect(settings.getSetting("github-head:linear:issue-simple")).toBe("simple-head");
    expect(settings.getSetting("github-head-source:linear:issue-simple")).toBe(
      JSON.stringify({ source: "workflow_run", sequence: 7 })
    );
    expect(settings.getSetting("github-head-watermark:linear:issue-simple:workflow_run")).toBe("7");
    expect(db.prepare(`
      SELECT key FROM settings
      WHERE key LIKE 'github-head:%' AND key NOT LIKE 'github-head:linear:%'
         OR key LIKE 'github-head-source:%' AND key NOT LIKE 'github-head-source:linear:%'
         OR key LIKE 'github-head-watermark:%' AND key NOT LIKE 'github-head-watermark:linear:%'
    `).all()).toEqual([]);

    considerCiGithubHead(
      settings as Parameters<typeof considerCiGithubHead>[0],
      "linear:issue-authoritative",
      "delayed-ci-head",
      "workflow_run",
      999
    );
    expect(settings.getSetting("github-head:linear:issue-authoritative")).toBe("authoritative-head");
    considerCiGithubHead(
      settings as Parameters<typeof considerCiGithubHead>[0],
      "linear:issue-sequenced",
      "stale-head",
      "check_suite",
      19
    );
    expect(settings.getSetting("github-head:linear:issue-sequenced")).toBe("newer-head");
    considerCiGithubHead(
      settings as Parameters<typeof considerCiGithubHead>[0],
      "linear:issue-sequenced",
      "fresh-head",
      "check_suite",
      21
    );
    expect(settings.getSetting("github-head:linear:issue-sequenced")).toBe("fresh-head");

    const once = db.prepare("SELECT key, value FROM settings ORDER BY key").all();
    migration.up(db);
    expect(db.prepare("SELECT key, value FROM settings ORDER BY key").all()).toEqual(once);
  });

  it("rekeys legacy journal display references without breaking structured review lineage", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tickets (
        linear_issue_id TEXT PRIMARY KEY,
        linear_issue_identifier TEXT NOT NULL,
        linear_session_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        agent TEXT NOT NULL,
        repo TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE pipeline_instances (
        id TEXT PRIMARY KEY,
        linear_issue_id TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        linear_issue_id TEXT NOT NULL
      );
      CREATE TABLE orchestration_journal (
        id TEXT PRIMARY KEY,
        recorded_at TEXT NOT NULL,
        team TEXT NOT NULL,
        repository TEXT NOT NULL,
        issue TEXT NOT NULL,
        instance_id TEXT,
        run_id TEXT,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        trigger TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT,
        refs TEXT NOT NULL,
        note TEXT,
        structured TEXT
      );
      INSERT INTO tickets (
        linear_issue_id, linear_issue_identifier, linear_session_id,
        branch, agent, repo, created_at, updated_at
      ) VALUES
        ('issue-a', 'OT-188', 'session-a', 'ot/a', 'codex', 'owner/repo', '2026-01-01', '2026-01-01'),
        ('issue-b', 'OT-188', 'session-b', 'ot/b', 'codex', 'owner/repo', '2026-01-01', '2026-01-01'),
        ('issue-unique', 'OT-200', 'session-unique', 'ot/unique', 'codex', 'owner/repo', '2026-01-01', '2026-01-01');
      INSERT INTO pipeline_instances (id, linear_issue_id) VALUES
        ('instance-a', 'issue-a'),
        ('instance-b', 'issue-b');
      INSERT INTO runs (id, linear_issue_id) VALUES
        ('run-a', 'issue-a'),
        ('run-b', 'issue-b');
      INSERT INTO orchestration_journal (
        id, recorded_at, team, repository, issue, instance_id, run_id,
        actor, kind, trigger, action, outcome, refs, note, structured
      ) VALUES
        (
          'review-cycle-1', '2026-01-01T00:00:01.000Z', 'OT', 'owner/repo', 'OT-188',
          'instance-a', 'run-a', 'supervisor', 'run_note', 'structured_review_fanout',
          'Recorded review cycle one.', 'success', '{}', NULL,
          '{"finding_resolutions":[{"convergence_cycle":1}],"marker":"cycle-1"}'
        ),
        (
          'review-cycle-2', '2026-01-01T00:00:02.000Z', 'OT', 'owner/repo', 'OT-188',
          'instance-a', 'run-a', 'supervisor', 'run_note', 'structured_review_fanout',
          'Resumed review with prior lineage.', 'success', '{}', NULL,
          '{"finding_resolutions":[{"convergence_cycle":2}],"marker":"cycle-2"}'
        ),
        (
          'other-ticket-review', '2026-01-01T00:00:03.000Z', 'OT', 'owner/repo', 'OT-188',
          'instance-b', 'run-b', 'supervisor', 'run_note', 'structured_review_fanout',
          'Recorded the colliding display reference.', 'success', '{}', NULL,
          '{"finding_resolutions":[{"convergence_cycle":1}],"marker":"other"}'
        ),
        (
          'run-only', '2026-01-01T00:00:04.000Z', 'OT', 'owner/repo', 'OT-188',
          NULL, 'run-a', 'supervisor', 'run_note', 'run-bound',
          'Mapped through the run fence.', 'success', '{}', NULL, NULL
        ),
        (
          'unique-ticket', '2026-01-01T00:00:05.000Z', 'OT', 'owner/repo', 'OT-200',
          NULL, NULL, 'supervisor', 'run_note', 'ticket-bound',
          'Mapped through the unique ticket reference.', 'success', '{}', NULL, NULL
        );
    `);

    const migration = databaseMigrations.find((candidate) => candidate.version === 35)!;
    migration.up(db);

    const journal = createJournalStore(db, () => "2026-01-02T00:00:00.000Z");
    const issueAEntries = journal.listJournalEntries({ issueId: "linear:issue-a", limit: 100 });
    expect(issueAEntries.map((entry) => entry.id)).toEqual([
      "review-cycle-1",
      "review-cycle-2",
      "run-only",
    ]);
    expect(issueAEntries.filter((entry) =>
      entry.instance_id === "instance-a" &&
      entry.run_id === "run-a" &&
      entry.trigger === "structured_review_fanout"
    ).map((entry) => entry.structured)).toEqual([
      '{"finding_resolutions":[{"convergence_cycle":1}],"marker":"cycle-1"}',
      '{"finding_resolutions":[{"convergence_cycle":2}],"marker":"cycle-2"}',
    ]);
    expect(journal.listJournalEntries({ issueId: "linear:issue-b" }).map((entry) => entry.id))
      .toEqual(["other-ticket-review"]);
    expect(journal.listJournalEntries({ issueId: "linear:issue-unique" }).map((entry) => entry.id))
      .toEqual(["unique-ticket"]);
    expect(journal.listJournalEntries({ issue: "OT-188" })).toEqual([]);

    const once = db.prepare(`
      SELECT id, issue, structured FROM orchestration_journal ORDER BY id
    `).all();
    migration.up(db);
    expect(db.prepare(`
      SELECT id, issue, structured FROM orchestration_journal ORDER BY id
    `).all()).toEqual(once);
  });

  it("fails v35 before guessing an ambiguous unbound journal identity", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tickets (
        linear_issue_id TEXT PRIMARY KEY,
        linear_issue_identifier TEXT NOT NULL,
        linear_session_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        agent TEXT NOT NULL,
        repo TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE orchestration_journal (
        id TEXT PRIMARY KEY,
        recorded_at TEXT NOT NULL,
        team TEXT NOT NULL,
        repository TEXT NOT NULL,
        issue TEXT NOT NULL,
        instance_id TEXT,
        run_id TEXT,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        trigger TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT,
        refs TEXT NOT NULL,
        note TEXT,
        structured TEXT
      );
      INSERT INTO tickets (
        linear_issue_id, linear_issue_identifier, linear_session_id,
        branch, agent, repo, created_at, updated_at
      ) VALUES
        ('issue-a', 'OT-188', 'session-a', 'ot/a', 'codex', 'owner/repo', '2026-01-01', '2026-01-01'),
        ('issue-b', 'OT-188', 'session-b', 'ot/b', 'codex', 'owner/repo', '2026-01-01', '2026-01-01');
      INSERT INTO orchestration_journal (
        id, recorded_at, team, repository, issue, instance_id, run_id,
        actor, kind, trigger, action, outcome, refs, note, structured
      ) VALUES (
        'ambiguous', '2026-01-01T00:00:01.000Z', 'OT', 'owner/repo', 'OT-188',
        NULL, NULL, 'supervisor', 'run_note', 'test', 'Ambiguous legacy row.',
        'success', '{}', NULL, NULL
      );
    `);

    const migration = databaseMigrations.find((candidate) => candidate.version === 35)!;
    expect(() => migration.up(db!)).toThrow(/ambiguous legacy orchestration journal issue ambiguous/);
    expect(db.prepare("SELECT issue FROM orchestration_journal WHERE id = 'ambiguous'").get())
      .toEqual({ issue: "OT-188" });
  });

  it("migrates repository registrations to provider-qualified repo authority", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE repository_registrations (
        linear_team_key TEXT PRIMARY KEY COLLATE NOCASE,
        linear_team_id TEXT UNIQUE,
        github_repo TEXT NOT NULL COLLATE NOCASE,
        base_branch TEXT NOT NULL,
        webhook_id INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO repository_registrations (
        linear_team_key, linear_team_id, github_repo, base_branch,
        webhook_id, snapshot, created_at, updated_at
      ) VALUES
      (
        'ENG', 'team-1', 'acme/widget', 'main', 42,
        'openthrottle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'OPS', 'team-2', 'ACME/WIDGET', 'release', 43,
        'newer-route', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
      );
    `);

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT github_repo, control_provider, linear_team_key, linear_team_id
      FROM repository_registrations
    `).get()).toEqual({
      github_repo: "ACME/WIDGET",
      control_provider: "linear",
      linear_team_key: "OPS",
      linear_team_id: "team-2",
    });
    expect(db.prepare(`
      SELECT name FROM pragma_table_info('repository_registrations') WHERE pk = 1
    `).get()).toEqual({ name: "github_repo" });
    expect(db.prepare(`
      SELECT name FROM pragma_index_list('repository_registrations')
      WHERE name = 'repository_registrations_linear_team_key_idx'
    `).get()).toEqual({ name: "repository_registrations_linear_team_key_idx" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("opens a legacy registration database before creating provider-qualified indexes", () => {
    const directory = mkdtempSync(join(tmpdir(), "openthrottle-registration-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "supervisor.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE repository_registrations (
        linear_team_key TEXT PRIMARY KEY COLLATE NOCASE,
        linear_team_id TEXT UNIQUE,
        github_repo TEXT NOT NULL COLLATE NOCASE,
        base_branch TEXT NOT NULL,
        webhook_id INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO repository_registrations (
        linear_team_key, linear_team_id, github_repo, base_branch,
        webhook_id, snapshot, created_at, updated_at
      ) VALUES (
        'ENG', 'team-1', 'acme/widget', 'main', 42,
        'openthrottle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    db = openDb(path);

    expect(db.prepare(`
      SELECT github_repo, control_provider, linear_team_key, linear_team_id
      FROM repository_registrations
    `).get()).toEqual({
      github_repo: "acme/widget",
      control_provider: "linear",
      linear_team_key: "ENG",
      linear_team_id: "team-1",
    });
    expect(db.prepare(`
      SELECT name FROM pragma_index_list('repository_registrations')
      WHERE name = 'repository_registrations_linear_team_key_idx'
    `).get()).toEqual({ name: "repository_registrations_linear_team_key_idx" });
    expect(db.prepare(`
      SELECT name FROM pragma_index_list('repository_registrations')
      WHERE name = 'repository_registrations_linear_team_id_idx'
    `).get()).toEqual({ name: "repository_registrations_linear_team_id_idx" });
  });

  it("does not stamp v18 when composite identity prerequisites are missing", () => {
    const scenarios = [
      {
        schema: `
          CREATE TABLE pipeline_instances (id TEXT PRIMARY KEY);
          CREATE TABLE pipeline_stage_attempts (
            id TEXT PRIMARY KEY,
            pipeline_instance_id TEXT NOT NULL,
            planned_run_id TEXT
          );
          CREATE TABLE execution_graphs (id TEXT PRIMARY KEY);
          CREATE TABLE execution_work_attempts (id TEXT PRIMARY KEY);
          CREATE TABLE execution_gate_receipts (id TEXT PRIMARY KEY);
          CREATE TABLE execution_downstream_context (id TEXT PRIMARY KEY);
        `,
        error: /missing execution_units/,
      },
      {
        schema: `
          CREATE TABLE pipeline_instances (id TEXT PRIMARY KEY);
          CREATE TABLE pipeline_stage_attempts (
            id TEXT PRIMARY KEY,
            pipeline_instance_id TEXT NOT NULL
          );
          CREATE TABLE execution_graphs (id TEXT PRIMARY KEY);
          CREATE TABLE execution_units (id TEXT PRIMARY KEY);
          CREATE TABLE execution_work_attempts (id TEXT PRIMARY KEY);
          CREATE TABLE execution_gate_receipts (id TEXT PRIMARY KEY);
          CREATE TABLE execution_downstream_context (id TEXT PRIMARY KEY);
        `,
        error: /missing pipeline_stage_attempts\.planned_run_id/,
      },
    ];

    for (const scenario of scenarios) {
      db = new Database(":memory:");
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        ${scenario.schema}
      `);
      for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 17)) {
        db.prepare(`
          INSERT INTO schema_migrations(version, name, checksum, applied_at)
          VALUES (?, ?, ?, '2026-07-29T00:00:00.000Z')
        `).run(migration.version, migration.name, migration.checksum);
      }

      expect(() => applyDatabaseMigrations(db!)).toThrow(scenario.error);
      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 18").get()).toBeUndefined();
      db.close();
      db = undefined;
    }
  });

  it("preserves valid active child pointers while rebuilding the composite identity", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 17)) {
      migration.up(db);
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-07-29T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }
    const now = "2026-07-29T00:00:00.000Z";
    db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        linear_issue_id TEXT PRIMARY KEY,
        linear_issue_identifier TEXT NOT NULL,
        linear_session_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        agent TEXT NOT NULL,
        repo TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        linear_issue_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(id, linear_issue_id, generation)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        linear_issue_id TEXT NOT NULL,
        linear_session_id TEXT NOT NULL,
        session_generation INTEGER NOT NULL,
        task_type TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        expires_at TEXT
      );
      INSERT INTO tickets (
        linear_issue_id, linear_issue_identifier, linear_session_id, branch, agent,
        repo, base_branch, created_at, updated_at
      ) VALUES ('issue-1', 'OPE-1', 'session-1', 'ot/ope-1', 'codex', 'owner/repo', 'main', '${now}', '${now}');
      INSERT INTO agent_sessions (
        id, linear_issue_id, generation, state, created_at, updated_at
      ) VALUES ('session-1', 'issue-1', 1, 'current', '${now}', '${now}');
      INSERT INTO runs (
        id, linear_issue_id, linear_session_id, session_generation, task_type,
        token_hash, status, started_at, expires_at
      ) VALUES (
        'run-parent', 'issue-1', 'session-1', 1, 'implement', 'request-hash',
        'running', '${now}', '2026-07-29T01:00:00.000Z'
      );
      INSERT INTO repository_config_snapshots (
        id, repository, base_commit, blob_sha, digest, normalized_config, created_at
      ) VALUES ('config-1', 'owner/repo', '${"a".repeat(40)}', '${"b".repeat(40)}', '${"c".repeat(64)}', '{}', '${now}');
      INSERT INTO runtime_capability_descriptors (
        runtime_release, digest, protocol, normalized_descriptor, accepted_at
      ) VALUES ('runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '{}', '${now}');
      INSERT INTO pipeline_catalog_entries (
        pipeline_id, version, digest, normalized_manifest, accepted_at
      ) VALUES ('structured', 1, '${"e".repeat(64)}', '{}', '${now}');
      INSERT INTO pipeline_instances (
        id, linear_issue_id, linear_session_id, generation, pipeline_id, pipeline_version,
        manifest_digest, normalized_manifest, repository, base_commit, branch,
        repository_config_snapshot_id, repository_config_digest, runtime_release, capability_digest,
        executor_protocol, authorized_capabilities, status, active_stage_id, state_version,
        attempt_count, created_at, updated_at
      ) VALUES (
        'instance-1', 'issue-1', 'session-1', 1, 'structured', 1, '${"e".repeat(64)}',
        '{}', 'owner/repo', '${"a".repeat(40)}', 'ot/ope-1', 'config-1', '${"c".repeat(64)}',
        'runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '[]', 'running',
        'units', 1, 1, '${now}', '${now}'
      );
      INSERT INTO pipeline_instance_stages (
        pipeline_instance_id, stage_id, ordinal, status, attempt_count, created_at, updated_at
      ) VALUES ('instance-1', 'units', 1, 'running', 1, '${now}', '${now}');
      INSERT INTO pipeline_stage_attempts (
        id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
        request_hash, idempotency_key, context_revision, native_context_policy,
        planned_run_id, run_id, status, created_at, updated_at
      ) VALUES (
        'attempt-parent', 'instance-1', 'units', 1, 0, '${"f".repeat(64)}',
        'attempt-key', 0, 'none', 'run-parent', 'run-parent', 'running', '${now}', '${now}'
      );
      INSERT INTO execution_graphs (
        id, pipeline_instance_id, parent_attempt_id, parent_stage_id, parent_run_id,
        graph_digest, plan_digest, created_at, updated_at
      ) VALUES (
        'graph-1', 'instance-1', 'attempt-parent', 'units', 'run-parent',
        'graph-digest', 'plan-digest', '${now}', '${now}'
      );
      INSERT INTO execution_units (
        id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id,
        authored_order, dependency_unit_ids, status, active_work_attempt_id,
        created_at, updated_at
      ) VALUES (
        'unit-1', 'graph-1', 'instance-1', 'attempt-parent', 'a',
        0, '[]', 'running', 'action-1', '${now}', '${now}'
      );
      INSERT INTO execution_work_attempts (
        id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id,
        parent_run_id, unit_id, attempt_ordinal, action_kind, idempotency_key,
        status, payload, created_at, updated_at
      ) VALUES (
        'action-1', 'graph-1', 'unit-1', 'instance-1', 'attempt-parent',
        'run-parent', 'a', 1, 'implement', 'action-key-1',
        'leased', '{}', '${now}', '${now}'
      );
    `);

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT active_work_attempt_id FROM execution_units
      WHERE id = 'unit-1'
    `).get()).toEqual({ active_work_attempt_id: "action-1" });
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 18").get()).toEqual({
      version: 18,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    const store = createExecutionUnitStore(db, () => now);
    expect(store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings(),
    })).toMatchObject({
      unit_phases: canonicalJson([]),
      unit_phase_bindings: canonicalJson([]),
    });
    expect(() => store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings().filter((binding) => binding.id !== "simplify"),
    })).toThrow(/replay fence mismatch/);
  });

  it("upgrades databases already stamped with the immutable v16 checksum through v17", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 16)) {
      migration.up(db);
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-07-29T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_gate_receipts'"
    ).get()).toBeUndefined();

    applyDatabaseMigrations(db);

    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_gate_receipts'"
    ).get()).toEqual({ name: "execution_gate_receipts" });
    expect(db.prepare(`
      SELECT name FROM pragma_table_info('execution_graphs') WHERE name = 'stopped_at'
    `).get()).toEqual({ name: "stopped_at" });
    expect(db.prepare(
      "SELECT version, checksum FROM schema_migrations WHERE version = 17"
    ).get()).toEqual({ version: 17, checksum: databaseMigrations[16]!.checksum });
  });

  it("persists execution graph result artifacts after the child reducer migration", () => {
    db = openDb(":memory:");
    const now = "2026-07-29T00:00:00.000Z";
    db.exec(`
      INSERT INTO tickets (
        ticket_id, ticket_reference, session_id, branch, agent,
        repo, base_branch, created_at, updated_at
      ) VALUES ('issue-1', 'OPE-1', 'session-1', 'ot/ope-1', 'codex', 'owner/repo', 'main', '${now}', '${now}');
      INSERT INTO agent_sessions (
        id, ticket_id, generation, state, created_at, updated_at
      ) VALUES ('session-1', 'issue-1', 1, 'current', '${now}', '${now}');
      INSERT INTO runs (
        id, ticket_id, session_id, session_generation, task_type,
        token_hash, status, started_at, expires_at
      ) VALUES (
        'run-parent', 'issue-1', 'session-1', 1, 'implement', 'request-hash',
        'running', '${now}', '2026-07-29T01:00:00.000Z'
      );
      INSERT INTO repository_config_snapshots (
        id, repository, base_commit, blob_sha, digest, normalized_config, created_at
      ) VALUES ('config-1', 'owner/repo', '${"a".repeat(40)}', '${"b".repeat(40)}', '${"c".repeat(64)}', '{}', '${now}');
      INSERT INTO runtime_capability_descriptors (
        runtime_release, digest, protocol, normalized_descriptor, accepted_at
      ) VALUES ('runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '{}', '${now}');
      INSERT INTO pipeline_catalog_entries (
        pipeline_id, version, digest, normalized_manifest, accepted_at
      ) VALUES ('structured', 1, '${"e".repeat(64)}', '{}', '${now}');
      INSERT INTO pipeline_instances (
        id, ticket_id, session_id, generation, pipeline_id, pipeline_version,
        manifest_digest, normalized_manifest, repository, base_commit, branch,
        repository_config_snapshot_id, repository_config_digest, runtime_release, capability_digest,
        executor_protocol, authorized_capabilities, status, active_stage_id, state_version,
        attempt_count, created_at, updated_at
      ) VALUES (
        'instance-1', 'issue-1', 'session-1', 1, 'structured', 1, '${"e".repeat(64)}',
        '{}', 'owner/repo', '${"a".repeat(40)}', 'ot/ope-1', 'config-1', '${"c".repeat(64)}',
        'runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '[]', 'running',
        'units', 1, 1, '${now}', '${now}'
      );
      INSERT INTO pipeline_instance_stages (
        pipeline_instance_id, stage_id, ordinal, status, attempt_count, created_at, updated_at
      ) VALUES ('instance-1', 'units', 1, 'running', 1, '${now}', '${now}');
      INSERT INTO pipeline_stage_attempts (
        id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
        request_hash, idempotency_key, context_revision, native_context_policy,
        planned_run_id, run_id, status, created_at, updated_at
      ) VALUES (
        'attempt-parent', 'instance-1', 'units', 1, 0, '${"f".repeat(64)}',
        'attempt-key', 0, 'none', 'run-parent', 'run-parent', 'running', '${now}', '${now}'
      );
    `);

    expect(() => db!.prepare(`
      INSERT INTO pipeline_artifacts (
        id, pipeline_instance_id, attempt_id, kind, schema_version,
        assurance, subject, payload, artifact_hash, created_at
      ) VALUES (
        'artifact-graph-result', 'instance-1', 'attempt-parent', 'execution_graph_result',
        1, 'executor_verified', '${"a".repeat(40)}', '{}', '${"b".repeat(64)}', '${now}'
      )
    `).run()).not.toThrow();
  });

  it(`reopens a v46 database under the v45 migration authority from ${PREDECESSOR_RELEASE_COMMIT.slice(0, 7)}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "openthrottle-v46-reopen-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "supervisor.db");
    const predecessorMigrations = databaseMigrations.filter(
      (migration) => migration.version <= PREDECESSOR_MIGRATION_VERSION
    );

    // This is the migration authority shipped by the exact release immediately
    // preceding v46. The digest prevents this proof from silently following a
    // later edit to the current catalog while the production runner seam keeps
    // the runtime behavior identical to normal supervisor startup.
    expect(predecessorMigrations.at(-1)).toMatchObject({
      version: PREDECESSOR_MIGRATION_VERSION,
      name: "supervisor-maintenance-admission-epoch",
      checksum: "072679bbc79c4a0f930e8d56be07c4a1a4a124014c0e1453be9709306765a197",
    });
    expect(migrationCatalogDigest(predecessorMigrations))
      .toBe(PREDECESSOR_MIGRATION_CATALOG_SHA256);

    db = openDb(path);
    const v46 = databaseMigrations.find((migration) => migration.version === 46)!;
    expect(v46.name).toBe(`deployment-cutover-transaction${ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX}`);
    expect(db.prepare("SELECT version, name, checksum FROM schema_migrations WHERE version = 46").get())
      .toEqual({ version: 46, name: v46.name, checksum: v46.checksum });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deployment_cutovers'").get())
      .toEqual({ name: "deployment_cutovers" });
    db.close();
    db = undefined;

    db = new Database(path);
    db.pragma("foreign_keys = ON");
    applyDatabaseMigrationsForAuthority(db, {
      migrations: predecessorMigrations,
      rollbackCompatibleMigrationNameSuffix:
        PREDECESSOR_ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX,
    });
    const settings = createSettingsStore(db);
    settings.setSetting("rollback-compatible-v46-reopen-test", "opened");
    expect(settings.getSetting("rollback-compatible-v46-reopen-test")).toBe("opened");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deployment_cutovers'").get())
      .toEqual({ name: "deployment_cutovers" });
    db.prepare("UPDATE schema_migrations SET name = ? WHERE version = 46")
      .run("deployment-cutover-transaction [rollback-compatible:additive/v2]");
    expect(() => applyDatabaseMigrationsForAuthority(db!, {
      migrations: predecessorMigrations,
      rollbackCompatibleMigrationNameSuffix:
        PREDECESSOR_ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX,
    })).toThrow(/incompatible newer schema version 46/i);
  });

  it("rejects an unmarked protected migration before touching SQLite", () => {
    db = new Database(":memory:");
    expect(() => applyDatabaseMigrationsForAuthority(db!, {
      migrations: [{
        version: 47,
        name: "unsafe-future-migration",
        source: "CREATE TABLE unsafe (id TEXT);",
        checksum: "unsafe",
        up(database) {
          database.exec("CREATE TABLE unsafe (id TEXT)");
        },
      }],
      rollbackCompatibleMigrationNameSuffix: ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX,
    })).toThrow(/migration 47 is not rollback-compatible/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'unsafe'").get()).toBeUndefined();
  });

  it("creates only the missing deployment cutover index when the table already exists", () => {
    db = new Database(":memory:");
    const createdAt = "2026-08-14T00:00:00.000Z";
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE deployment_cutovers (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO deployment_cutovers(id, status, created_at)
      VALUES ('cutover-existing', 'active', '${createdAt}');
    `);
    for (const migration of databaseMigrations.filter(
      (candidate) => candidate.version <= PREDECESSOR_MIGRATION_VERSION
    )) {
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-08-14T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }

    applyDatabaseMigrations(db);

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'deployment_cutovers_open_idx'").get())
      .toEqual({ name: "deployment_cutovers_open_idx" });
    expect(db.prepare("SELECT id, status, created_at FROM deployment_cutovers").get()).toEqual({
      id: "cutover-existing",
      status: "active",
      created_at: createdAt,
    });
  });

  it("fails closed on incompatible future migration ledger rows", () => {
    const latestKnown = databaseMigrations.at(-1)!;
    const incompatibleFutureRows = [
      {
        name: "unmarked future",
        rows: [{ version: latestKnown.version + 1, name: "future", checksum: "x" }],
        error: /incompatible newer schema version/i,
      },
      {
        name: "malformed marker",
        rows: [{ version: latestKnown.version + 1, name: "future [rollback-compatible:additive/v2]", checksum: "x" }],
        error: /incompatible newer schema version/i,
      },
      {
        name: "mixed marked and unmarked future rows",
        rows: [
          {
            version: latestKnown.version + 1,
            name: `future-additive${ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX}`,
            checksum: "x",
          },
          { version: latestKnown.version + 2, name: "future-unmarked", checksum: "y" },
        ],
        error: /incompatible newer schema version/i,
      },
    ];

    for (const scenario of incompatibleFutureRows) {
      db = new Database(":memory:");
      applyDatabaseMigrations(db);
      for (const row of scenario.rows) {
        db.prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')"
        ).run(row.version, row.name, row.checksum);
      }
      expect(() => applyDatabaseMigrations(db!), scenario.name).toThrow(scenario.error);
      db.close();
      db = undefined;
    }
  });

  it("fails closed on marked future migrations when a known migration is missing", () => {
    db = openDb(":memory:");
    const latestKnown = databaseMigrations.at(-1)!;
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(latestKnown.version);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')"
    ).run(
      latestKnown.version + 1,
      `future-additive${ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX}`,
      "future-checksum"
    );

    expect(() => applyDatabaseMigrations(db!)).toThrow(
      new RegExp(`missing known schema migration ${latestKnown.version}`)
    );
  });

  it("fails closed on a known migration name or checksum mismatch", () => {
    db = new Database(":memory:");
    applyDatabaseMigrations(db);
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    expect(() => applyDatabaseMigrations(db!)).toThrow(/checksum mismatch/i);

    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run(
      databaseMigrations[0].checksum
    );
    db.prepare("UPDATE schema_migrations SET name = 'renamed' WHERE version = 1").run();
    expect(() => applyDatabaseMigrations(db!)).toThrow(/checksum mismatch/i);
  });

  it("widens pipeline idle effects without losing queued effect data", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    for (const migration of databaseMigrations.slice(0, 10)) {
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }
    db.exec(`
      CREATE TABLE pipeline_instances (id TEXT PRIMARY KEY);
      INSERT INTO pipeline_instances VALUES ('instance-1');
      CREATE TABLE pipeline_stage_attempts (
        id TEXT PRIMARY KEY,
        pipeline_instance_id TEXT,
        planned_run_id TEXT
      );
      CREATE TABLE pipeline_effect_intents (
        id TEXT PRIMARY KEY,
        pipeline_instance_id TEXT NOT NULL,
        transition_version INTEGER NOT NULL CHECK(transition_version >= 1),
        kind TEXT NOT NULL CHECK(kind IN (
          'provision', 'bootstrap', 'dispatch_stage', 'stop', 'quarantine', 'cleanup',
          'publish_control', 'publish_github', 'publish_pr'
        )),
        idempotency_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'acknowledged', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT,
        last_error TEXT,
        FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
        UNIQUE(pipeline_instance_id, transition_version, kind, idempotency_key)
      );
      CREATE INDEX pipeline_effects_pending_idx ON pipeline_effect_intents(status, next_attempt_at);
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, attempts, next_attempt_at, created_at,
        acknowledged_at, last_error
      ) VALUES (
        'dispatch-1', 'instance-1', 1, 'dispatch_stage', 'dispatch-key',
        '{"dispatch":true}', 'hash-1', 'failed', 3, '2026-01-01T00:00:01.000Z',
        '2026-01-01T00:00:00.000Z', NULL, 'retry me'
      );
    `);

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, attempts, next_attempt_at, created_at,
        acknowledged_at, last_error
      FROM pipeline_effect_intents WHERE id = 'dispatch-1'
    `).get()).toEqual({
      id: "dispatch-1",
      pipeline_instance_id: "instance-1",
      transition_version: 1,
      kind: "dispatch_stage",
      idempotency_key: "dispatch-key",
      payload: "{\"dispatch\":true}",
      payload_hash: "hash-1",
      status: "failed",
      attempts: 3,
      next_attempt_at: "2026-01-01T00:00:01.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      acknowledged_at: null,
      last_error: "retry me",
    });
    expect(() => db!.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, next_attempt_at, created_at
      ) VALUES (
        'idle-1', 'instance-1', 2, 'idle', 'idle-key', '{}', 'hash-2',
        'pending', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'
      )
    `).run()).not.toThrow();
    expect(() => db!.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, next_attempt_at, created_at
      ) VALUES (
        'invalid-1', 'instance-1', 3, 'invalid', 'invalid-key', '{}', 'hash-3',
        'pending', '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z'
      )
    `).run()).toThrow();
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'pipeline_effect_intents' AND name = 'pipeline_effects_pending_idx'
    `).get()).toEqual({ name: "pipeline_effects_pending_idx" });
  });

  it("backfills liveness ownership for a pre-upgrade active actor", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL);
      INSERT INTO runs VALUES ('legacy-running', 'running', '2026-01-01T00:00:00.000Z');
      INSERT INTO runs VALUES ('legacy-complete', 'completed', '2025-01-01T00:00:00.000Z');
    `);

    applyDatabaseMigrations(db);

    // The intermediate run_liveness backfill fed the migration-14 fold below
    // and the satellite itself is retired by migration 49.
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_liveness'"
    ).get()).toBeUndefined();
    expect(db.prepare(`
      SELECT id, actor_state FROM runs ORDER BY id
    `).all()).toEqual([
      { id: "legacy-complete", actor_state: "settled" },
      { id: "legacy-running", actor_state: "running" },
    ]);
  });

  it("backfills pipeline attempt actors from legacy liveness state", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    for (const migration of databaseMigrations.slice(0, 8)) {
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE pipeline_instances (id TEXT PRIMARY KEY);
      CREATE TABLE run_liveness (
        run_id TEXT PRIMARY KEY, actor_state TEXT NOT NULL,
        last_heartbeat_at TEXT, settlement_owner TEXT, settlement_reason TEXT,
        termination_confirmed_at TEXT, quarantine_reason TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE pipeline_stage_attempts (
        id TEXT PRIMARY KEY, pipeline_instance_id TEXT, run_id TEXT, planned_run_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO runs VALUES ('run-bound', 'running', '2026-01-01T00:00:00.000Z', NULL);
      INSERT INTO runs VALUES ('run-planned', 'reaping', '2026-01-01T00:00:01.000Z', NULL);
      INSERT INTO runs VALUES ('run-quarantined', 'quarantined', '2026-01-01T00:00:02.000Z', NULL);
      INSERT INTO runs VALUES (
        'run-settled', 'completed', '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:09.000Z'
      );
      INSERT INTO run_liveness VALUES (
        'run-bound', 'running', '2026-01-01T00:00:02.000Z', NULL, NULL, NULL, NULL,
        '2026-01-01T00:00:03.000Z'
      );
      INSERT INTO run_liveness VALUES (
        'run-planned', 'reaping', '2026-01-01T00:00:04.000Z', 'owner-1',
        'stalled', NULL, NULL, '2026-01-01T00:00:05.000Z'
      );
      INSERT INTO run_liveness VALUES (
        'run-quarantined', 'quarantined', '2026-01-01T00:00:06.000Z', 'owner-2',
        'stalled', NULL, 'stop unconfirmed', '2026-01-01T00:00:07.000Z'
      );
      INSERT INTO run_liveness VALUES (
        'run-settled', 'settled', '2026-01-01T00:00:08.000Z', 'owner-3',
        'completed', '2026-01-01T00:00:09.000Z', NULL, '2026-01-01T00:00:09.000Z'
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-bound', NULL, 'run-bound', 'run-bound',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-planned', NULL, NULL, 'run-planned',
        '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-quarantined', NULL, 'run-quarantined', 'run-quarantined',
        '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-settled', NULL, 'run-settled', 'run-settled',
        '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z'
      );
    `);

    applyDatabaseMigrations(db);

    // The intermediate pipeline_attempt_actors backfill fed the owner-row fold
    // asserted below and the satellite itself is retired by migration 49; the
    // attempt-side actor mirror is dropped by migration 50, leaving the run
    // rows as the single surviving owner of the folded lifecycle state.
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_attempt_actors'"
    ).get()).toBeUndefined();
    expect(
      (db.prepare("PRAGMA table_info(pipeline_stage_attempts)").all() as Array<{ name: string }>)
        .map((column) => column.name)
    ).not.toContain("actor_state");
    expect(db.prepare(`
      SELECT id, actor_state, last_heartbeat_at, settlement_owner,
        settlement_reason, termination_confirmed_at, quarantine_reason
      FROM runs ORDER BY id
    `).all()).toEqual([
      {
        id: "run-bound",
        actor_state: "running",
        last_heartbeat_at: "2026-01-01T00:00:02.000Z",
        settlement_owner: null,
        settlement_reason: null,
        termination_confirmed_at: null,
        quarantine_reason: null,
      },
      {
        id: "run-planned",
        actor_state: "reaping",
        last_heartbeat_at: "2026-01-01T00:00:04.000Z",
        settlement_owner: "owner-1",
        settlement_reason: "stalled",
        termination_confirmed_at: null,
        quarantine_reason: null,
      },
      {
        id: "run-quarantined",
        actor_state: "quarantined",
        last_heartbeat_at: "2026-01-01T00:00:06.000Z",
        settlement_owner: "owner-2",
        settlement_reason: "stalled",
        termination_confirmed_at: null,
        quarantine_reason: "stop unconfirmed",
      },
      {
        id: "run-settled",
        actor_state: "settled",
        last_heartbeat_at: "2026-01-01T00:00:08.000Z",
        settlement_owner: "owner-3",
        settlement_reason: "completed",
        termination_confirmed_at: "2026-01-01T00:00:09.000Z",
        quarantine_reason: null,
      },
    ]);
  });

  it("backfills missing selection publications from the migration ledger", () => {
    db = openDb(":memory:");
    db.prepare("DELETE FROM schema_migrations WHERE version >= 13").run();
    const now = "2026-01-01T00:00:00.000Z";
    const manifest = parsePipelineManifest(readFileSync(
      join(process.cwd(), "src/__fixtures__/pipelines/command-fixture-v1.yaml"),
      "utf8"
    ));
    db.prepare(`
      INSERT INTO tickets (
        ticket_id, ticket_reference, session_id, branch, agent,
        repo, state, base_branch, created_at, updated_at
      ) VALUES (
        'issue-selection', 'OPE-SELECT', 'session-selection', 'ot/issue-selection',
        'codex', 'owner/repo', 'active', 'main', ?, ?
      )
    `).run(now, now);
    db.prepare(`
      INSERT INTO agent_sessions (
        id, ticket_id, generation, state, provider_conversation_id,
        created_at, updated_at
      ) VALUES (
        'session-selection', 'issue-selection', 1, 'current', NULL, ?, ?
      )
    `).run(now, now);
    db.prepare(`
      INSERT INTO pipeline_catalog_entries (
        pipeline_id, version, digest, normalized_manifest, accepted_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(manifest.manifest.id, manifest.manifest.version, manifest.digest, manifest.normalized, now);
    db.prepare(`
      INSERT INTO runtime_capability_descriptors (
        runtime_release, digest, protocol, normalized_descriptor, accepted_at
      ) VALUES ('runtime-v1', 'capability-digest', 'openthrottle-stage-request/v1', '{"capabilities":[]}', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO repository_config_snapshots (
        id, repository, base_commit, blob_sha, digest, normalized_config, created_at
      ) VALUES ('config-selection', 'owner/repo', ?, 'blob-selection', 'config-digest', '{}', ?)
    `).run("a".repeat(40), now);
    db.prepare(`
      INSERT INTO pipeline_instances (
        id, ticket_id, session_id, generation, pipeline_id, pipeline_version,
        manifest_digest, normalized_manifest, repository, base_commit,
        repository_config_snapshot_id, repository_config_digest, runtime_release,
        capability_digest, executor_protocol, authorized_capabilities, status,
        active_stage_id, wait_reason, created_at, updated_at, branch, agent,
        task_type, base_branch
      ) VALUES (
        'instance-selection', 'issue-selection', 'session-selection', 1,
        ?, ?, ?, ?,
        'owner/repo', ?, 'config-selection', 'config-digest', 'runtime-v1',
        'capability-digest', 'openthrottle-stage-request/v1', '[]',
        'dispatchable', NULL, NULL, ?, ?, 'ot/issue-selection', 'codex',
        'implement', 'main'
      )
    `).run(
      manifest.manifest.id,
      manifest.manifest.version,
      manifest.digest,
      manifest.normalized,
      "a".repeat(40),
      now,
      now
    );

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT kind FROM pipeline_publication_receipts
      WHERE pipeline_instance_id = 'instance-selection'
      ORDER BY kind
    `).all()).toEqual([
      { kind: "control_ledger" },
      { kind: "github_summary" },
    ]);
  });

  it("contracts satellite table data onto owner rows", () => {
    db = openDb(":memory:");
    db.prepare("DELETE FROM schema_migrations WHERE version >= 14").run();
    const now = "2026-01-01T00:00:00.000Z";
    db.prepare(`
      INSERT INTO tickets (
        ticket_id, ticket_reference, session_id, branch, agent,
        repo, state, base_branch, created_at, updated_at
      ) VALUES (
        'issue-contract', 'OPE-CONTRACT', 'session-contract', 'ot/issue-contract',
        'codex', 'owner/repo', 'active', 'main', ?, ?
      )
    `).run(now, now);
    db.prepare(`
      INSERT INTO agent_sessions (
        id, ticket_id, generation, state, provider_conversation_id,
        created_at, updated_at, execution_mode, pipeline_instance_id
      ) VALUES (
        'session-contract', 'issue-contract', 1, 'current', NULL, ?, ?,
        NULL, NULL
      )
    `).run(now, now);
    db.prepare(`
      INSERT INTO pipeline_catalog_entries (
        pipeline_id, version, digest, normalized_manifest, accepted_at
      ) VALUES ('fixture/command', 1, ?, '{}', ?)
    `).run("a".repeat(64), now);
    db.prepare(`
      INSERT INTO runtime_capability_descriptors (
        runtime_release, digest, protocol, normalized_descriptor, accepted_at
      ) VALUES ('runtime-v1', 'capability-digest', 'openthrottle-stage-request/v1', '{"capabilities":[]}', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO repository_config_snapshots (
        id, repository, base_commit, blob_sha, digest, normalized_config, created_at
      ) VALUES ('config-contract', 'owner/repo', ?, 'blob-contract', 'config-digest', '{}', ?)
    `).run("a".repeat(40), now);
    db.prepare(`
      INSERT INTO pipeline_instances (
        id, ticket_id, session_id, generation, pipeline_id, pipeline_version,
        manifest_digest, normalized_manifest, repository, base_commit,
        repository_config_snapshot_id, repository_config_digest, runtime_release,
        capability_digest, executor_protocol, authorized_capabilities, status,
        active_stage_id, wait_reason, created_at, updated_at, branch, agent,
        task_type, base_branch, runtime_provider, runtime_provider_resource_id,
        runtime_resource_status, runtime_resource_created_at, runtime_resource_updated_at
      ) VALUES (
        'instance-contract', 'issue-contract', 'session-contract', 1,
        'fixture/command', 1, ?, '{}',
        'owner/repo', ?, 'config-contract', 'config-digest', 'runtime-v1',
        'capability-digest', 'openthrottle-stage-request/v1', '[]',
        'dispatchable', NULL, NULL, ?, ?, 'ot/issue-contract', 'codex',
        'implement', 'main', NULL, NULL, NULL, NULL, NULL
      )
    `).run("a".repeat(64), "a".repeat(40), now, now);
    // Migration 49 drops the contracted satellites at the tail of the fresh
    // openDb above, so rebuild them in their pre-contraction (post-rename)
    // shape the way a legacy database would still carry them.
    db.exec(`
      CREATE TABLE session_executions (
        session_id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        execution_mode TEXT NOT NULL,
        pipeline_instance_id TEXT UNIQUE,
        pinned_at TEXT NOT NULL
      );
      CREATE TABLE pipeline_runtime_resources (
        pipeline_instance_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_resource_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO session_executions (
        session_id, ticket_id, generation, execution_mode,
        pipeline_instance_id, pinned_at
      ) VALUES (
        'session-contract', 'issue-contract', 1, 'pipeline', 'instance-contract', ?
      )
    `).run(now);
    db.prepare(`
      INSERT INTO pipeline_runtime_resources (
        pipeline_instance_id, provider, provider_resource_id, status, created_at, updated_at
      ) VALUES ('instance-contract', 'daytona', 'sandbox-contract', 'active', ?, ?)
    `).run(now, now);

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT execution_mode, pipeline_instance_id FROM agent_sessions WHERE id = 'session-contract'
    `).get()).toEqual({
      execution_mode: "pipeline",
      pipeline_instance_id: "instance-contract",
    });
    expect(db.prepare(`
      SELECT runtime_provider, runtime_provider_resource_id, runtime_resource_status
      FROM pipeline_instances WHERE id = 'instance-contract'
    `).get()).toEqual({
      runtime_provider: "daytona",
      runtime_provider_resource_id: "sandbox-contract",
      runtime_resource_status: "active",
    });
  });

  it("folds the authoritative attempt actor onto runs when run_liveness is stale", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    // Mark everything up to (and excluding) the satellite-table contraction as
    // applied so applyDatabaseMigrations runs only migration 14 against the
    // hand-built pre-contraction fixture below.
    for (const migration of databaseMigrations.slice(0, 13)) {
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE pipeline_instances (id TEXT PRIMARY KEY);
      CREATE TABLE run_liveness (
        run_id TEXT PRIMARY KEY, actor_state TEXT NOT NULL,
        last_heartbeat_at TEXT, settlement_owner TEXT, settlement_reason TEXT,
        termination_confirmed_at TEXT, quarantine_reason TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE pipeline_stage_attempts (
        id TEXT PRIMARY KEY, pipeline_instance_id TEXT, run_id TEXT, planned_run_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE pipeline_attempt_actors (
        attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, actor_state TEXT NOT NULL,
        last_heartbeat_at TEXT, settlement_owner TEXT, settlement_reason TEXT,
        termination_confirmed_at TEXT, quarantine_reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );

      -- Two pipeline-backed runs that existed when migration 9 ran and were
      -- later reaped / settled: the run store wrote those transitions to
      -- pipeline_attempt_actors and left run_liveness lagging at 'running'.
      INSERT INTO runs VALUES ('run-reaping', 'reaping', '2026-01-01T00:00:00.000Z', NULL);
      INSERT INTO runs VALUES (
        'run-settled', 'stopped', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:20.000Z'
      );
      -- A legacy run with no attempt actor: run_liveness is still authoritative.
      INSERT INTO runs VALUES ('run-legacy', 'quarantined', '2026-01-01T00:00:02.000Z', NULL);

      INSERT INTO run_liveness VALUES (
        'run-reaping', 'running', '2026-01-01T00:00:05.000Z', NULL, NULL, NULL, NULL,
        '2026-01-01T00:00:05.000Z'
      );
      INSERT INTO run_liveness VALUES (
        'run-settled', 'running', '2026-01-01T00:00:06.000Z', NULL, NULL, NULL, NULL,
        '2026-01-01T00:00:06.000Z'
      );
      INSERT INTO run_liveness VALUES (
        'run-legacy', 'quarantined', '2026-01-01T00:00:07.000Z', 'legacy-owner',
        'legacy stall', NULL, 'legacy quarantine', '2026-01-01T00:00:08.000Z'
      );

      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-reaping', NULL, 'run-reaping', 'run-reaping',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-settled', NULL, 'run-settled', 'run-settled',
        '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'
      );

      INSERT INTO pipeline_attempt_actors (
        attempt_id, run_id, actor_state, last_heartbeat_at, settlement_owner,
        settlement_reason, termination_confirmed_at, quarantine_reason, created_at, updated_at
      ) VALUES (
        'attempt-reaping', 'run-reaping', 'reaping', '2026-01-01T00:00:12.000Z', 'reaper-1',
        'stalled heartbeat', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:12.000Z'
      );
      INSERT INTO pipeline_attempt_actors (
        attempt_id, run_id, actor_state, last_heartbeat_at, settlement_owner,
        settlement_reason, termination_confirmed_at, quarantine_reason, created_at, updated_at
      ) VALUES (
        'attempt-settled', 'run-settled', 'settled', '2026-01-01T00:00:13.000Z', 'reaper-2',
        'operator stop', '2026-01-01T00:00:14.000Z', NULL,
        '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:14.000Z'
      );
    `);

    applyDatabaseMigrations(db);

    const ownerColumns = `actor_state, last_heartbeat_at, settlement_owner, settlement_reason,
      termination_confirmed_at, quarantine_reason`;
    const runOwner = (runId: string) =>
      db!.prepare(`SELECT ${ownerColumns} FROM runs WHERE id = ?`).get(runId);

    // The reaping run folds from the authoritative attempt actor, NOT the stale
    // 'running' run_liveness row. (The attempt-side mirror of the fold is
    // dropped by migration 50, so the run row is the only surviving owner.)
    expect(runOwner("run-reaping")).toEqual({
      actor_state: "reaping",
      last_heartbeat_at: "2026-01-01T00:00:12.000Z",
      settlement_owner: "reaper-1",
      settlement_reason: "stalled heartbeat",
      termination_confirmed_at: null,
      quarantine_reason: null,
    });

    // The settled run likewise folds the current settled/terminated state.
    expect(runOwner("run-settled")).toEqual({
      actor_state: "settled",
      last_heartbeat_at: "2026-01-01T00:00:13.000Z",
      settlement_owner: "reaper-2",
      settlement_reason: "operator stop",
      termination_confirmed_at: "2026-01-01T00:00:14.000Z",
      quarantine_reason: null,
    });

    // The legacy run keeps folding from run_liveness (fallback path intact).
    expect(runOwner("run-legacy")).toEqual({
      actor_state: "quarantined",
      last_heartbeat_at: "2026-01-01T00:00:07.000Z",
      settlement_owner: "legacy-owner",
      settlement_reason: "legacy stall",
      termination_confirmed_at: null,
      quarantine_reason: "legacy quarantine",
    });

    // A conditional finish-reaping settlement update on the folded actor_state
    // now matches, where the stale run_liveness fold would have made it miss.
    const settlement = db.prepare(`
      UPDATE runs
      SET actor_state = 'settled', termination_confirmed_at = ?
      WHERE id = ? AND actor_state = 'reaping' AND settlement_owner = ?
    `).run("2026-01-01T00:00:30.000Z", "run-reaping", "reaper-1");
    expect(settlement.changes).toBe(1);
    expect(
      db.prepare("SELECT actor_state FROM runs WHERE id = 'run-reaping'").get()
    ).toEqual({ actor_state: "settled" });
  });

  it("retires the contracted satellite tables and dead columns on fresh and legacy databases", () => {
    const deadTables = [
      "run_liveness",
      "session_executions",
      "pipeline_runtime_resources",
      "pipeline_attempt_actors",
      "migration_reconciliation",
      "work_item_sources",
    ];
    const tableNames = (database: Database.Database) =>
      (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>).map((row) => row.name);
    const columnNames = (database: Database.Database, table: string) =>
      (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((row) => row.name);
    const expectDeadSurfaceAbsent = (database: Database.Database) => {
      const names = tableNames(database);
      for (const table of deadTables) expect(names).not.toContain(table);
      expect(columnNames(database, "webhook_deliveries")).not.toContain("activity_id");
      expect(columnNames(database, "execution_graphs")).not.toContain("final_review_passed_at");
    };

    // Fresh path: base schema plus the full migration chain.
    db = openDb(":memory:");
    expectDeadSurfaceAbsent(db);
    expect(columnNames(db, "webhook_deliveries")).toContain("event_name");
    expect(columnNames(db, "execution_graphs")).toContain("stop_outcome");
    db.close();

    // Legacy path: a pre-migration-14 database (empty ledger, historical base
    // schema shapes) replays the entire chain, so the satellites are created,
    // backfilled, folded by migration 14, and finally dropped by migration 49.
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL);
      INSERT INTO runs VALUES ('legacy-running', 'running', '2026-01-01T00:00:00.000Z');
      CREATE TABLE webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        session_id TEXT,
        action TEXT NOT NULL,
        activity_id TEXT,
        event_name TEXT,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'processed',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        processed_at TEXT,
        last_error TEXT,
        redelivered_at TEXT,
        received_at TEXT NOT NULL
      );
      INSERT INTO webhook_deliveries (delivery_id, source, action, activity_id, received_at)
      VALUES ('legacy-delivery', 'linear', 'created', 'legacy-activity', '2026-01-01T00:00:00.000Z');
    `);

    applyDatabaseMigrations(db);

    expectDeadSurfaceAbsent(db);
    // The column drop rewrites the table without losing the retained rows.
    expect(db.prepare("SELECT delivery_id, source FROM webhook_deliveries").get()).toEqual({
      delivery_id: "legacy-delivery",
      source: "linear",
    });
  });

  it("merges divergent dual-written actor state onto runs before dropping the attempt mirror", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    // Stamp the full pre-consolidation ledger so applyDatabaseMigrations runs
    // only migration 50 against the hand-built v49-shaped dual-write fixture.
    for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 49)) {
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-08-14T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL,
        actor_state TEXT, last_heartbeat_at TEXT, settlement_owner TEXT,
        settlement_reason TEXT, termination_confirmed_at TEXT,
        quarantine_reason TEXT, actor_created_at TEXT, actor_updated_at TEXT
      );
      CREATE INDEX runs_actor_state_idx ON runs(actor_state, last_heartbeat_at);
      CREATE TABLE pipeline_stage_attempts (
        id TEXT PRIMARY KEY, run_id TEXT, planned_run_id TEXT,
        actor_state TEXT, last_heartbeat_at TEXT, settlement_owner TEXT,
        settlement_reason TEXT, termination_confirmed_at TEXT,
        quarantine_reason TEXT, actor_created_at TEXT, actor_updated_at TEXT
      );
      CREATE INDEX pipeline_stage_attempts_actor_state_idx
        ON pipeline_stage_attempts(actor_state, last_heartbeat_at);

      -- Divergent dual-write: the run row has NULL gaps the attempt mirror
      -- still carries (owner/reason/heartbeat), plus one column where both
      -- sides hold different values (quarantine_reason) so owner precedence
      -- is observable.
      INSERT INTO runs VALUES (
        'run-merged', 'reaping', '2026-01-01T00:00:00.000Z',
        'reaping', NULL, NULL, NULL, NULL, 'owner quarantine note',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:10.000Z'
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-merged', 'run-merged', 'run-merged',
        'running', '2026-01-01T00:00:05.000Z', 'reaper-legacy', 'stalled heartbeat',
        NULL, 'attempt quarantine note',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:05.000Z'
      );

      -- A planned-only attempt (crash before bindStageRun) whose run row never
      -- got any actor state: the merge adopts the attempt values wholesale.
      INSERT INTO runs VALUES (
        'run-planned', 'running', '2026-01-01T00:01:00.000Z',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-planned', NULL, 'run-planned',
        'running', '2026-01-01T00:01:30.000Z', NULL, NULL, NULL, NULL,
        '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:30.000Z'
      );

      -- An attempt-less direct run must pass through untouched.
      INSERT INTO runs VALUES (
        'run-direct', 'running', '2026-01-01T00:02:00.000Z',
        'running', '2026-01-01T00:02:30.000Z', NULL, NULL, NULL, NULL,
        '2026-01-01T00:02:00.000Z', '2026-01-01T00:02:30.000Z'
      );
    `);

    applyDatabaseMigrations(db);

    const v50 = databaseMigrations.find((migration) => migration.version === 50)!;
    expect(v50.name).toBe(`actor-state-single-owner${ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX}`);
    expect(db.prepare("SELECT version, name, checksum FROM schema_migrations WHERE version = 50").get())
      .toEqual({ version: 50, name: v50.name, checksum: v50.checksum });

    const columnNames = (table: string) =>
      (db!.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((row) => row.name);
    for (const column of [
      "actor_state", "last_heartbeat_at", "settlement_owner", "settlement_reason",
      "termination_confirmed_at", "quarantine_reason", "actor_created_at", "actor_updated_at",
    ]) {
      expect(columnNames("pipeline_stage_attempts")).not.toContain(column);
    }
    expect(columnNames("runs")).not.toContain("actor_created_at");
    expect(columnNames("runs")).not.toContain("actor_updated_at");
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'pipeline_stage_attempts_actor_state_idx'"
    ).get()).toBeUndefined();
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runs_actor_state_idx'"
    ).get()).toEqual({ name: "runs_actor_state_idx" });

    const owner = (runId: string) => db!.prepare(`
      SELECT actor_state, last_heartbeat_at, settlement_owner, settlement_reason,
        termination_confirmed_at, quarantine_reason
      FROM runs WHERE id = ?
    `).get(runId);
    // Per column COALESCE(owner, attempt): the run keeps its own reaping state
    // and quarantine note while adopting the mirror's owner/reason/heartbeat.
    expect(owner("run-merged")).toEqual({
      actor_state: "reaping",
      last_heartbeat_at: "2026-01-01T00:00:05.000Z",
      settlement_owner: "reaper-legacy",
      settlement_reason: "stalled heartbeat",
      termination_confirmed_at: null,
      quarantine_reason: "owner quarantine note",
    });
    expect(owner("run-planned")).toEqual({
      actor_state: "running",
      last_heartbeat_at: "2026-01-01T00:01:30.000Z",
      settlement_owner: null,
      settlement_reason: null,
      termination_confirmed_at: null,
      quarantine_reason: null,
    });
    expect(owner("run-direct")).toEqual({
      actor_state: "running",
      last_heartbeat_at: "2026-01-01T00:02:30.000Z",
      settlement_owner: null,
      settlement_reason: null,
      termination_confirmed_at: null,
      quarantine_reason: null,
    });
  });

  it("closes the execution_gate_receipts reason vocabulary and enforces it", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 25)) {
      migration.up(db);
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-08-08T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }
    const now = "2026-08-08T00:00:00.000Z";
    db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        linear_issue_id TEXT PRIMARY KEY,
        linear_issue_identifier TEXT NOT NULL,
        linear_session_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        agent TEXT NOT NULL,
        repo TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        linear_issue_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(id, linear_issue_id, generation)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        linear_issue_id TEXT NOT NULL,
        linear_session_id TEXT NOT NULL,
        session_generation INTEGER NOT NULL,
        task_type TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        expires_at TEXT
      );
      INSERT INTO tickets (
        linear_issue_id, linear_issue_identifier, linear_session_id, branch, agent,
        repo, base_branch, created_at, updated_at
      ) VALUES ('issue-1', 'OPE-1', 'session-1', 'ot/ope-1', 'codex', 'owner/repo', 'main', '${now}', '${now}');
      INSERT INTO agent_sessions (
        id, linear_issue_id, generation, state, created_at, updated_at
      ) VALUES ('session-1', 'issue-1', 1, 'current', '${now}', '${now}');
      INSERT INTO runs (
        id, linear_issue_id, linear_session_id, session_generation, task_type,
        token_hash, status, started_at, expires_at
      ) VALUES (
        'run-parent', 'issue-1', 'session-1', 1, 'implement', 'request-hash',
        'running', '${now}', '2026-08-08T01:00:00.000Z'
      );
      INSERT INTO repository_config_snapshots (
        id, repository, base_commit, blob_sha, digest, normalized_config, created_at
      ) VALUES ('config-1', 'owner/repo', '${"a".repeat(40)}', '${"b".repeat(40)}', '${"c".repeat(64)}', '{}', '${now}');
      INSERT INTO runtime_capability_descriptors (
        runtime_release, digest, protocol, normalized_descriptor, accepted_at
      ) VALUES ('runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '{}', '${now}');
      INSERT INTO pipeline_catalog_entries (
        pipeline_id, version, digest, normalized_manifest, accepted_at
      ) VALUES ('structured', 1, '${"e".repeat(64)}', '{}', '${now}');
      INSERT INTO pipeline_instances (
        id, linear_issue_id, linear_session_id, generation, pipeline_id, pipeline_version,
        manifest_digest, normalized_manifest, repository, base_commit, branch,
        repository_config_snapshot_id, repository_config_digest, runtime_release, capability_digest,
        executor_protocol, authorized_capabilities, status, active_stage_id, state_version,
        attempt_count, created_at, updated_at
      ) VALUES (
        'instance-1', 'issue-1', 'session-1', 1, 'structured', 1, '${"e".repeat(64)}',
        '{}', 'owner/repo', '${"a".repeat(40)}', 'ot/ope-1', 'config-1', '${"c".repeat(64)}',
        'runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '[]', 'running',
        'units', 1, 1, '${now}', '${now}'
      );
      INSERT INTO pipeline_instance_stages (
        pipeline_instance_id, stage_id, ordinal, status, attempt_count, created_at, updated_at
      ) VALUES ('instance-1', 'units', 1, 'running', 1, '${now}', '${now}');
      INSERT INTO pipeline_stage_attempts (
        id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
        request_hash, idempotency_key, context_revision, native_context_policy,
        planned_run_id, run_id, status, created_at, updated_at
      ) VALUES (
        'attempt-parent', 'instance-1', 'units', 1, 0, '${"f".repeat(64)}',
        'attempt-key', 0, 'none', 'run-parent', 'run-parent', 'running', '${now}', '${now}'
      );
      INSERT INTO execution_graphs (
        id, pipeline_instance_id, parent_attempt_id, parent_stage_id, parent_run_id,
        graph_digest, plan_digest, created_at, updated_at
      ) VALUES (
        'graph-1', 'instance-1', 'attempt-parent', 'units', 'run-parent',
        'graph-digest', 'plan-digest', '${now}', '${now}'
      );
      INSERT INTO execution_units (
        id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id,
        authored_order, dependency_unit_ids, status, active_work_attempt_id,
        created_at, updated_at
      ) VALUES (
        'unit-1', 'graph-1', 'instance-1', 'attempt-parent', 'a',
        0, '[]', 'completed', NULL, '${now}', '${now}'
      );
      INSERT INTO execution_work_attempts (
        id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id,
        parent_run_id, unit_id, attempt_ordinal, action_kind, idempotency_key,
        status, payload, created_at, updated_at
      ) VALUES (
        'action-1', 'graph-1', 'unit-1', 'instance-1', 'attempt-parent',
        'run-parent', 'a', 1, 'lead', 'action-key-1',
        'completed', '{}', '${now}', '${now}'
      );
    `);

    // Seeded under the pre-v26 schema, which has no CHECK on reason -- proves
    // an already-produced value survives the CHECK-adding rebuild.
    db.prepare(`
      INSERT INTO execution_gate_receipts (
        id, execution_graph_id, execution_unit_id, execution_work_attempt_id,
        parent_attempt_id, unit_id, gate_kind, evaluator_kind, subject, result,
        outcome, reason, artifact_hashes, payload, receipt_hash, created_at
      ) VALUES (
        'receipt-1', 'graph-1', 'unit-1', 'action-1', 'attempt-parent', 'a',
        'unit_acceptance', 'human', 'subject-1', 'passed', 'success',
        'lead_scope_match_accept', '[]', '{}', 'receipt-hash-1', '${now}'
      )
    `).run();

    applyDatabaseMigrations(db);

    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 26").get()).toEqual({ version: 26 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db.prepare("SELECT reason FROM execution_gate_receipts WHERE id = 'receipt-1'").get()
    ).toEqual({ reason: "lead_scope_match_accept" });

    const insertReceipt = (id: string, gateKind: string, reason: string) => db!.prepare(`
      INSERT INTO execution_gate_receipts (
        id, execution_graph_id, execution_unit_id, execution_work_attempt_id,
        parent_attempt_id, unit_id, gate_kind, evaluator_kind, subject, result,
        outcome, reason, artifact_hashes, payload, receipt_hash, created_at
      ) VALUES (?, 'graph-1', 'unit-1', 'action-1', 'attempt-parent', 'a',
        ?, 'human', 'subject-1', 'passed', 'success', ?, '[]', '{}', ?, '${now}')
    `).run(id, gateKind, reason, `receipt-hash-${id}`);

    expect(() => insertReceipt("receipt-bad", "final_review", "not_a_real_reason")).toThrow();
    insertReceipt("receipt-good", "integration", "executor_integrated_candidate");
    expect(
      db.prepare("SELECT reason FROM execution_gate_receipts WHERE id = 'receipt-good'").get()
    ).toEqual({ reason: "executor_integrated_candidate" });
  });

  it("closes orchestration_journal.kind by dropping the unproduced escalated_human value", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 25)) {
      migration.up(db);
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-08-08T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }
    const now = "2026-08-08T00:00:00.000Z";
    db.prepare(`
      INSERT INTO orchestration_journal (
        id, recorded_at, team, repository, issue, actor, kind, trigger, action, refs
      ) VALUES ('journal-1', ?, 'team', 'owner/repo', 'OPE-1', 'supervisor', 'run_note', 'trigger', 'action', '[]')
    `).run(now);

    applyDatabaseMigrations(db);

    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 27").get()).toEqual({ version: 27 });
    expect(
      db.prepare("SELECT kind FROM orchestration_journal WHERE id = 'journal-1'").get()
    ).toEqual({ kind: "run_note" });

    expect(() => db!.prepare(`
      INSERT INTO orchestration_journal (
        id, recorded_at, team, repository, issue, actor, kind, trigger, action, refs
      ) VALUES ('journal-2', ?, 'team', 'owner/repo', 'OPE-1', 'human', 'escalated_human', 'trigger', 'action', '[]')
    `).run(now)).toThrow();

    db.prepare(`
      INSERT INTO orchestration_journal (
        id, recorded_at, team, repository, issue, actor, kind, trigger, action, refs
      ) VALUES ('journal-3', ?, 'team', 'owner/repo', 'OPE-1', 'human', 'terminal_observed', 'trigger', 'action', '[]')
    `).run(now);
    expect(db.prepare("SELECT COUNT(*) AS count FROM orchestration_journal").get()).toEqual({ count: 2 });
  });

  // Shared by every "hand-maintained SQL CHECK(col IN (...)) vocabulary stays
  // in sync with its TS const array" test below -- one extraction regex
  // instead of a copy per table/column, generalized to also match a nullable
  // `col IS NULL OR col IN (...)` variant (needed for run_outcomes'
  // fault_attribution, the one nullable column among them).
  function checkConstraintValues(db: Database.Database, table: string, column: string): string[] {
    const row = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table) as { sql: string } | undefined;
    if (!row) throw new Error(`table ${table} was not found in sqlite_master`);
    const match = row.sql.match(new RegExp(
      `${column} TEXT(?: NOT NULL)? CHECK\\(\\s*(?:${column} IS NULL OR\\s*)?${column} IN \\(([\\s\\S]*?)\\)\\s*\\)`
    ));
    if (!match) throw new Error(`${table}.sql has no ${column} CHECK(${column} IN (...)) clause`);
    return match[1]!
      .split(",")
      .map((entry) => entry.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);
  }

  it("keeps the execution_gate_receipts reason CHECK constraint in sync with GATE_RECEIPT_REASONS", () => {
    db = new Database(":memory:");
    applyDatabaseMigrations(db);

    // The TS vocabulary (GATE_RECEIPT_REASONS) and the SQL CHECK constraint
    // are two hand-maintained lists with no shared source -- this proves they
    // stay in exact sync instead of only drifting apart at a live INSERT.
    const constraintReasons = checkConstraintValues(db, "execution_gate_receipts", "reason");
    expect(new Set(constraintReasons)).toEqual(new Set(GATE_RECEIPT_REASONS));
    expect(constraintReasons).toHaveLength(GATE_RECEIPT_REASONS.length);
  });

  it("creates the run_outcomes settlement rollup table", () => {
    db = new Database(":memory:");
    applyDatabaseMigrations(db);

    const table = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run_outcomes'
    `).get() as { sql: string } | undefined;
    if (!table) throw new Error("run_outcomes table was not created");
    expect(table.sql).toContain("pipeline_instance_id TEXT PRIMARY KEY");
    expect(table.sql).toMatch(/outcome TEXT NOT NULL CHECK\(outcome IN \(/);
    expect(table.sql).toMatch(/closed_reason TEXT NOT NULL CHECK\(closed_reason IN \(/);
    expect(table.sql).toMatch(/fault_attribution TEXT CHECK\(/);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 29").get()).toEqual({ version: 29 });
  });

  // The four hand-maintained CHECK vocabularies on run_outcomes (outcome,
  // closed_reason, engine, fault_attribution) each share no SQL-level source
  // with their TS vocabulary -- these prove they stay in exact sync instead
  // of only drifting apart at a live INSERT.
  it.each([
    ["outcome", PIPELINE_OUTCOMES],
    ["closed_reason", STAGE_OUTCOMES],
    ["engine", ENGINES],
    ["fault_attribution", FAULT_ATTRIBUTIONS],
  ] as const)("keeps the run_outcomes %s CHECK constraint in sync", (column, vocabulary) => {
    db = new Database(":memory:");
    applyDatabaseMigrations(db);
    const constraintValues = checkConstraintValues(db, "run_outcomes", column);
    expect(new Set(constraintValues)).toEqual(new Set(vocabulary));
    expect(constraintValues).toHaveLength(vocabulary.length);
  });
});
