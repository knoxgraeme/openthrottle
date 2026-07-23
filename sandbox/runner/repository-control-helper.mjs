#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));

function signature(path) {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile()) {
      return { exists: true, type: "other", size: 0, digest: null, mode: metadata.mode & 0o777 };
    }
    const value = readFileSync(path);
    return {
      exists: true,
      type: "file",
      size: value.length,
      digest: createHash("sha256").update(value).digest("hex"),
      mode: metadata.mode & 0o777,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, type: null, size: 0, digest: null, mode: null };
    }
    throw error;
  }
}

function replace(path, encoded, mode) {
  rmSync(path, { recursive: true, force: true });
  if (encoded === null) return;
  const temporary = `${path}.ot-restore-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, Buffer.from(encoded, "base64"), { flag: "wx", mode: 0o600 });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (input.operation === "restore") {
  for (const path of input.operationPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  replace(input.headPath, input.head, input.headMode);
  replace(input.indexPath, input.index, input.indexMode);
}

process.stdout.write(JSON.stringify({
  head: signature(input.headPath),
  index: signature(input.indexPath),
  operationState: input.operationPaths.map((path) => signature(path)),
}));
