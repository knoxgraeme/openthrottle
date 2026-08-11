import { describe, expect, it } from "vitest";
import { serializeRuntimeObservationError } from "./observation-error.js";

describe("serializeRuntimeObservationError", () => {
  it("classifies and serializes SDK object errors without [object Object]", () => {
    const error = {
      response: { status: 502, headers: { authorization: "Bearer secret-token" } },
      request: { body: "raw request body should not be logged" },
      message: "",
      cause: { message: "upstream returned an empty body" },
    };

    const result = serializeRuntimeObservationError("FileSystem.listFiles", error);

    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(502);
    expect(result.text).toContain("operation=FileSystem.listFiles");
    expect(result.text).toContain("retryable=true");
    expect(result.text).toContain("status=502");
    expect(result.text).toContain("cause=upstream returned an empty body");
    expect(result.text).not.toContain("[object Object]");
    expect(result.text).not.toContain("authorization");
    expect(result.text).not.toContain("raw request body");
    expect(result.text).not.toContain("secret-token");
  });

  it("keeps deterministic 4xx errors non-retryable", () => {
    const result = serializeRuntimeObservationError("FileSystem.downloadFile", {
      statusCode: 404,
      message: "not found",
    });

    expect(result.retryable).toBe(false);
    expect(result.text).toContain("retryable=false");
    expect(result.text).toContain("status=404");
  });

  it("handles circular values, redacts secrets, and bounds text", () => {
    const circular: Record<string, unknown> = {
      status: 503,
      message: `failed with Bearer secret-token ${"x".repeat(5_000)}`,
    };
    circular.self = circular;

    const result = serializeRuntimeObservationError("FileSystem.listFiles", circular);

    expect(result.retryable).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(1_500);
    expect(result.text).toContain("[REDACTED]");
    expect(result.text).not.toContain("secret-token");
  });

  it("classifies nested network causes as retryable without a status code", () => {
    const result = serializeRuntimeObservationError("FileSystem.listFiles", {
      message: "request failed",
      cause: { code: "ECONNRESET", message: "socket closed" },
    });

    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBeNull();
    expect(result.text).toContain("status=unknown");
    expect(result.text).toContain("cause=socket closed");
  });

  it("classifies timeout messages as retryable without treating all errors as retryable", () => {
    const timeout = serializeRuntimeObservationError("FileSystem.listFiles", new Error("Daytona collection timeout"));
    const malformed = serializeRuntimeObservationError("FileSystem.downloadFile", new Error("sealed result has invalid envelope"));

    expect(timeout.retryable).toBe(true);
    expect(malformed.retryable).toBe(false);
  });

  it("preserves classification when serialized text is wrapped in an Error", () => {
    const inner = serializeRuntimeObservationError("FileSystem.listFiles", {
      response: { status: 502 },
      message: "",
    });
    const outer = serializeRuntimeObservationError("poll sandbox events", new Error(inner.text));

    expect(outer.retryable).toBe(true);
    expect(outer.statusCode).toBe(502);
    expect(outer.text).toContain("retryable=true");
  });

  it("does not use provider body fields as safe messages", () => {
    const result = serializeRuntimeObservationError("FileSystem.listFiles", {
      status: 500,
      body: "provider payload must not be logged",
    });

    expect(result.retryable).toBe(true);
    expect(result.text).toContain("message=object error");
    expect(result.text).not.toContain("provider payload");
  });
});
