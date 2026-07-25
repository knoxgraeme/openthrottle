import type Database from "better-sqlite3";
import type {
  PipelineInstance,
  PipelineRuntimeResource,
  PipelineStore,
} from "../../pipeline/store.js";

export function createResourceStore(db: Database.Database, now: () => string): Pick<
  PipelineStore,
  "bindRuntimeResource" | "getRuntimeResource" | "setRuntimeResourceStatus"
> {
  const getInstanceStmt = db.prepare("SELECT * FROM pipeline_instances WHERE id = ?");

  return {
    bindRuntimeResource(instanceId, provider, providerResourceId) {
      const instance = getInstanceStmt.get(instanceId) as PipelineInstance | undefined;
      if (!instance) throw new Error(`unknown pipeline instance ${instanceId}`);
      const existing = db.prepare("SELECT * FROM pipeline_runtime_resources WHERE pipeline_instance_id = ?")
        .get(instanceId) as PipelineRuntimeResource | undefined;
      if (existing) {
        if (existing.provider !== provider || existing.provider_resource_id !== providerResourceId) {
          throw new Error(`pipeline instance ${instanceId} is already bound to a different runtime resource`);
        }
        return existing;
      }
      const timestamp = now();
      db.prepare(`
        INSERT INTO pipeline_runtime_resources (
          pipeline_instance_id, provider, provider_resource_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?)
      `).run(instanceId, provider, providerResourceId, timestamp, timestamp);
      return db.prepare("SELECT * FROM pipeline_runtime_resources WHERE pipeline_instance_id = ?")
        .get(instanceId) as PipelineRuntimeResource;
    },
    getRuntimeResource(instanceId) {
      return db.prepare("SELECT * FROM pipeline_runtime_resources WHERE pipeline_instance_id = ?")
        .get(instanceId) as PipelineRuntimeResource | undefined;
    },
    setRuntimeResourceStatus(instanceId, status) {
      const update = db.prepare(`
        UPDATE pipeline_runtime_resources SET status = ?, updated_at = ? WHERE pipeline_instance_id = ?
      `).run(status, now(), instanceId);
      if (update.changes !== 1) throw new Error(`pipeline instance ${instanceId} has no runtime resource`);
    },
  };
}
