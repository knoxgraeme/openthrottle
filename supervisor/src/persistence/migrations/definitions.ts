import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { applyBaseSchema, schema, SCHEMA_EPOCH } from "../schema.js";

export interface DatabaseMigration {
  version: number;
  name: string;
  source: string;
  checksum: string;
  up(db: Database.Database): void;
}

export const SCHEMA_EPOCH_CONTRACT = "openthrottle.schema-epoch/v1";
export const SCHEMA_BASELINE_NAME = "schema-epoch-1-baseline";

const baselineDefinition = {
  version: SCHEMA_EPOCH,
  name: SCHEMA_BASELINE_NAME,
  source: schema,
  up(db: Database.Database) {
    applyBaseSchema(db);
  },
};

export const databaseMigrations: readonly DatabaseMigration[] = Object.freeze([
  Object.freeze({
    ...baselineDefinition,
    checksum: createHash("sha256")
      .update(
        `${baselineDefinition.version}\0${baselineDefinition.name}\0${baselineDefinition.source}`
      )
      .digest("hex"),
  }),
]);
