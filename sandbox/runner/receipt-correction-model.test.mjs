import { describe, expect, it } from "vitest";
import { codexAccountId, requestHeaders } from "./receipt-correction-model.mjs";

describe("receipt correction model helper", () => {
  it("forwards the ChatGPT account binding from Codex auth", () => {
    const accountId = codexAccountId({
      tokens: {
        access_token: "access-token",
        account_id: "account-1",
      },
    });

    expect(accountId).toBe("account-1");
    expect(requestHeaders({ bearer: "access-token", accountId })).toMatchObject({
      "ChatGPT-Account-Id": "account-1",
    });
  });

  it("omits the ChatGPT account binding when Codex auth has no account id", () => {
    expect(codexAccountId({ tokens: { access_token: "access-token" } })).toBeNull();
    expect(requestHeaders({ bearer: "access-token" })).not.toHaveProperty("ChatGPT-Account-Id");
  });
});
