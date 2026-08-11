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

  it("inspects status fields attached to Error instances", () => {
    const statusCodeError = Object.assign(new Error("request failed"), { statusCode: 502 });
    const responseStatusError = Object.assign(new Error("request failed"), { response: { status: 503 } });

    expect(serializeRuntimeObservationError("FileSystem.listFiles", statusCodeError))
      .toMatchObject({ retryable: true, statusCode: 502 });
    expect(serializeRuntimeObservationError("FileSystem.downloadFile", responseStatusError))
      .toMatchObject({ retryable: true, statusCode: 503 });
  });

  it("retries transient HTTP client statuses without retrying deterministic 4xx", () => {
    expect(serializeRuntimeObservationError("FileSystem.listFiles", { status: 408, message: "timeout" }))
      .toMatchObject({ retryable: true, statusCode: 408 });
    expect(serializeRuntimeObservationError("FileSystem.listFiles", { status: 429, message: "rate limited" }))
      .toMatchObject({ retryable: true, statusCode: 429 });
    expect(serializeRuntimeObservationError("FileSystem.listFiles", { status: 400, message: "bad request" }))
      .toMatchObject({ retryable: false, statusCode: 400 });
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

  it("retains bounded message head and tail diagnostics", () => {
    const result = serializeRuntimeObservationError("FileSystem.listFiles", new Error(
      `provider request failed ${"x".repeat(2_000)} Total memory limit exceeded`
    ));

    expect(result.message.length).toBeLessThanOrEqual(500);
    expect(result.message).toContain("provider request failed");
    expect(result.message).toContain("...[truncated]...");
    expect(result.message).toContain("Total memory limit exceeded");
    expect(result.text.length).toBeLessThanOrEqual(1_500);
  });

  it("classifies a retryable marker in the truncated diagnostic midpoint", () => {
    const result = serializeRuntimeObservationError("FileSystem.listFiles", new Error(
      `${"x".repeat(300)} timeout ${"y".repeat(2_000)}`
    ));

    expect(result.retryable).toBe(true);
    expect(result.message).toContain("...[truncated]...");
    expect(result.message).not.toContain("timeout");
    expect(result.message.length).toBeLessThanOrEqual(500);
  });

  it("classifies and retains a retryable marker at the tail of a nested safe cause", () => {
    const result = serializeRuntimeObservationError("FileSystem.listFiles", {
      message: "provider request failed",
      cause: { message: `${"x".repeat(2_000)} socket hang up` },
      body: "unsafe provider body",
    });

    expect(result.retryable).toBe(true);
    expect(result.cause).toContain("...[truncated]...");
    expect(result.cause).toContain("socket hang up");
    expect(result.cause!.length).toBeLessThanOrEqual(500);
    expect(result.text).not.toContain("unsafe provider body");
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
