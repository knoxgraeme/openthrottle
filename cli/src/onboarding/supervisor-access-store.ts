import { homedir } from "node:os";
import { join } from "node:path";
import { assertProfileName, atomicWriteJson } from "./profile-store.js";
import { readRestrictiveFile } from "./secret-store.js";

export const SUPERVISOR_ACCESS_SCHEMA = "openthrottle.supervisor-access/v1";

export interface SupervisorAccess {
  supervisorUrl: string;
  statusToken: string;
}

export interface SupervisorAccessReader {
  load(profileName: string): Promise<SupervisorAccess | undefined>;
}

export interface SupervisorAccessStore extends SupervisorAccessReader {
  save(profileName: string, access: SupervisorAccess): Promise<void>;
  pathFor(profileName: string): string;
}

interface SupervisorAccessDocument {
  schema: typeof SUPERVISOR_ACCESS_SCHEMA;
  profile: string;
  supervisor_url: string;
  status_token: string;
}

const DOCUMENT_FIELDS = new Set(["schema", "profile", "supervisor_url", "status_token"]);

export function defaultSupervisorAccessRoot(env = process.env): string {
  return env.OT_SUPERVISOR_ACCESS_DIR?.trim() ||
    join(homedir(), ".openthrottle", "supervisor-access");
}

export class LocalSupervisorAccessStore implements SupervisorAccessStore {
  constructor(private readonly root = defaultSupervisorAccessRoot()) {}

  async load(profileName: string): Promise<SupervisorAccess | undefined> {
    const path = this.pathFor(profileName);
    try {
      const document = validateDocument(
        JSON.parse(readRestrictiveFile(path, "supervisor access document")),
        profileName
      );
      return {
        supervisorUrl: document.supervisor_url,
        statusToken: document.status_token,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(profileName: string, access: SupervisorAccess): Promise<void> {
    const path = this.pathFor(profileName);
    const document = validateDocument({
      schema: SUPERVISOR_ACCESS_SCHEMA,
      profile: profileName,
      supervisor_url: access.supervisorUrl,
      status_token: access.statusToken,
    }, profileName);
    atomicWriteJson(path, document);
  }

  pathFor(profileName: string): string {
    assertProfileName(profileName);
    return join(this.root, `${profileName}.json`);
  }
}

function validateDocument(input: unknown, profileName: string): SupervisorAccessDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("supervisor access store must be a JSON object");
  }
  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value).find((key) => !DOCUMENT_FIELDS.has(key));
  if (unknown) throw new Error(`supervisor access store has unknown field ${unknown}`);
  if (value.schema !== SUPERVISOR_ACCESS_SCHEMA) {
    throw new Error("unsupported supervisor access store schema");
  }
  if (value.profile !== profileName) throw new Error("supervisor access store profile mismatch");
  if (typeof value.supervisor_url !== "string") {
    throw new Error("supervisor access URL is required");
  }
  assertHttpsOrigin(value.supervisor_url);
  if (typeof value.status_token !== "string" || !value.status_token.trim()) {
    throw new Error("supervisor access status token is required");
  }
  return {
    schema: SUPERVISOR_ACCESS_SCHEMA,
    profile: profileName,
    supervisor_url: value.supervisor_url,
    status_token: value.status_token,
  };
}

function assertHttpsOrigin(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("supervisor access URL must be an HTTPS origin");
  }
  if (url.protocol !== "https:" || value !== url.origin) {
    throw new Error("supervisor access URL must be an HTTPS origin");
  }
}
